import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
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

/** The registry npm resolved against; a dependency tarball from any other origin (a URL or
 *  tarball dependency) is refused, and plain http only for a loopback registry. */
async function registryOrigin(cwd: string): Promise<string> {
  const { stdout } = await exec(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['config', 'get', 'registry'], { cwd, timeout: 30_000 })
  const url = new URL(stdout.trim())
  if (url.protocol !== 'https:' && !isLoopbackHost(url.hostname)) throw new Error('the npm registry must use https')
  return url.origin
}
const isLoopbackHost = (host: string) => host === 'localhost' || host === '[::1]' || /^127(\.\d{1,3}){3}$/.test(host)
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

function contained(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\') && !isAbsolute(rel)
}
/** `node_modules/.bin` holds npm's command shims — symlinks a default `npm install` creates
 *  (M1, review 60da1c9e). They are never part of an extension, so a local folder's copy drops them. */
export const isBinLinkDir = (path: string) => basename(path) === '.bin' && basename(dirname(path)) === 'node_modules'
/** Reject links (including internal links), devices and FIFOs before copying or hashing.
 *  `skip` leaves matching paths out of the walk entirely (they must also be left out of the copy). */
export async function artifactIntegrity(root: string, skip: (path: string) => boolean = () => false): Promise<string> {
  const rootStat = await lstat(root)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('extension artifact must be a directory without symbolic links')
  const hash = createHash('sha512')
  let bytes = 0, files = 0
  async function visit(dir: string): Promise<void> {
    for (const name of (await readdir(dir)).sort()) {
      const path = join(dir, name)
      if (skip(path)) continue
      const stat = await lstat(path)
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new Error('extension artifact contains a symbolic link or special file')
      hash.update(JSON.stringify([relative(root, path), stat.isDirectory() ? 'directory' : 'file', stat.mode & 0o777]))
      if (stat.isDirectory()) await visit(path)
      else {
        bytes += stat.size
        if (++files > 100_000 || bytes > 512 * 1024 * 1024) throw new Error('extension artifact exceeds installation limits')
        hash.update(await readFile(path))
      }
    }
  }
  await visit(root)
  return `sha512-${hash.digest('base64')}`
}

export class ExtensionInstaller {
  private readonly prepared = new Map<string, PreparedInstall>()
  constructor(private readonly home = cezarHomeDir()) {}
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
        await artifactIntegrity(root, isBinLinkDir)
        await cp(root, artifactDir, { recursive: true, dereference: false, filter: path => !isBinLinkDir(path) })
        normalizedSource = root
      } else {
        const match = packageSource.exec(source)
        if (!match) throw new Error('only npm registry packages and local folders are supported')
        const name = match[1]!
        const npmDir = join(workspace, 'npm')
        await mkdir(npmDir)
        await writeFile(join(npmDir, 'package.json'), JSON.stringify({ name: 'cezar-extension-staging', version: '1.0.0', private: true }))
        await exec(process.platform === 'win32' ? 'npm.cmd' : 'npm', [
          'install', '--prefix', npmDir, '--ignore-scripts', '--bin-links=false', '--no-audit', '--no-fund', '--package-lock=true', '--save-exact', '--', source,
        ], { cwd: npmDir, timeout: 120_000, maxBuffer: 2 * 1024 * 1024, env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'npm_config_allow_scripts')), npm_config_ignore_scripts: 'true' } })
        const lock = JSON.parse(await readFile(join(npmDir, 'package-lock.json'), 'utf8')) as { packages: Record<string, { version?: string; integrity?: string; resolved?: string; hasInstallScript?: boolean; link?: boolean }> }
        const registry = await registryOrigin(npmDir)
        for (const [path, item] of Object.entries(lock.packages)) {
          if (!path) continue
          if (item.hasInstallScript) throw new Error('extension dependency requires unsupported lifecycle installation scripts')
          if (item.link || !item.integrity || !fromRegistry(item.resolved, registry)) throw new Error('extension dependencies must be integrity-pinned registry artifacts')
        }
        const item = lock.packages[`node_modules/${name}`]
        if (!item?.version || !item.integrity) throw new Error('npm did not resolve an exact extension artifact')
        npmVersion = item.version; packageIntegrity = item.integrity; dependencyLock = lock
        const root = join(npmDir, 'node_modules', name)
        await artifactIntegrity(join(npmDir, 'node_modules'))
        // Registry metadata can omit scripts that are present in the tarball.
        async function rejectInstallScripts(dir: string): Promise<void> {
          for (const entry of await readdir(dir, { withFileTypes: true })) {
            const path = join(dir, entry.name)
            if (entry.isDirectory()) await rejectInstallScripts(path)
            else if (entry.name === 'package.json') {
              const pkg = JSON.parse(await readFile(path, 'utf8')) as { scripts?: Record<string, unknown> }
              if (['preinstall', 'install', 'postinstall'].some(key => pkg.scripts?.[key])) {
                throw new Error('extension dependency requires unsupported lifecycle installation scripts')
              }
            }
          }
        }
        await rejectInstallScripts(join(npmDir, 'node_modules'))
        await cp(root, artifactDir, { recursive: true, dereference: false })
        await cp(join(npmDir, 'node_modules'), join(artifactDir, 'node_modules'), { recursive: true, dereference: false })
        await writeFile(join(artifactDir, '.cezar-package-lock.json'), JSON.stringify(lock, null, 2))
        normalizedSource = source
      }
      const manifest = await this.readManifest(artifactDir)
      if (!exactVersion.test(manifest.version)) throw new Error('extension version must be exact semver')
      if (npmVersion && npmVersion !== manifest.version) throw new Error('extension manifest version differs from npm artifact version')
      const entry = resolve(artifactDir, manifest.entry)
      if (!contained(artifactDir, entry) || !(await lstat(entry)).isFile()) throw new Error('extension entry must stay inside its installed directory')
      const integrity = await artifactIntegrity(artifactDir)
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
      if (await artifactIntegrity(prepared.artifactDir) !== prepared.integrity) throw new Error('extension artifact changed after preview')
      const target = join(parent, digest)
      await assertLifecyclePath(target, this.home)
      const exists = await lstat(target).catch(() => null)
      if (exists) {
        if (await artifactIntegrity(target) !== prepared.integrity) throw new Error('installed extension artifact integrity mismatch')
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
      if (!keep) { await rm(root, { recursive: true, force: true }); return }
      const kept = createHash('sha256').update(keep).digest('hex')
      for (const version of await readdir(root).catch(() => [] as string[])) {
        const dir = join(root, version)
        for (const entry of await readdir(dir).catch(() => [] as string[])) if (entry !== kept && entry !== `${kept}.json`) await rm(join(dir, entry), { recursive: true, force: true })
        if ((await readdir(dir).catch(() => [])).length === 0) await rm(dir, { recursive: true, force: true })
      }
    })
  }
  async discardInstall(input: PreparedInstall): Promise<void> {
    const prepared = this.prepared.get(input.artifactDir)
    if (!prepared) return
    this.prepared.delete(input.artifactDir)
    await rm(resolve(prepared.artifactDir, '..'), { recursive: true, force: true })
  }
  private async readManifest(root: string): Promise<ExtensionManifest> {
    for (const name of ['cezar-extension.json', 'extension.json']) {
      try { return extensionManifestSchema.parse(JSON.parse(await readFile(join(root, name), 'utf8'))) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    return extensionManifestSchema.parse((JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { cezarExtension?: unknown }).cezarExtension)
  }
}
