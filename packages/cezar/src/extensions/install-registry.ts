import { createReadStream } from 'node:fs'
import { RegistryResponseError } from './install-network.ts'
import { mkdir, readFile, rm, writeFile, opendir, rename, lstat, stat } from 'node:fs/promises'
import { createHash, timingSafeEqual } from 'node:crypto'
import { join } from 'node:path'
import semver from 'semver'
import { extractRegistryArchive } from './install-archive.ts'
import { copyArtifact, InstallBudget, MANIFEST_BYTES, readRegular, type InstallLimits } from './install-files.ts'

type Package = {
  name: string; version: string; dist: { tarball: string; integrity: string }
  dependencies?: Record<string, string>; optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>; peerDependenciesMeta?: Record<string, { optional?: boolean }>
  scripts?: Record<string, string>; os?: string[]; cpu?: string[]
}
type Metadata = { versions: Record<string, Package>; 'dist-tags'?: Record<string, string> }
type Node = { name: string; pkg: Package; children: Map<string, Node> }
type Download = (url: string, origin: string, destination: string, maxBytes: number, signal?: AbortSignal) => Promise<void>
const packageName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/
const tag = /^[a-zA-Z][a-zA-Z0-9._-]*$/
function spec(name: string, range: string): { name: string; range: string } {
  if (name.length > 214 || !packageName.test(name) || typeof range !== 'string' || range.length > 1024) throw new Error('unsupported extension dependency name or specifier')
  if (range.startsWith('npm:')) {
    const match = /^(?:(@[^/]+\/[^@]+)|([^@]+))(?:@(.*))?$/.exec(range.slice(4))
    if (!match || match[3]?.startsWith('npm:')) throw new Error('unsupported extension dependency alias')
    return spec(match[1] ?? match[2]!, match[3] || '*')
  }
  if (!semver.validRange(range) && !tag.test(range)) throw new Error('extension dependencies must be integrity-pinned registry artifacts (registry versions only)')
  return { name, range }
}
function lifecycle(pkg: { scripts?: Record<string, unknown> }) {
  if (['preinstall', 'install', 'postinstall'].some(key => pkg.scripts?.[key])) throw new Error('extension dependency requires unsupported lifecycle installation scripts')
}
function integrityTokens(value: string): { algorithm: string; digest: Buffer }[] {
  if (typeof value !== 'string') throw new Error('extension dependency has no supported integrity')
  const tokens = value.split(/\s+/).flatMap(token => {
    const match = /^(sha512|sha384|sha256|sha1)-([A-Za-z0-9+/]+={0,2})$/.exec(token)
    if (!match) return []
    const digest = Buffer.from(match[2]!, 'base64')
    return digest.length === { sha512: 64, sha384: 48, sha256: 32, sha1: 20 }[match[1]!] ? [{ algorithm: match[1]!, digest }] : []
  })
  if (!tokens.length) throw new Error('extension dependency has no supported integrity')
  const strongest = ['sha512', 'sha384', 'sha256', 'sha1'].find(algorithm => tokens.some(token => token.algorithm === algorithm))!
  return tokens.filter(token => token.algorithm === strongest)
}
function compatible(values: string[] | undefined, value: string): boolean {
  return !values || (!values.includes(`!${value}`) && (!values.some(item => !item.startsWith('!')) || values.includes(value) || values.includes('any')))
}
/** Resolve only JSON metadata through the same origin/redirect/byte gate as archives. npm never
 * sees dependency specifiers and never performs network IO or writes an ambient cache. */
