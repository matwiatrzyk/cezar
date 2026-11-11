import { downloadRegistryArtifact } from './install-network.ts'
export { downloadRegistryArtifact } from './install-network.ts'
import { installRegistry, registryUrl, type Registries } from './install-registry.ts'
import { copyArtifact, InstallBudget, INSTALL_LIMITS, limitsError, readRegular, MANIFEST_BYTES, type InstallLimits } from './install-files.ts'
export { INSTALL_LIMITS, type InstallLimits } from './install-files.ts'
import { artifactPinned } from './artifact-leases.ts'
import { lstat, mkdir, mkdtemp, readdir, opendir, realpath, rename, rm, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFile, type ExecFileOptions } from 'node:child_process'
import { promisify } from 'node:util'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { extensionManifestSchema, type ExtensionManifest } from '@open-mercato/cezar-contract'
import { cezarHomeDir } from '../paths.ts'
import { assertLifecyclePath, atomicLifecycleWrite, withLifecycleFileLock } from '../worktree-lifecycle/store.ts'

const exec = promisify(execFile)
const exactVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const packageSource = /^(@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)(?:@([a-zA-Z0-9*^~<>=| .+-]+))?$/
export type PreparedInstall = {
  id: string; source: string; artifactDir: string; manifest: ExtensionManifest
  integrity: string; resolvedVersion: string; packageIntegrity?: string; dependencyLock?: unknown
}
export type InstalledExtension = Omit<PreparedInstall, 'artifactDir'> & { path: string }

/** npm only reads user configuration; it never receives a package or dependency specifier.
 *  Only registry keys are kept: `config list` may carry other user settings. */
async function npmRegistryConfig(cwd: string): Promise<{ offline: boolean; registries: Registries }> {
  const list = (json: boolean) => exec(process.platform === 'win32' ? 'npm.cmd' : 'npm', [
    'config', 'list', ...(json ? ['--json'] : []), '--cache', join(cwd, '.config-cache'), '--update-notifier=false', '--logs-max=0', '--ignore-scripts=true',
  ], { cwd, timeout: 30_000, maxBuffer: 1024 * 1024 })
  // `--json` silently OMITS keys whose value npm's redactor deems secret; the text listing still
  // names them (overridden ones commented out). Only key names are read from it, never values.
  const [{ stdout }, { stdout: text }] = await Promise.all([list(true), list(false)])
  const config = JSON.parse(stdout) as Record<string, unknown>
  const scopes: Record<string, string> = {}
  for (const [key, value] of Object.entries(config)) {
    const scope = /^(@[^\s:=]+):registry$/.exec(key)?.[1]
    if (scope && typeof value === 'string' && !value.includes('***')) scopes[scope] = value
  }
  const hidden = new Set<string>()
  let registryHidden = false
  for (const line of text.split(/\r?\n/)) {
    const key = /^(?:;\s*)?(\S+?)\s*=/.exec(line)?.[1]
    const scope = key && /^(@[^\s:=]+):registry$/.exec(key)?.[1]
    if (scope && !Object.hasOwn(scopes, scope)) hidden.add(scope)
    if (key === 'registry' && typeof config.registry !== 'string') registryHidden = true
  }
  if (registryHidden) throw new Error('the npm registry URL embeds credentials; configure a registry URL without them')
  if (typeof config.registry !== 'string') throw new Error('the npm registry is not configured')
  return { offline: config.offline === true || config.offline === 'true', registries: { registry: registryUrl(config.registry), scopes, hidden: [...hidden] } }
}
/** A source that reads as an npm package name is always the package; a same-named folder in
 *  the repository never shadows it. Folders need a path (`./x`, `/abs`, `dir/sub`). */
export function isPackageSource(source: string): boolean {
  return packageSource.test(source) && !source.startsWith('.')
}
/** Where an artifact comes from: the npm package name, or the folder's path. Consent is bound to
 *  it, so a same-id artifact from elsewhere is never covered by an earlier approval (M2). */
