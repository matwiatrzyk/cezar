import { mkdtemp, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ExtensionManager } from './manager.ts'

describe('ExtensionManager', () => {
  it('installs a local manifest, enables it, renders panels and invokes a worker action', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cezar-extension-'))
    const source = join(root, 'hello'); await mkdir(source)
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(source, 'extension.json'), JSON.stringify({ id: 'hello.test', name: 'Hello', version: '1', apiVersion: '1', entry: 'index.mjs', permissions: [], panels: [{ id: 'p', title: 'Panel', actions: [{ id: 'say', label: 'Say' }] }], actions: [{ id: 'say', label: 'Say' }] }))
    await writeFile(join(source, 'index.mjs'), 'export async function onAction() { return { message: "worked" } }')
    const manager = new ExtensionManager(join(root, 'data'), 'demo', root)
    expect((await manager.install(source)).enabled).toBe(false)
    expect((await manager.panels())).toHaveLength(0)
    await manager.setEnabled('hello.test', true)
    expect((await manager.panels())[0]?.title).toBe('Panel')
    await expect(manager.invoke('hello.test', 'say')).resolves.toMatchObject({ ok: true, message: 'worked' })
  })
})
