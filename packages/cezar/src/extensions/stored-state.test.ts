import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { Hono } from 'hono'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { artifactIntegrity } from './installer.ts'
import { ExtensionManager } from './manager.ts'
import { chatManagementOwner } from './project-runtime.ts'
import { closeProjectExtensions, extensionRoutes } from '../server/extensions.ts'
import type { ProjectContext } from '../server/project-context.ts'

// Written by a real 16e4492c4 build: Telegram disabled, Discord enabled, legacy.tool (old spellings)
// and modern.tool approved, legacy.chat selected for Slack.
const FIXTURE = fileURLToPath(new URL('./fixtures/state-16e4492c4.tgz', import.meta.url))
const spawns = vi.hoisted(() => vi.fn())
vi.mock('./worker-process.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('./worker-process.ts')>()
  return { ...actual, spawnWorkerProcess: (options: Parameters<typeof actual.spawnWorkerProcess>[0]) => { spawns(); return actual.spawnWorkerProcess(options) } }
})

const roots: string[] = []
const managers: ExtensionManager[] = []
const previousHome = process.env.CEZ_HOME
beforeEach(() => { spawns.mockClear() })
afterEach(async () => {
  await Promise.all(managers.splice(0).map(manager => manager.close()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  process.env.CEZ_HOME = previousHome
})

async function shippedCatalog(root: string) {
  const directory = join(root, 'dist', 'chat-plugins'), stamps = []
  for (const provider of ['telegram', 'slack', 'discord']) {
    const artifact = join(directory, provider)
    await mkdir(join(artifact, 'dist'), { recursive: true })
    const manifest = JSON.parse(await readFile(new URL(`../../../chat-plugins/${provider}/cezar-extension.json`, import.meta.url), 'utf8')) as { id: string; version: string }
    await writeFile(join(artifact, 'cezar-extension.json'), JSON.stringify(manifest))
    await writeFile(join(artifact, 'package.json'), JSON.stringify({ name: `@open-mercato/cezar-chat-${provider}`, version: manifest.version, type: 'module' }))
    await writeFile(join(artifact, 'dist', 'index.js'), `export default { activate(context) { context.chat.register('${provider}', () => ({})) } }`)
    stamps.push({ provider, extensionId: manifest.id, version: manifest.version, integrity: await artifactIntegrity(artifact) })
  }
  await writeFile(join(directory, 'catalog.json'), JSON.stringify(stamps))
}

async function oldState() {
  const parent = await mkdtemp(join(tmpdir(), 'cezar-old-state-')); roots.push(parent)
  // -p: artifact integrity hashes file modes.
  await promisify(execFile)('tar', ['-xzpf', FIXTURE, '-C', parent])
  const root = join(parent, 'fx1.pristine'), data = join(root, '.ai', 'cezar'), home = join(root, 'home')
  const shipped = join(parent, 'package')
  await shippedCatalog(shipped)
  const logs: string[] = []
  const open = () => {
    const manager = new ExtensionManager(data, 'project', root, { home, deliveryPackageRoot: shipped, chatOnDemand: true, openChatOwner: chatManagementOwner({ root, dataDir: data, projectId: 'project' }), log: (_level, message) => { logs.push(message) } })
    managers.push(manager)
    return manager
  }
  return { root, data, home, logs, open, approvals: join(data, 'extensions', 'registry.json'), catalog: join(home, 'extensions', 'registry.json'), selection: join(data, 'extensions', 'chat-selections', 'slack.json') }
}
const item = async (manager: ExtensionManager, id: string) => (await manager.inventory()).find(entry => entry.record.manifest.id === id)
const edit = async (file: string, change: (rows: Record<string, unknown>[]) => unknown) =>
  writeFile(file, JSON.stringify(change(JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>[])))
const breakManifest = (row: Record<string, unknown>) => ({ ...row, manifest: { ...(row.manifest as object), apiVersion: '9.9' } })
const idOf = (row: Record<string, unknown>) => (row.manifest as { id: string }).id

it('keeps a shipped adapter the user disabled disabled, with no worker', async () => {
  const { open } = await oldState()
  const manager = open()
  expect(await item(manager, 'open-mercato.telegram')).toMatchObject({ availability: 'disabled', record: { enabled: false } })
  expect((await item(manager, 'open-mercato.discord'))?.record.enabled).toBe(true)
  await manager.startDeliveredChat('telegram')
  expect((await manager.records()).find(record => record.manifest.id === 'open-mercato.telegram')?.enabled).toBe(false)
  expect(manager.contexts.has('open-mercato.telegram')).toBe(false)
  expect(spawns).not.toHaveBeenCalled()
})

it('still lists old installed extensions and approvals, folded to the current shape', async () => {
  const { open } = await oldState()
  const manager = open()
  expect((await manager.catalog.list()).map(record => record.manifest.id).sort()).toEqual(['legacy.chat', 'legacy.tool', 'modern.tool'])
  expect((await manager.approvals.list()).map(record => record.manifest.id).sort()).toEqual(['legacy.chat', 'legacy.tool', 'modern.tool', 'open-mercato.discord', 'open-mercato.telegram'])
  const legacy = await item(manager, 'legacy.tool')
  expect(legacy).toMatchObject({ availability: 'available', record: { enabled: true } })
  expect(legacy?.record.manifest).toMatchObject({ entry: 'index.mjs', permissions: ['project.read'], capabilities: ['commands', 'panels', 'taskEvents'], contributes: { commands: [{ id: 'a', label: 'Do' }], panels: [{ id: 'p', title: 'P' }] } })
  expect(legacy?.record.manifest).not.toHaveProperty('actions')
  expect((await item(manager, 'modern.tool'))?.record.enabled).toBe(true)
})

it('runs an old artifact from its unmodified bytes under its old approval', async () => {
  const { open } = await oldState()
  const manager = open()
  await manager.restore({ chatOnDemand: true })
  await expect(manager.invoke('legacy.tool', 'a')).resolves.toMatchObject({ ok: true, message: 'ok' })
})

it('verifies an old chat selection against the old artifact on disk', async () => {
  const { open } = await oldState()
  const manager = open()
  await expect(manager.selections.resolve('slack')).resolves.toMatchObject({ extensionId: 'legacy.chat', localProviderId: 'chatty' })
  expect(await item(manager, 'legacy.chat')).toMatchObject({ availability: 'available', record: { enabled: true } })
})

async function routes(state: Awaited<ReturnType<typeof oldState>>) {
  process.env.CEZ_HOME = state.home
  const project = { id: 'project', root: state.root, dataDir: state.data, store: { listRuns: () => [], getRun: () => undefined, on() {}, off() {} } } as unknown as ProjectContext
  const app = new Hono<{ Variables: { project: ProjectContext } }>().use(async (c, next) => { c.set('project', project); await next() }).route('/', extensionRoutes())
  return { app, close: () => closeProjectExtensions(project) }
}

it('answers inventory and access for an old chat selection', async () => {
  const { app, close } = await routes(await oldState())
  try {
    for (const path of ['/extensions/inventory', '/extensions/access']) expect((await app.request(path)).status).toBe(200)
  } finally { await close() }
})

it('confines an unreadable chat selection to its own provider', async () => {
  const state = await oldState()
  await writeFile(state.selection, '{')
  const { app, close } = await routes(state)
  try {
    expect((await app.request('/extensions/access')).status).toBe(200)
    const inventory = await app.request('/extensions/inventory')
    expect(inventory.status).toBe(200)
    const { extensions } = await inventory.json() as { extensions: { availability: string; record: { manifest: { id: string }; enabled: boolean } }[] }
    expect(extensions.find(entry => entry.record.manifest.id === 'modern.tool')).toMatchObject({ availability: 'available', record: { enabled: true } })
  } finally { await close() }
  const manager = state.open()
  // No fallback: the shipped adapter does not silently take over the slot.
  expect(await item(manager, 'open-mercato.slack')).toMatchObject({ availability: 'failed', management: { enable: false }, record: { enabled: false, error: expect.stringContaining('slack') } })
  expect(state.logs.some(line => line.includes('slack'))).toBe(true)
})

it('does not run the extension an unreadable selection names', async () => {
  const state = await oldState()
  await edit(state.selection, selection => ({ ...selection, revision: 'not-a-uuid' }))
  const manager = state.open()
  expect(await item(manager, 'legacy.chat')).toMatchObject({ availability: 'failed', record: { enabled: false } })
  expect((await manager.records()).find(record => record.manifest.id === 'legacy.chat')?.enabled).toBe(false)
  await expect(manager.setEnabled('legacy.chat', true)).rejects.toThrow('unreadable')
})

it('reads an unreadable shipped approval as not enabled and reports it; enabling replaces it', async () => {
  const state = await oldState()
  await edit(state.approvals, rows => (rows as Record<string, unknown>[]).map(row => idOf(row) === 'open-mercato.telegram' ? breakManifest(row) : row))
  const manager = state.open()
  expect(await item(manager, 'open-mercato.telegram')).toMatchObject({ availability: 'failed', management: { enable: true }, record: { enabled: false, error: expect.stringContaining('approval') } })
  await manager.startDeliveredChat('telegram')
  expect(manager.contexts.has('open-mercato.telegram')).toBe(false)
  expect(spawns).not.toHaveBeenCalled()
  expect(state.logs.some(line => line.includes('open-mercato.telegram'))).toBe(true)
  expect((await item(manager, 'open-mercato.discord'))?.record.enabled).toBe(true)
  await manager.setEnabled('open-mercato.telegram', true)
  expect((await manager.approvals.snapshot()).unreadable).toEqual([])
  expect((await item(manager, 'open-mercato.telegram'))?.record.enabled).toBe(true)
})

it('reads every shipped adapter as not enabled when the approvals file is unreadable, and refuses to overwrite it', async () => {
  const state = await oldState()
  await writeFile(state.approvals, '{')
  const manager = state.open()
  for (const id of ['open-mercato.telegram', 'open-mercato.discord']) expect((await item(manager, id))?.record.enabled).toBe(false)
  await manager.startDeliveredChat('discord')
  expect(spawns).not.toHaveBeenCalled()
  await expect(manager.approvals.update(records => records)).rejects.toThrow('unreadable')
  expect(await readFile(state.approvals, 'utf8')).toBe('{')
})

it('shows an unreadable installed record as failed instead of dropping it', async () => {
  const state = await oldState()
  await edit(state.catalog, rows => (rows as Record<string, unknown>[]).map(row => idOf(row) === 'legacy.tool' ? breakManifest(row) : row))
  await edit(state.approvals, rows => (rows as Record<string, unknown>[]).filter(row => idOf(row) !== 'legacy.tool'))
  const manager = state.open()
  expect(await item(manager, 'legacy.tool')).toMatchObject({ availability: 'failed', management: { enable: false, uninstall: false }, record: { enabled: false, status: 'failed', source: expect.any(String) } })
  expect((await item(manager, 'modern.tool'))?.record.enabled).toBe(true)
})
