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

// V1.1 placements (spec 2026-11-07-extension-placements-v1.1): additive inside API 0.1.
const placed = {
  ...legacy, capabilities: ['commands', 'panels'],
  contributes: {
    panels: [{ id: 'side', title: 'Side', location: 'sidebar' }, { id: 'task', title: 'Task', location: 'task' }, { id: 'plain', title: 'Plain' }],
    commands: [{ id: 'pal', title: 'Palette', location: 'palette' }, { id: 'tsk', title: 'Task', location: 'task' }, { id: 'def', title: 'Default' }],
  },
}
test('a V1 manifest without location parses byte-for-byte as before (no default is written)', () => {
  const v1 = { ...legacy, panels: [{ id: 'p', title: 'P' }], actions: [{ id: 'a', label: 'A' }], contributes: { commands: [{ id: 'c', title: 'C' }], panels: [{ id: 'q', title: 'Q' }] } }
  const parsed = extensionManifestSchema.parse(v1)
  assert.deepEqual(parsed, {
    ...legacy, permissions: [], panels: [{ id: 'p', title: 'P', blocks: [], actions: [] }], actions: [{ id: 'a', label: 'A' }],
    contributes: { commands: [{ id: 'c', label: 'C' }], panels: [{ id: 'q', title: 'Q', blocks: [], actions: [] }], forms: [], chatProviders: [] },
  })
  for (const item of [...parsed.panels, ...parsed.actions, ...parsed.contributes.commands, ...parsed.contributes.panels]) assert.equal('location' in item, false)
  assert.equal(sdk.DEFAULT_EXTENSION_LOCATION, 'settings')
})
test('location is kept on panels and commands and validated against its own enum', () => {
  const parsed = extensionManifestSchema.parse(placed)
  assert.deepEqual(parsed.contributes.panels.map(panel => panel.location), ['sidebar', 'task', undefined])
  assert.deepEqual(parsed.contributes.commands.map(command => command.location), ['palette', 'task', undefined])
  assert.deepEqual(sdk.extensionPanelLocationSchema.options, ['settings', 'sidebar', 'task'])
  assert.deepEqual(sdk.extensionCommandLocationSchema.options, ['settings', 'palette', 'task'])
  for (const bad of [
    { contributes: { panels: [{ id: 'x', title: 'X', location: 'palette' }] } },
    { contributes: { commands: [{ id: 'x', title: 'X', location: 'sidebar' }] } },
    { contributes: { panels: [{ id: 'x', title: 'X', location: 'toolbar' }] } },
    // A panel's action BUTTON has no placement of its own.
    { contributes: { panels: [{ id: 'x', title: 'X', actions: [{ id: 'pal', label: 'P', location: 'palette' }] }] } },
  ]) assert.equal(extensionManifestSchema.safeParse({ ...legacy, ...bad }).success, false, JSON.stringify(bad))
})
test('per-extension placement limits: 3 sidebar panels, 5 task panels, 20 palette commands', () => {
  assert.deepEqual([sdk.MAX_SIDEBAR_PANELS, sdk.MAX_TASK_PANELS, sdk.MAX_PALETTE_COMMANDS], [3, 5, 20])
  const panels = (n, location) => Array.from({ length: n }, (_, i) => ({ id: `${location}-${i}`, title: 'P', location }))
  const commands = (n, location) => Array.from({ length: n }, (_, i) => ({ id: `${location}-${i}`, title: 'C', location }))
  assert.equal(extensionManifestSchema.safeParse({ ...legacy, contributes: { panels: panels(3, 'sidebar') } }).success, true)
  assert.equal(extensionManifestSchema.safeParse({ ...legacy, contributes: { panels: panels(4, 'sidebar') } }).success, false)
  assert.equal(extensionManifestSchema.safeParse({ ...legacy, contributes: { panels: panels(5, 'task') } }).success, true)
  assert.equal(extensionManifestSchema.safeParse({ ...legacy, contributes: { panels: panels(6, 'task') } }).success, false)
  // Legacy top-level `panels`/`actions` count towards the same limits.
  assert.equal(extensionManifestSchema.safeParse({ ...legacy, panels: panels(2, 'sidebar'), contributes: { panels: [{ id: 'more', title: 'M', location: 'sidebar' }, { id: 'over', title: 'O', location: 'sidebar' }] } }).success, false)
  assert.equal(extensionManifestSchema.safeParse({ ...legacy, contributes: { commands: commands(20, 'palette') } }).success, true)
  assert.equal(extensionManifestSchema.safeParse({ ...legacy, contributes: { commands: commands(21, 'palette') } }).success, false)
  assert.equal(extensionManifestSchema.safeParse({ ...legacy, actions: commands(1, 'palette'), contributes: { commands: commands(20, 'palette').map(c => ({ ...c, id: `c-${c.id}` })) } }).success, false)
  // Settings-located (default) contributions are bounded only by the array caps.
  assert.equal(extensionManifestSchema.safeParse({ ...legacy, contributes: { panels: panels(10, undefined).map(({ location, ...p }) => p) } }).success, true)
})
test('the task context shape is exported for providers and command input', () => {
  assert.deepEqual(sdk.extensionTaskContextSchema.parse({ runId: 'abc' }), { runId: 'abc' })
  assert.equal(sdk.extensionTaskContextSchema.safeParse({ runId: 'abc', projectId: 'other' }).success, false)
})
