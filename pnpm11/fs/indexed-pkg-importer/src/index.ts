import assert from 'node:assert'
import { constants, existsSync, type Stats } from 'node:fs'
import path from 'node:path'
import util from 'node:util'

import { packageImportMethodLogger } from '@pnpm/core-loggers'
import fs from '@pnpm/fs.graceful-fs'
import { globalInfo, globalWarn } from '@pnpm/logger'
import type { FilesMap, ImportIndexedPackage, ImportOptions } from '@pnpm/store.controller-types'
import { fastPathTemp as pathTemp } from 'path-temp'
import { renameOverwriteSync } from 'rename-overwrite'

import { type Importer, type ImportFile, importIndexedDir } from './importIndexedDir.js'
import { isNativeBinary, removeQuarantine } from './removeQuarantine.js'

export { type FilesMap, type ImportIndexedPackage, type ImportOptions }

export type PackageImportMethod = 'auto' | 'hardlink' | 'copy' | 'clone' | 'clone-or-copy'

export function createIndexedPkgImporter (packageImportMethod?: PackageImportMethod): ImportIndexedPackage {
  const importPackage = createImportPackage(packageImportMethod)
  return importPackage
}

function createImportPackage (packageImportMethod?: PackageImportMethod): ImportIndexedPackage {
  // this works in the following way:
  // - hardlink: hardlink the packages, no fallback
  // - clone: clone the packages, no fallback
  // - auto: try to clone or hardlink the packages, if it fails, fallback to copy
  // - copy: copy the packages, do not try to link them first
  switch (packageImportMethod ?? 'auto') {
    case 'clone':
      packageImportMethodLogger.debug({ method: 'clone' })
      return createClonePkg()
    case 'hardlink':
      packageImportMethodLogger.debug({ method: 'hardlink' })
      return hardlinkPkg.bind(null, linkOrCopy)
    case 'auto': {
      return createAutoImporter()
    }
    case 'clone-or-copy':
      return createCloneOrCopyImporter()
    case 'copy':
      packageImportMethodLogger.debug({ method: 'copy' })
      return copyPkg
    default:
      throw new Error(`Unknown package import method ${packageImportMethod as string}`)
  }
}

function createAutoImporter (): ImportIndexedPackage {
  let auto = initialAuto

  return (to, opts) => auto(to, opts)

  function initialAuto (
    to: string,
    opts: ImportOptions
  ): string | undefined {
    // Android application sandboxes (including Termux) commonly reject
    // hardlinks/reflinks between the store and a project. Probing those
    // operations can leave a partial package behind and make pnpm appear
    // to stop. Use the atomic copy importer up front on Termux; users can
    // opt back into link probing with PNPM_TERMUX_LINK_MODE=auto.
    if (isTermux() && process.env.PNPM_TERMUX_LINK_MODE !== 'auto') {
      packageImportMethodLogger.debug({ method: 'copy', reason: 'termux' })
      globalInfo('Termux detected: using copy mode for package imports')
      auto = copyPkg
      return auto(to, opts)
    }
    // Although reflinks are supported on Windows Dev Drives,
    // they are 10x slower than hard links.
    // Hence, we prefer reflinks by default only on Linux and macOS.
    if (process.platform !== 'win32') {
      try {
        // Probe with the raw clone function (no ENOTSUP fallback).
        // On filesystems that do not support reflinks, this throws and we
        // fall through to hardlinks.
        if (!tryClonePkg(to, opts)) return undefined
        packageImportMethodLogger.debug({ method: 'clone' })
        auto = createClonePkg()
        return 'clone'
      } catch {
        // ignore
      }
    }
    try {
      if (!hardlinkPkg(fs.linkSync, to, opts)) return undefined
      packageImportMethodLogger.debug({ method: 'hardlink' })
      auto = hardlinkPkg.bind(null, linkOrCopy)
      return 'hardlink'
    } catch (err: unknown) {
      assert(util.types.isNativeError(err))
      if (isLinkUnsupportedError(err)) {
        globalWarn(err.message)
        globalInfo('Falling back to copying packages from store')
        packageImportMethodLogger.debug({ method: 'copy', reason: err.code })
        auto = copyPkg
        return auto(to, opts)
      }
      // We still choose hard linking that will fall back to copying in edge cases.
      packageImportMethodLogger.debug({ method: 'hardlink' })
      auto = hardlinkPkg.bind(null, linkOrCopy)
      return auto(to, opts)
    }
  }
}

