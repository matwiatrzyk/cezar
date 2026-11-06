import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { ExtensionInstaller } from './installer.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'extension-install-')); roots.push(root)
  const source = join(root, 'source'); await mkdir(source)
  const manifest = { id: 'fixture', name: 'Fixture', version: '1.0.0', apiVersion: '0.1', entry: 'index.mjs' }
  await writeFile(join(source, 'extension.json'), JSON.stringify(manifest))
  await writeFile(join(source, 'index.mjs'), 'throw new Error("must never execute")')
  return { root, source, manifest, installer: new ExtensionInstaller(join(root, 'home')) }
}
describe('extension artifact installation', () => {
  it('stages a snapshot and atomically installs immutable same-version reloads', async () => {
    const { source, installer } = await fixture()
    const prepared = await installer.prepareInstall(source)
    await writeFile(join(source, 'index.mjs'), 'changed')
    const installed = await installer.commitInstall(prepared)
    expect(await readFile(join(installed.path, 'index.mjs'), 'utf8')).toContain('must never execute')
    const reload = await installer.commitInstall(await installer.prepareInstall(source))
    expect(reload.path).not.toBe(installed.path)
    expect(installed.integrity).toMatch(/^sha512-/)
  })
  it('serializesConcurrentInstall across installer instances', async () => {
    const { source, root, installer } = await fixture()
    const other = new ExtensionInstaller(join(root, 'home'))
    const [a, b] = await Promise.all([installer.prepareInstall(source), other.prepareInstall(source)])
    const results = await Promise.all([installer.commitInstall(a), other.commitInstall(b)])
    expect(results[0]!.path).toBe(results[1]!.path)
  })
  it('rejects staged tampering and forged preparations', async () => {
    const { source, installer } = await fixture()
    const prepared = await installer.prepareInstall(source)
    await writeFile(join(prepared.artifactDir, 'index.mjs'), 'tampered')
    await expect(installer.commitInstall(prepared)).rejects.toThrow('changed after preview')
    await installer.discardInstall(prepared)
    await expect(installer.commitInstall(prepared)).rejects.toThrow('expired')
  })
  it('rejectsArtifactPathEscape, version traversal and symlink files', async () => {
    const { source, installer, manifest } = await fixture()
    for (const change of [{ entry: '../outside.mjs' }, { version: '../../escape' }]) {
      await writeFile(join(source, 'extension.json'), JSON.stringify({ ...manifest, ...change }))
      await expect(installer.prepareInstall(source)).rejects.toThrow()
    }
    await writeFile(join(source, 'extension.json'), JSON.stringify(manifest))
    await symlink('/etc/passwd', join(source, 'link'))
    await expect(installer.prepareInstall(source)).rejects.toThrow('symbolic link')
  })
  it('rejects URL, git and tarball sources', async () => {
    const { installer } = await fixture()
    for (const source of ['https://example.com/a.tgz', 'git+https://example.com/x', './missing.tgz']) await expect(installer.prepareInstall(source)).rejects.toThrow('only npm')
  })
  it.each(['prepack', 'preinstall'])('never runs %s scripts when staging an exact registry artifact', async (script) => {
    const { root, source, installer } = await fixture()
    const marker = join(root, 'executed')
    await writeFile(join(source, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', scripts: { [script]: `node -e "require('fs').writeFileSync('${marker}', 'bad')"` } }))
    await promisify(execFile)('npm', ['pack', '--ignore-scripts', '--pack-destination', root], { cwd: source, timeout: 30_000 })
    const tarball = await readFile(join(root, 'fixture-1.0.0.tgz'))
    const integrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`
    let address = ''
    const server = createServer((req, res) => {
      if (req.url?.endsWith('.tgz')) { res.end(tarball); return }
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ name: 'fixture', 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': { name: 'fixture', version: '1.0.0', dist: { tarball: `${address}/fixture.tgz`, integrity } } } }))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    address = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    const prior = process.env.npm_config_registry
    process.env.npm_config_registry = address
    try {
      // npm's registry metadata omits scripts: archive scripts still must never run.
      if (script === 'preinstall') {
        await expect(installer.prepareInstall('fixture@1.0.0')).rejects.toThrow('unsupported lifecycle')
        expect(await readdir(root)).not.toContain('executed')
        return
      }
      const prepared = await installer.prepareInstall('fixture')
      expect(prepared.source).toBe('fixture')
      expect(prepared.packageIntegrity).toBe(integrity)
      expect(prepared.resolvedVersion).toBe('1.0.0')
      const installed = await installer.commitInstall(prepared)
      expect(await readFile(join(installed.path, '.cezar-package-lock.json'), 'utf8')).toContain(integrity)
      expect(await readdir(root)).not.toContain('executed')
    } finally {
      if (prior === undefined) delete process.env.npm_config_registry; else process.env.npm_config_registry = prior
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  }, 60_000)
})

describe('source classification', () => {
  it('reads package-shaped sources as npm packages, never as a same-named folder', async () => {
    const { isPackageSource } = await import('./installer.ts')
    expect(['probe', 'probe@1.2.3', '@acme/probe', '@acme/probe@^1'].filter(value => !isPackageSource(value))).toEqual([])
    expect(['./probe', '../probe', '/abs/probe', 'examples/extensions/hello', '.'].filter(isPackageSource)).toEqual([])
  })
  it('accepts dependency tarballs only from the registry npm resolved against', async () => {
    const { fromRegistry } = await import('./installer.ts')
    const origin = 'https://registry.npmjs.org'
    expect(fromRegistry('https://registry.npmjs.org/a/-/a-1.0.0.tgz', origin)).toBe(true)
    expect(fromRegistry('http://registry.npmjs.org/a/-/a-1.0.0.tgz', origin)).toBe(false)
    expect(fromRegistry('https://evil.example/a.tgz', origin)).toBe(false)
    expect(fromRegistry('git+ssh://git@github.com/a/a.git', origin)).toBe(false)
    expect(fromRegistry(undefined, origin)).toBe(false)
  })
})