export async function installRegistry(sourceName: string, range: string, registry: string, workspace: string, artifact: string, limits: InstallLimits, download: Download) {
  const signal = AbortSignal.timeout(120_000)
  const origin = new URL(registry).origin
  const metadata = new Map<string, Metadata>()
  const network = new InstallBudget(limits)
  const planBudget = new InstallBudget(limits)
  const scratch = join(workspace, 'registry-download')
  await mkdir(scratch)
  let serial = 0
  async function fetchFile(url: string, cap: number): Promise<string> {
    const path = join(scratch, `${serial++}`)
    signal.throwIfAborted()
    await download(url, origin, path, Math.min(cap, limits.bytes - network.bytes), signal)
    network.data((await stat(path)).size)
    return path
  }
  async function get(name: string): Promise<Metadata> {
    const cached = metadata.get(name)
    if (cached) return cached
    network.entry(1)
    const path = await fetchFile(new URL(encodeURIComponent(name), registry.endsWith('/') ? registry : `${registry}/`).href, 16 * 1024 * 1024)
    const value = JSON.parse(await readFile(path, 'utf8')) as Metadata
    await rm(path)
    if (!value || typeof value.versions !== 'object' || !value.versions) throw new Error('invalid extension registry metadata')
    metadata.set(name, value)
    return value
  }
  async function resolve(name: string, range: string, ancestors: Map<string, Package>, depth: number, optional = false): Promise<Node | undefined> {
    signal.throwIfAborted()
    planBudget.entry(depth)
    const request = spec(name, range)
    let meta: Metadata
    try { meta = await get(request.name) } catch (error) {
      if (optional && error instanceof RegistryResponseError && error.status === 404) return undefined
      throw error
    }
    const version = meta['dist-tags']?.[request.range] ?? semver.maxSatisfying(Object.keys(meta.versions), request.range)
    const pkg = version ? meta.versions[version] : undefined
    if (!pkg) {
      if (optional) return undefined
      throw new Error(`no registry version satisfies extension dependency ${name}@${range}`)
    }
    if (pkg.name !== request.name || pkg.version !== version || !semver.valid(pkg.version)) throw new Error('invalid extension registry package identity')
    lifecycle(pkg)
    const url = new URL(pkg.dist?.tarball)
    if (url.origin !== origin || url.username || url.password) throw new Error('extension dependencies must be integrity-pinned registry artifacts')
    integrityTokens(pkg.dist?.integrity)
    const deps = { ...pkg.dependencies, ...pkg.optionalDependencies }
    // Validate every production specifier BEFORE following even the first dependency.
    for (const [child, requested] of Object.entries({ ...pkg.peerDependencies, ...deps })) spec(child, requested)
    if (!compatible(pkg.os, process.platform) || !compatible(pkg.cpu, process.arch)) {
      if (optional) return undefined
      throw new Error('extension dependency is not supported on this platform')
    }
    const node: Node = { name, pkg, children: new Map() }
    const chain = new Map(ancestors).set(name, pkg)
    for (const [child, requested] of Object.entries(deps)) {
      const parsed = spec(child, requested), ancestor = chain.get(child)
      if (ancestor?.name === parsed.name && (ancestor.version === parsed.range || semver.satisfies(ancestor.version, parsed.range) || metadata.get(parsed.name)?.['dist-tags']?.[parsed.range] === ancestor.version)) continue
      const resolved = await resolve(child, requested, chain, depth + 1, Object.hasOwn(pkg.optionalDependencies ?? {}, child))
      if (resolved) node.children.set(child, resolved)
    }
    return node
  }
  const root = (await resolve(sourceName, range, new Map(), 1))!
  const matches = (pkg: Package, name: string, range: string): boolean => {
    const parsed = spec(name, range)
    return pkg.name === parsed.name && (semver.satisfies(pkg.version, parsed.range) || metadata.get(parsed.name)?.['dist-tags']?.[parsed.range] === pkg.version)
  }
  // Peers must share the consumer's instance. Installing a private peer inside each child
  // breaks packages such as React plugins even when every requested version is satisfied.
  async function peers(node: Node, scopes: Node[], depth: number): Promise<void> {
    signal.throwIfAborted()
    for (const [name, range] of Object.entries(node.pkg.peerDependencies ?? {})) {
      let provider = node.children.get(name)?.pkg
      for (const scope of scopes) {
        provider ??= scope.children.get(name)?.pkg ?? (scope.name === name ? scope.pkg : undefined)
        if (provider) break
      }
      if (provider) {
        if (!matches(provider, name, range)) throw new Error(`incompatible extension peer dependency ${name}@${range}`)
        continue
      }
      if (node.pkg.peerDependenciesMeta?.[name]?.optional) continue
      const consumer = scopes[0] ?? node
      const ancestors = new Map([...scopes].reverse().map(scope => [scope.name, scope.pkg]))
      const resolved = (await resolve(name, range, ancestors, depth + 1))!
      consumer.children.set(name, resolved)
    }
    // Map iteration includes peers appended by a child to this consumer's dependency set.
    for (const child of node.children.values()) await peers(child, [node, ...scopes], depth + 1)
  }
  await peers(root, [], 0)
  // Drop metadata before archives; no persistent/global cache and only one bounded download on disk.
  metadata.clear()
  const budget = new InstallBudget(limits)
  const packages: Record<string, { version: string; resolved: string; integrity: string }> = {}
  async function install(node: Node, path: string, lockPath: string, depth: number): Promise<void> {
    const { pkg } = node
    const archive = await fetchFile(pkg.dist.tarball, limits.bytes)
    try {
      const tokens = integrityTokens(pkg.dist.integrity)
      const hash = createHash(tokens[0]!.algorithm)
      for await (const chunk of createReadStream(archive)) hash.update(chunk as Buffer)
      const digest = hash.digest()
      if (!tokens.some(token => timingSafeEqual(digest, token.digest))) throw new Error('extension dependency integrity mismatch')
      await extractRegistryArchive(archive, path, budget, depth)
    } finally { await rm(archive, { force: true }) }
    packages[lockPath] = { version: pkg.version, resolved: pkg.dist.tarball, integrity: pkg.dist.integrity }
    // The archive is authoritative for lifecycle scripts; metadata can omit them.
    async function inspect(dir: string): Promise<void> {
      for await (const entry of await opendir(dir)) {
        const file = join(dir, entry.name)
        if (entry.isDirectory()) await inspect(file)
        else if (entry.name === 'package.json') lifecycle(JSON.parse((await readRegular(file, MANIFEST_BYTES)).toString('utf8')) as Package)
      }
    }
    await inspect(path)
    const archivePackage = JSON.parse((await readRegular(join(path, 'package.json'), MANIFEST_BYTES)).toString('utf8')) as Package
    if (archivePackage.name !== pkg.name || archivePackage.version !== pkg.version) throw new Error('extension registry archive identity mismatch')
    if (node.children.size) {
      budget.entry(depth + 1)
      await mkdir(join(path, 'node_modules'))
      const scopes = new Set<string>()
      for (const [name, child] of node.children) {
        const scoped = name.startsWith('@')
        if (scoped && !scopes.has(name.split('/')[0]!)) {
          budget.entry(depth + 2)
          await mkdir(join(path, 'node_modules', name.split('/')[0]!)); scopes.add(name.split('/')[0]!)
        }
        budget.entry(depth + (scoped ? 3 : 2))
        await install(child, join(path, 'node_modules', name), `${lockPath}/node_modules/${name}`, depth + (scoped ? 3 : 2))
      }
    }
  }
  await install(root, artifact, `node_modules/${sourceName}`, 0)
  // Preserve the package's own resolvable name (including circular dependencies and self-imports)
  // alongside the entry at the artifact root, as the previous npm layout did. Copy via scratch
  // so traversal never discovers its own output; the SAME budget includes the duplicate.
  const self = join(scratch, 'self')
  const selfDepth = sourceName.startsWith('@') ? 3 : 2
  await copyArtifact(artifact, self, budget, undefined, selfDepth)
  let parent = join(artifact, 'node_modules')
  for (const part of ['node_modules', ...(sourceName.startsWith('@') ? [sourceName.split('/')[0]!] : [])]) {
    parent = part === 'node_modules' ? join(artifact, part) : join(parent, part)
    if (!await lstat(parent).catch(() => null)) { budget.entry(part === 'node_modules' ? 1 : 2); await mkdir(parent) }
  }
  budget.entry(selfDepth)
  await rename(self, join(artifact, 'node_modules', sourceName))
  const lock = { name: sourceName, lockfileVersion: 3, packages }
  const lockText = JSON.stringify(lock, null, 2)
  budget.entry(1); budget.data(Buffer.byteLength(lockText))
  await writeFile(join(artifact, '.cezar-package-lock.json'), lockText, { flag: 'wx' })
  await rm(scratch, { recursive: true })
  return { version: root.pkg.version, integrity: root.pkg.dist.integrity, lock }
}