function createCloneOrCopyImporter (): ImportIndexedPackage {
  let auto = initialAuto

  return (to, opts) => auto(to, opts)

  function initialAuto (
    to: string,
    opts: ImportOptions
  ): string | undefined {
    try {
      if (!tryClonePkg(to, opts)) return undefined
      packageImportMethodLogger.debug({ method: 'clone' })
      auto = createClonePkg()
      return 'clone'
    } catch {
      // ignore
    }
    packageImportMethodLogger.debug({ method: 'copy' })
    auto = copyPkg
    return auto(to, opts)
  }
}

type CloneFunction = (src: string, dest: string) => void

/**
 * Import a single package using a raw clone function (no ENOTSUP fallback).
 * Used by auto-mode to probe whether the filesystem supports cloning.
 */
function tryClonePkg (
  to: string,
  opts: ImportOptions
): 'clone' | undefined {
  if (opts.resolvedFrom !== 'store' || opts.force || !pkgExistsAtTargetDir(to, opts.filesMap)) {
    const clone = createCloneFunction()
    importIndexedDir({ importFile: clone, importFileAtomic: clone }, to, opts.filesMap, opts)
    removeQuarantineFromNativeBinaries(to, opts)
    return 'clone'
  }
  return undefined
}

/**
 * Creates a clone-based package importer. Reflinks are atomic, so clone can
 * serve as both importFile and importFileAtomic. Transient clone failures
 * fall back to regular copy.
 */
function createClonePkg (): ImportIndexedPackage {
  const clone = createCloneFunction()
  const withFallback = (fallback: CloneFunction): ImportFile => (src, dest) => {
    try {
      clone(src, dest)
    } catch (err: unknown) {
      if (util.types.isNativeError(err) && 'code' in err && err.code === 'ENOTSUP') {
        fallback(src, dest)
        return
      }
      throw err
    }
  }
  const importer: Importer = {
    importFile: withFallback(resilientCopyFileSync),
    importFileAtomic: withFallback(atomicCopyFileSync),
  }
  return (to: string, opts: ImportOptions) => {
    if (opts.resolvedFrom !== 'store' || opts.force || !pkgExistsAtTargetDir(to, opts.filesMap)) {
      importIndexedDir(importer, to, opts.filesMap, opts)
      removeQuarantineFromNativeBinaries(to, opts)
      return 'clone'
    }
    return undefined
  }
}

function pkgExistsAtTargetDir (targetDir: string, filesMap: FilesMap): boolean {
  return existsSync(path.join(targetDir, pickFileFromFilesMap(filesMap)))
}

function pickFileFromFilesMap (filesMap: FilesMap): string {
  // New packages always have a package.json (the worker synthesizes one if
  // the tarball/directory lacks it). The fallback handles old store entries.
  if (filesMap.has('package.json')) {
    return 'package.json'
  }
  if (filesMap.size === 0) {
    throw new Error('pickFileFromFilesMap cannot pick a file from an empty FilesMap')
  }
  return filesMap.keys().next().value!
}

let _cloneFunction: CloneFunction | undefined

function createCloneFunction (): CloneFunction {
  if (_cloneFunction) return _cloneFunction
  if (process.platform === 'darwin' || process.platform === 'win32') {
    // eslint-disable-next-line
    const { reflinkFileSync } = require('@reflink/reflink') as typeof import('@reflink/reflink')
    _cloneFunction = (fr, to) => {
      try {
        reflinkFileSync(fr, to)
      } catch (err: unknown) {
        if (!util.types.isNativeError(err) || !('code' in err) || err.code !== 'EEXIST') throw err
      }
    }
  } else {
    _cloneFunction = (src: string, dest: string) => {
      try {
        fs.copyFileSync(src, dest, constants.COPYFILE_FICLONE_FORCE)
      } catch (err: unknown) {
        if (!(util.types.isNativeError(err) && 'code' in err && err.code === 'EEXIST')) throw err
      }
    }
  }
  return _cloneFunction
}

