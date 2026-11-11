import { expect, it } from 'vitest'
import { extensionManifestSchema, extensionRecordSchema, type ExtensionRecord } from '@open-mercato/cezar-contract'
import { keepsConsent } from './consent.ts'
import { foldLegacyManifest, parseStoredManifest } from './stored-manifest.ts'

const base = { id: 'old.tool', name: 'Old', version: '1.0.0', apiVersion: '0.1' }

it('folds every removed spelling, identically from raw bytes and from what the old build persisted', () => {
  const raw = { ...base, schemaVersion: 1, main: 'index.mjs', permissions: ['tasks.read'], panels: [{ id: 'p', title: 'P', actions: [{ id: 'a', title: 'Do', permission: 'tasks.read' }] }], actions: [{ id: 'a', title: 'Do', permission: 'tasks.read' }] }
  const persisted = { ...base, entry: 'index.mjs', permissions: ['project.read'], panels: [{ id: 'p', title: 'P', blocks: [], actions: [{ id: 'a', label: 'Do', permission: 'project.read' }] }], actions: [{ id: 'a', label: 'Do', permission: 'project.read' }] }
  expect(parseStoredManifest(raw)).toEqual(parseStoredManifest(persisted))
  expect(parseStoredManifest(raw)).toMatchObject({ entry: 'index.mjs', permissions: ['project.read'], contributes: { commands: [{ id: 'a', label: 'Do', permission: 'project.read' }] } })
})

it('leaves a current manifest as the strict schema reads it', () => {
  const current = { ...base, entry: 'index.mjs', capabilities: ['commands'], permissions: [], contributes: { commands: [{ id: 'a', label: 'Do' }] } }
  expect(parseStoredManifest(current)).toEqual(extensionManifestSchema.parse(current))
})

it('keeps the strict schema the only gate for new manifests', () => {
  expect(extensionManifestSchema.safeParse({ ...base, main: 'index.mjs' }).success).toBe(false)
  expect(extensionManifestSchema.safeParse(foldLegacyManifest({ ...base, main: 'index.mjs' })).success).toBe(true)
})

it('still refuses a host feature the old host did not support', () => {
  expect(() => parseStoredManifest({ ...base, entry: 'index.mjs', requiredHostFeatures: ['chat.future.v9'] })).toThrow()
  expect(parseStoredManifest({ ...base, entry: 'index.mjs', requiredHostFeatures: ['chat.presentation.v1'] })).not.toHaveProperty('requiredHostFeatures')
})

it('never widens consent for an old record without capabilities', () => {
  const stored = (manifest: Record<string, unknown>): ExtensionRecord => extensionRecordSchema.parse({ manifest: parseStoredManifest(manifest), source: './old', installedAt: 'then', enabled: true })
  const old = stored({ ...base, main: 'index.mjs', actions: [{ id: 'a', title: 'Do' }] })
  expect(old.manifest.capabilities).toEqual(['commands'])
  const update = (capabilities: string[]) => stored({ ...base, entry: 'index.mjs', capabilities, contributes: { commands: [{ id: 'a', label: 'Do' }] } })
  expect(keepsConsent(old, update(['commands']))).toBe(true)
  expect(keepsConsent(old, update(['commands', 'taskEvents']))).toBe(false)
  expect(keepsConsent(old, update(['commands', 'settings']))).toBe(false)
})
