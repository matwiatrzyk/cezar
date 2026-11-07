import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  bundledProviderManifestSchema,
  loadBundledProviderCatalog,
  reservedBundledProviderIds,
  validateBundledProviderCollision,
} from './bundled-catalog.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture(entries: Record<string, string | { entry: string; integrity?: string }> = { slack: 'slack.js' }) {
  const root = await mkdtemp(join(tmpdir(), 'cezar-bundled-catalog-')); roots.push(root)
  const files: Record<string, string> = {}
  const manifests = []
  for (const [id, value] of Object.entries(entries)) {
    const entry = typeof value === 'string' ? value : value.entry
    const artifact = join(root, 'dist', 'bundled-chat', id)
    await mkdir(artifact, { recursive: true })
    await writeFile(join(artifact, entry), `${id} worker\n`)
    const integrity = createHash('sha512').update(`${id} worker\n`).digest('base64')
    manifests.push({ id, version: '1.0.0', entry, integrity: typeof value === 'string' ? `sha512-${integrity}` : value.integrity ?? `sha512-${integrity}`, format: `${id}.v1` })
    files[id] = integrity
  }
  await writeFile(join(root, 'dist', 'bundled-chat', 'catalog.json'), JSON.stringify(manifests))
  return root
}

describe('bundled provider catalog', () => {
  it('parses the exact manifest shape and exposes stable reserved IDs', () => {
    expect(bundledProviderManifestSchema.parse({ id: 'slack', version: '1.0.0', entry: 'index.js', integrity: 'sha512-abc', format: 'slack.v1' })).toEqual({ id: 'slack', version: '1.0.0', entry: 'index.js', integrity: 'sha512-abc', format: 'slack.v1' })
    expect(reservedBundledProviderIds()).toEqual(['slack', 'discord'])
  })

  it('loads entries only from their provider directory and verifies integrity', async () => {
    const root = await fixture({ slack: 'index.js', discord: 'main.js' })
    await expect(loadBundledProviderCatalog(root)).resolves.toHaveLength(2)
    const bad = await fixture({ slack: { entry: 'index.js', integrity: 'sha512-tampered' } })
    await expect(loadBundledProviderCatalog(bad)).rejects.toThrow(/integrity/i)
    const missing = await fixture({ slack: 'missing.js' })
    await rm(join(missing, 'dist', 'bundled-chat', 'slack', 'missing.js'))
    await expect(loadBundledProviderCatalog(missing)).rejects.toThrow(/entry|artifact/i)
  })

  it('rejects path escapes and reserved external IDs or formats', async () => {
    const root = await fixture({ slack: { entry: '../outside.js' } })
    await expect(loadBundledProviderCatalog(root)).rejects.toThrow(/inside|contain/i)
    expect(() => validateBundledProviderCollision('slack', 'custom.v1')).toThrow(/reserved/i)
    expect(() => validateBundledProviderCollision('acme/relay', 'slack.v1')).toThrow(/reserved/i)
    expect(() => validateBundledProviderCollision('acme/relay', 'acme/relay.v1')).not.toThrow()
  })
})
