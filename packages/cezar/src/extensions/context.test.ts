import { describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ExtensionHostContext } from './context.ts'

describe('ExtensionHostContext', () => {
  it('fences permissions, project identity and pending mutations after disable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cezar-extension-context-'))
    const context = new ExtensionHostContext({ dataDir: root, projectId: 'project-a', projectRoot: '/repo/a', extensionId: 'example.test', permissions: ['project.read'] })
    expect(context.projectId).toBe('project-a')
    await expect(context.proposeTask({ title: 'no', prompt: 'no' })).rejects.toThrow('task.create')
    context.disable()
    await expect(context.listTasks()).rejects.toThrow('disabled')
    expect(context.projectRoot).toBe('/repo/a')
  })

  it('isolates extension storage by extension id', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cezar-extension-storage-'))
    const one = new ExtensionHostContext({ dataDir: root, projectId: 'p', projectRoot: '/repo', extensionId: 'one', permissions: ['project.read'] })
    const two = new ExtensionHostContext({ dataDir: root, projectId: 'p', projectRoot: '/repo', extensionId: 'two', permissions: ['project.read'] })
    await one.storage.set('answer', 42)
    expect(await two.storage.get('answer')).toBeUndefined()
    expect(await one.storage.get('answer')).toBe(42)
  })
})

it('dispatches only validated operations for its own project and fences a stopped worker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cezar-extension-context-'))
  const context = new ExtensionHostContext({ dataDir: root, projectId: 'p', projectRoot: '/repo', extensionId: 'one', permissions: ['project.read'], listTasks: async () => [{ id: 'task', title: 'Title', status: 'running' }] })
  const signal = new AbortController()
  await expect(context.dispatch('tasks.list', {}, signal.signal)).resolves.toHaveLength(1)
  await expect(context.dispatch('storage.set', { key: 'answer', value: 42, projectId: 'other' }, signal.signal)).rejects.toThrow()
  await context.dispatch('storage.set', { key: 'answer', value: 42 }, signal.signal)
  await expect(context.dispatch('storage.get', { key: 'answer' }, signal.signal)).resolves.toBe(42)
  signal.abort()
  await expect(context.dispatch('storage.set', { key: 'answer', value: 43 }, signal.signal)).rejects.toThrow(/disabled|stopped/)
  expect(await context.storage.get('answer')).toBe(42)
})

it('fences a storage mutation already queued behind a filesystem lock', async () => {
  const { withLifecycleFileLock } = await import('../worktree-lifecycle/store.ts')
  const root = await mkdtemp(join(tmpdir(), 'cezar-extension-fence-'))
  const context = new ExtensionHostContext({dataDir:root,projectId:'p',projectRoot:root,extensionId:'test',permissions:[]})
  let release!: () => void, entered!: () => void
  const ready = new Promise<void>(resolve => { entered = resolve })
  const locked = withLifecycleFileLock(join(root,'extensions/test/storage.json.lock'), async () => { entered(); await new Promise<void>(resolve => { release = resolve }) })
  await ready
  const mutation = context.dispatch('storage.set',{key:'value',value:'must not commit'},new AbortController().signal)
  const rejection = expect(mutation).rejects.toThrow('disabled')
  context.disable(); release(); await locked; await rejection
  expect(await context.storage.get('value')).toBeUndefined()
})

it('lists only the newest tasks so the reply fits one IPC frame (L1)', async () => {
  const { encodeFrame } = await import('./rpc.ts')
  const { MAX_LISTED_TASKS } = await import('./context.ts')
  const root = await mkdtemp(join(tmpdir(), 'cezar-extension-context-'))
  const tasks = Array.from({ length: 20_000 }, (_, index) => ({ id: `task-${index}`.padEnd(200, 'x'), title: 'é"'.repeat(400), status: 'done' as const }))
  const context = new ExtensionHostContext({ dataDir: root, projectId: 'p', projectRoot: '/repo', extensionId: 'one', permissions: ['project.read'], listTasks: async () => tasks })
  const listed = await context.dispatch('tasks.list', {}, new AbortController().signal) as { id: string }[]
  expect(listed).toHaveLength(MAX_LISTED_TASKS)
  expect(listed[0]!.id).toBe(tasks[0]!.id)
  expect(() => encodeFrame({ type: 'hostResponse', requestId: 'r', generation: 'g', ok: true, result: listed })).not.toThrow()
})

it('bounds extension storage by size and key count, keeping what was stored (L4)', async () => {
  const { MAX_STORAGE_KEYS } = await import('./data.ts')
  const root = await mkdtemp(join(tmpdir(), 'cezar-extension-storage-'))
  const context = new ExtensionHostContext({ dataDir: root, projectId: 'p', projectRoot: '/repo', extensionId: 'one', permissions: [] })
  const chunk = 'x'.repeat(900 * 1024)
  for (const key of ['a', 'b', 'c', 'd']) await context.storage.set(key, chunk)
  await expect(context.storage.set('e', chunk)).rejects.toThrow('storage is full')
  expect(await context.storage.get('e')).toBeUndefined()
  await context.storage.set('a', 'small')
  for (let index = 4; index < MAX_STORAGE_KEYS; index++) await context.storage.set(`k${index}`, 1)
  await expect(context.storage.set('one-too-many', 1)).rejects.toThrow('at most')
  expect(await context.storage.get('b')).toBe(chunk)
}, 60_000)
