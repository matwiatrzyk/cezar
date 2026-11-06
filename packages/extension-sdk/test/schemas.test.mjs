import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extensionManifestSchema, extensionRpcRequestSchema, extensionTaskNotificationSchema, defineExtension } from '../dist/index.js'

const legacy = { id: 'example', name: 'Example', version: '1', apiVersion: '0.1', entry: 'index.js' }
test('legacy manifests retain their normalized wire shape', () => {
  assert.deepEqual(extensionManifestSchema.parse(legacy), { ...legacy, permissions: [], panels: [], actions: [] })
})
test('canonical aliases normalize to the existing host contract', () => {
  const { entry, ...base } = legacy
  assert.deepEqual(extensionManifestSchema.parse({
    ...base, schemaVersion: 1, main: entry, capabilities: ['commands', 'panels', 'taskEvents'],
    permissions: ['tasks.read'], contributes: { commands: [{ id: 'refresh', title: 'Refresh' }] },
  }), {
    ...legacy, permissions: ['project.read'], panels: [], actions: [],
    contributes: { commands: [{ id: 'refresh', label: 'Refresh' }], panels: [] },
  })
})
test('unknown capabilities, versions, permissions and conflicting aliases fail closed', () => {
  for (const patch of [
    { capabilities: ['chat'] }, { capabilities: ['forms'] }, { schemaVersion: 2 },
    { permissions: ['tasks.write'] }, { main: 'different.js' }, { apiVersion: '0.2' },
    { actions: [{ id: 'x', label: 'A', title: 'B' }] },
    { actions: [{ id: 'x' }] }, { entry: undefined },
    { entry: '/tmp/index.js' },
  ]) assert.equal(extensionManifestSchema.safeParse({ ...legacy, ...patch }).success, false)
})
test('duplicate contribution ids are still rejected', () => {
  assert.equal(extensionManifestSchema.safeParse({
    ...legacy, actions: [{ id: 'x', label: 'X' }],
    contributes: { commands: [{ id: 'x', title: 'X' }] },
  }).success, false)
})
test('panel RPC and lifecycle definitions are preserved', () => {
  assert.equal(extensionRpcRequestSchema.parse({ type: 'request', requestId: '1', generation: '1', method: 'panel', params: {} }).method, 'panel')
  const definition = { activate() { return { dispose() {} } }, deactivate() {} }
  assert.equal(defineExtension(definition), definition)
})

test('resync notifications preserve the existing task event shape', () => {
  assert.deepEqual(extensionTaskNotificationSchema.parse({ type: 'resyncRequired' }), { type: 'resyncRequired' })
  assert.equal(extensionTaskNotificationSchema.safeParse({ type: 'resyncRequired', task: {} }).success, false)
  assert.equal(extensionTaskNotificationSchema.parse({ type: 'created', sequence: 1, task: { id: '1', title: 'Task', status: 'queued' } }).type, 'created')
})