export function sourceIdentity(source: string): string {
  return isPackageSource(source) ? `npm:${packageSource.exec(source)![1]}` : `folder:${source}`
}
export function fromRegistry(resolved: string | undefined, origin: string): boolean {
  if (!resolved) return false
  try { return new URL(resolved).origin === origin } catch { return false }
}

type LockPackage = { version?: string; integrity?: string; resolved?: string; hasInstallScript?: boolean; link?: boolean }
type NpmLock = { packages: Record<string, LockPackage> }

/** Validate a recorded dependency plan (the installer resolves metadata without npm). */
export function assertSafeDependencyLock(lock: NpmLock, origin: string): void {
  for (const [path, item] of Object.entries(lock.packages)) {
    if (!path) continue
    if (item.hasInstallScript) throw new Error('extension dependency requires unsupported lifecycle installation scripts')
    if (item.link || !item.integrity || !fromRegistry(item.resolved, origin)) {
      throw new Error('extension dependencies must be integrity-pinned registry artifacts')
    }
  }
}

function contained(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\') && !isAbsolute(rel)
}
/** `node_modules/.bin` holds npm's command shims — symlinks a default `npm install` creates
 *  (M1, review 60da1c9e). They are never part of an extension, so a local folder's copy drops them. */
export const isBinLinkDir = (path: string) => basename(path) === '.bin' && basename(dirname(path)) === 'node_modules'

/** A stat-only walk that stops at the first file over the caps, before anything is read, hashed
 *  or copied (S3, review 834fb20c). `racing` tolerates entries vanishing under a running npm. */
export async function assertWithinLimits(root: string, limits: InstallLimits = INSTALL_LIMITS, options: { skip?: (path: string) => boolean; racing?: boolean } = {}): Promise<void> {
  const budget = new InstallBudget(limits)
  const gone = (error: unknown) => options.racing && (error as NodeJS.ErrnoException).code === 'ENOENT'
  async function visit(dir: string, depth = 0): Promise<void> {
    let entries
    try { entries = await opendir(dir) } catch (error) { if (gone(error)) return; throw error }
    for await (const entry of entries) {
      const path = join(dir, entry.name)
      if (options.skip?.(path)) continue
      let info
      try { info = await lstat(path) } catch (error) { if (gone(error)) continue; throw error }
      budget.entry(depth + 1)
      if (info.isDirectory()) await visit(path, depth + 1)
      else budget.data(info.size)
    }
  }
  await visit(root)
}

/** Run a command that writes into `root`, killing it as soon as `root` outgrows the caps (S2). */
export async function execWithinLimits(command: string, args: readonly string[], options: ExecFileOptions & { cwd: string }, root: string, limits: InstallLimits = INSTALL_LIMITS, pollMs = 250): Promise<void> {
  const controller = new AbortController()
  let violation: Error | undefined
  let done = false
  const watch = (async () => {
    while (!done) {
      await new Promise(resolve => setTimeout(resolve, pollMs))
      if (done) return
      try { await assertWithinLimits(root, limits, { racing: true }) } catch (error) {
        violation = error instanceof Error ? error : limitsError()
        controller.abort()
        return
      }
    }
  })()
  try {
    await exec(command, [...args], { ...options, signal: controller.signal })
  } catch (error) {
    throw violation ?? error
  } finally {
    done = true
    await watch
  }
}

/** Reject links (including internal links), devices and FIFOs before copying or hashing.
 *  `skip` leaves matching paths out of the walk entirely (they must also be left out of the copy). */