function hardlinkPkg (
  importFile: ImportFile,
  to: string,
  opts: ImportOptions
): 'hardlink' | undefined {
  if (opts.force || shouldRelinkPkg(to, opts)) {
    importIndexedDir({ importFile, importFileAtomic: importFile }, to, opts.filesMap, opts)
    removeQuarantineFromNativeBinaries(to, opts)
    return 'hardlink'
  }
  return undefined
}

function shouldRelinkPkg (
  to: string,
  opts: ImportOptions
): boolean {
  if (opts.disableRelinkLocalDirDeps && opts.resolvedFrom === 'local-dir') {
    try {
      const files = fs.readdirSync(to)
      return files.length === 0 || files.length === 1 && files[0] === 'node_modules'
    } catch {
      return true
    }
  }
  return opts.resolvedFrom !== 'store' || !pkgLinkedToStore(opts.filesMap, to)
}

function isTermux (): boolean {
  return process.platform === 'android' || process.env.TERMUX_VERSION != null ||
    (process.env.PREFIX?.includes('/com.termux/') ?? false)
}

function isLinkUnsupportedError (err: NodeJS.ErrnoException): boolean {
  return err.code === 'EXDEV' || err.code === 'EPERM' || err.code === 'EACCES' ||
    err.code === 'ENOTSUP' || err.code === 'EOPNOTSUPP' || err.code === 'EINVAL' ||
    err.message.startsWith('EXDEV: cross-device link not permitted')
}

function linkOrCopy (existingPath: string, newPath: string): void {
  try {
    fs.linkSync(existingPath, newPath)
  } catch (err: unknown) {
    if (util.types.isNativeError(err) && 'code' in err && err.code === 'EEXIST') return
    resilientCopyFileSync(existingPath, newPath)
  }
}

function resilientCopyFileSync (src: string, dest: string): void {
  try {
    fs.copyFileSync(src, dest)
  } catch (err: unknown) {
    if (util.types.isNativeError(err) && 'code' in err && err.code === 'ENOTSUP') {
      const srcMode = fs.statSync(src).mode
      fs.writeFileSync(dest, fs.readFileSync(src), { mode: srcMode })
    } else {
      throw err
    }
  }
}

function pkgLinkedToStore (filesMap: FilesMap, linkedPkgDir: string): boolean {
  const filename = pickFileFromFilesMap(filesMap)
  const linkedFile = path.join(linkedPkgDir, filename)
  let stats0!: Stats
  try {
    stats0 = fs.statSync(linkedFile)
  } catch (err: unknown) {
    if (util.types.isNativeError(err) && 'code' in err && err.code === 'ENOENT') return false
  }
  const stats1 = fs.statSync(filesMap.get(filename)!)
  if (stats0.ino === stats1.ino) return true
  globalInfo(`Relinking ${linkedPkgDir} from the store`)
  return false
}

export function copyPkg (
  to: string,
  opts: ImportOptions
): 'copy' | undefined {
  if (opts.resolvedFrom !== 'store' || opts.force || !pkgExistsAtTargetDir(to, opts.filesMap)) {
    importIndexedDir({ importFile: resilientCopyFileSync, importFileAtomic: atomicCopyFileSync }, to, opts.filesMap, opts)
    removeQuarantineFromNativeBinaries(to, opts)
    return 'copy'
  }
  return undefined
}

function atomicCopyFileSync (src: string, dest: string): void {
  const tmp = pathTemp(dest)
  try {
    resilientCopyFileSync(src, tmp)
  } catch (err) {
    try {
      fs.unlinkSync(tmp)
    } catch {} // eslint-disable-line:no-empty
    throw err
  }
  renameOverwriteSync(tmp, dest)
}

function removeQuarantineFromNativeBinaries (to: string, opts: ImportOptions): void {
  if (process.platform !== 'darwin' || opts.resolvedFrom !== 'store') return
  const nativeBinaries: string[] = []
  for (const file of opts.filesMap.keys()) {
    if (isNativeBinary(file)) {
      nativeBinaries.push(path.join(to, file))
    }
  }
  removeQuarantine(nativeBinaries)
}
