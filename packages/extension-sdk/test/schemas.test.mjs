import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as sdk from '../dist/index.js'
import { extensionManifestSchema, extensionTaskNotificationSchema, defineExtension, EXTENSION_API_VERSION, EXTENSION_API_VERSIONS } from '../dist/index.js'

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
    ...legacy, capabilities: ['commands', 'panels', 'taskEvents'], permissions: ['project.read'], panels: [], actions: [],
    contributes: { commands: [{ id: 'refresh', label: 'Refresh' }], panels: [], forms: [], chatProviders: [] },
  })
})
test('unknown capabilities, versions, permissions and conflicting aliases fail closed', () => {
  for (const patch of [
    { capabilities: ['chat'] }, { capabilities: ['runners'] }, { schemaVersion: 2 },
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
test('lifecycle definitions are preserved', () => {
  const definition = { activate() { return { dispose() {} } }, deactivate() {} }
  assert.equal(defineExtension(definition), definition)
})

test('resync notifications preserve the existing task event shape', () => {
  assert.deepEqual(extensionTaskNotificationSchema.parse({ type: 'resyncRequired' }), { type: 'resyncRequired' })
  assert.equal(extensionTaskNotificationSchema.safeParse({ type: 'resyncRequired', task: {} }).success, false)
  assert.equal(extensionTaskNotificationSchema.parse({ type: 'created', sequence: 1, task: { id: '1', title: 'Task', status: 'queued' } }).type, 'created')
})

test('apiVersion accepts exactly the supported list', () => {
  assert.deepEqual(EXTENSION_API_VERSIONS, ['0.1'])
  assert.equal(EXTENSION_API_VERSION, '0.1')
  for (const apiVersion of EXTENSION_API_VERSIONS) assert.equal(extensionManifestSchema.parse({ ...legacy, apiVersion }).apiVersion, apiVersion)
  for (const apiVersion of ['0.0', '1.0', 0.1]) assert.equal(extensionManifestSchema.safeParse({ ...legacy, apiVersion }).success, false)
})

test('host HTTP and IPC shapes stay out of the public surface', () => {
  for (const name of ['extensionRecordSchema', 'extensionsResponseSchema', 'installExtensionInputSchema', 'extensionUninstallQuerySchema',
    'extensionFormsResponseSchema', 'extensionRpcRequestSchema', 'extensionRpcResponseSchema', 'extensionRpcReadySchema',
    'extensionHostRequestSchema', 'extensionStorageSetSchema', 'extensionChatCallSchema']) assert.equal(name in sdk, false, name)
  for (const name of ['extensionManifestSchema', 'extensionPanelSchema', 'extensionFormSchema', 'extensionChatProviderSchema',
    'chatEventSchema', 'validateExtensionForm', 'ExtensionChatError', 'defineExtension']) assert.equal(name in sdk, true, name)
})

test('every permission gates a host API; project.write gated nothing and is refused (L2)', () => {
  assert.deepEqual(extensionManifestSchema.parse({ ...legacy, permissions: ['tasks.read', 'task.create'] }).permissions, ['project.read', 'task.create'])
  assert.equal(extensionManifestSchema.safeParse({ ...legacy, permissions: ['project.write'] }).success, false)
})