export async function artifactIntegrity(root: string, skip: (path: string) => boolean = () => false, limits: InstallLimits = INSTALL_LIMITS): Promise<string> {
  const rootStat = await lstat(root)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('extension artifact must be a directory without symbolic links')
  const hash = createHash('sha512')
  const budget = new InstallBudget(limits)
  async function visit(dir: string, depth = 0): Promise<void> {
    const names: string[] = []
    for await (const entry of await opendir(dir)) {
      if (skip(join(dir, entry.name))) continue
      budget.entry(depth + 1)
      names.push(entry.name)
    }
    for (const name of names.sort()) {
      const path = join(dir, name)
      if (skip(path)) continue
      const stat = await lstat(path)
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new Error('extension artifact contains a symbolic link or special file')
      hash.update(JSON.stringify([relative(root, path), stat.isDirectory() ? 'directory' : 'file', stat.mode & 0o777]))
      if (stat.isDirectory()) await visit(path, depth + 1)
      else {
        const contents = await readRegular(path, limits.bytes - budget.bytes)
        budget.data(contents.length)
        hash.update(contents)
      }
    }
  }
  await visit(root)
  return `sha512-${hash.digest('base64')}`
}

export class ExtensionInstaller {
  private readonly prepared = new Map<string, PreparedInstall>()
  constructor(private readonly home = cezarHomeDir(), private readonly limits: InstallLimits = INSTALL_LIMITS) {}
  private async directory(path: string): Promise<void> {
    await mkdir(this.home, { recursive: true, mode: 0o700 })
    await assertLifecyclePath(path, this.home)
    await mkdir(path, { recursive: true, mode: 0o700 })
  }
  async prepareInstall(source: string): Promise<PreparedInstall> {
    const staging = join(this.home, 'extensions', '.staging')
    await this.directory(staging)
    await this.sweepStaging(staging)
    const workspace = await mkdtemp(join(staging, 'install-'))
    const artifactDir = join(workspace, 'artifact')
    try {
      const local = isPackageSource(source) ? null : await lstat(resolve(source)).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      })
      let normalizedSource = source, packageIntegrity: string | undefined, dependencyLock: unknown
      let npmVersion: string | undefined
      if (local) {
        const root = await realpath(source)
        if (!(await lstat(root)).isDirectory()) throw new Error('extension source must be a directory or npm package')
        if (contained(root, workspace)) throw new Error('extension source contains the staging directory')
        // Manifest first, then a stat-only bounded walk: an arbitrary directory fails fast (S3).
        await this.readManifest(root)
        await assertWithinLimits(root, this.limits, { skip: isBinLinkDir })
        await artifactIntegrity(root, isBinLinkDir, this.limits)
        await copyArtifact(root, artifactDir, new InstallBudget(this.limits), isBinLinkDir)
        normalizedSource = root
      } else {
        const match = packageSource.exec(source)
        if (!match) throw new Error('only npm registry packages and local folders are supported')
        const name = match[1]!
        const npmDir = join(workspace, 'npm')
        await mkdir(npmDir)
        const { offline, registries } = await npmRegistryConfig(npmDir)
        if (offline) throw new Error('extension registry installation is unavailable offline; use a local folder')
        const resolved = await installRegistry(name, match[2] || 'latest', registries, npmDir, artifactDir, this.limits, downloadRegistryArtifact)
        npmVersion = resolved.version; packageIntegrity = resolved.integrity; dependencyLock = resolved.lock
        normalizedSource = source
      }
      const manifest = await this.readManifest(artifactDir)
      if (!exactVersion.test(manifest.version)) throw new Error('extension version must be exact semver')
      if (npmVersion && npmVersion !== manifest.version) throw new Error('extension manifest version differs from npm artifact version')
      const entry = resolve(artifactDir, manifest.entry)
      if (!contained(artifactDir, entry) || !(await lstat(entry)).isFile()) throw new Error('extension entry must stay inside its installed directory')
      const integrity = await artifactIntegrity(artifactDir, undefined, this.limits)
      const result: PreparedInstall = { id: manifest.id, source: normalizedSource, artifactDir, manifest, integrity, resolvedVersion: manifest.version, ...(packageIntegrity ? { packageIntegrity, dependencyLock } : {}) }
      this.prepared.set(artifactDir, structuredClone(result))
      return result
    } catch (error) { await rm(workspace, { recursive: true, force: true }); throw error }
  }
  async commitInstall(input: PreparedInstall): Promise<InstalledExtension> {
    const prepared = this.prepared.get(input.artifactDir)
    if (!prepared) throw new Error('extension install preview expired')
    const digest = createHash('sha256').update(prepared.integrity).digest('hex')
    const parent = join(this.home, 'extensions', 'artifacts', prepared.id, prepared.manifest.version)
    await this.directory(parent)
    return withLifecycleFileLock(join(this.home, 'extensions', '.install.lock'), async () => {
      if (await artifactIntegrity(prepared.artifactDir, undefined, this.limits) !== prepared.integrity) throw new Error('extension artifact changed after preview')
      const target = join(parent, digest)
      await assertLifecyclePath(target, this.home)
      const exists = await lstat(target).catch(() => null)
      if (exists) {
        if (await artifactIntegrity(target, undefined, this.limits) !== prepared.integrity) throw new Error('installed extension artifact integrity mismatch')
      } else await rename(prepared.artifactDir, target)
      const { artifactDir: _, ...metadata } = prepared
      const installed = { ...metadata, path: target }
      await assertLifecyclePath(`${target}.json`, this.home)
      await atomicLifecycleWrite(`${target}.json`, installed)
      await this.discardInstall(input)
      return installed
    })
  }
  /** Previews expire after ten minutes; anything an interrupted process left behind for an hour goes. */
  private async sweepStaging(staging: string, maxAgeMs = 60 * 60_000): Promise<void> {
    for (const name of await readdir(staging).catch(() => [] as string[])) {
      if (!name.startsWith('install-')) continue
      const path = join(staging, name)
      const info = await stat(path).catch(() => null)
      if (info && Date.now() - info.mtimeMs > maxAgeMs && ![...this.prepared.keys()].some(dir => contained(path, dir))) await rm(path, { recursive: true, force: true })
    }
  }
  /** Deletes every stored artifact of `id` except the one with integrity `keep` (none: all of them). */
  async pruneArtifacts(id: string, keep?: string): Promise<void> {
    const root = join(this.home, 'extensions', 'artifacts', id)
    await assertLifecyclePath(root, this.home)
    await withLifecycleFileLock(join(this.home, 'extensions', '.install.lock'), async () => {
      const kept = keep ? createHash('sha256').update(keep).digest('hex') : undefined
      for (const version of await readdir(root).catch(() => [] as string[])) {
        const dir = join(root, version)
        for (const entry of await readdir(dir).catch(() => [] as string[])) {
          const digest = entry.endsWith('.json') ? entry.slice(0,-5) : entry
          if (digest !== kept && !await artifactPinned(this.home,id,digest)) await rm(join(dir, entry), { recursive: true, force: true })
        }
        if ((await readdir(dir).catch(() => [])).length === 0) await rm(dir, { recursive: true, force: true })
      }
      if ((await readdir(root).catch(() => [])).length === 0) await rm(root, {recursive:true,force:true})
    })
  }
  async discardInstall(input: PreparedInstall): Promise<void> {
    const prepared = this.prepared.get(input.artifactDir)
    if (!prepared) return
    this.prepared.delete(input.artifactDir)
    await rm(resolve(prepared.artifactDir, '..'), { recursive: true, force: true })
  }
  private async readManifest(root: string): Promise<ExtensionManifest> {
    let raw: Buffer
    try { raw = await readRegular(join(root, 'cezar-extension.json'), Math.min(MANIFEST_BYTES, this.limits.bytes)) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('extension source has no manifest (cezar-extension.json)')
      throw error
    }
    return extensionManifestSchema.parse(JSON.parse(raw.toString('utf8')))
  }
}
