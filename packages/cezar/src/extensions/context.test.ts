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
