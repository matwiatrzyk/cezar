import { describe, expect, it } from 'vitest'
import { extensionManifestSchema } from '@open-mercato/cezar-contract'

const base = { id: 'example.test', name: 'Example', version: '0.1.0', apiVersion: '0.1' as const, entry: 'dist/index.js', permissions: [], panels: [], actions: [] }
describe('extension manifest', () => {
  it('rejects unsupported API versions', () => expect(extensionManifestSchema.safeParse({ ...base, apiVersion: '0.2' }).success).toBe(false))
  it('rejects absolute and escaping entry points', () => {
    expect(extensionManifestSchema.safeParse({ ...base, entry: '../main.js' }).success).toBe(true) // filesystem fencing is installer-owned
    expect(extensionManifestSchema.safeParse({ ...base, entry: '/tmp/main.js' }).success).toBe(false)
  })
  it('rejects duplicate command contributions', () => expect(extensionManifestSchema.safeParse({ ...base, actions: [{ id: 'run', label: 'Run' }], contributes: { commands: [{ id: 'run', label: 'Run again' }], panels: [] } }).success).toBe(false))
})
