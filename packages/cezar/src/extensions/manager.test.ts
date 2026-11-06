import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ExtensionManager } from './manager.ts'
const roots: string[] = []
const managers: ExtensionManager[] = []
afterEach(async () => { await Promise.all(managers.splice(0).map(manager => manager.close())); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
 const root = await mkdtemp(join(tmpdir(), 'cezar-extension-')); roots.push(root)
 const source = join(root, 'hello'); await mkdir(source)
 const manifest = { id: 'hello.test', name: 'Hello', version: '1.0.0', apiVersion: '0.1', entry: 'index.mjs', permissions: ['project.read'], panels: [{ id: 'p', title: 'Panel' }], actions: [{ id: 'say', label: 'Say' }] }
 await writeFile(join(source, 'extension.json'), JSON.stringify(manifest))
 await writeFile(join(source, 'index.mjs'), `export default { activate(context) { context.commands.register('say', async () => ({ message: JSON.stringify(await context.tasks.list()) })); context.panels.register('p', async () => ({ id: 'p', title: context.projectId, text: 'live' })); } }`)
 const manager = new ExtensionManager(join(root, 'data'), 'demo', root, { home: join(root, 'home'), listTasks: async () => [{ id: 'one', title: 'Task', status: 'running' }] }); managers.push(manager)
 return { root, source, manager, manifest }
}
it('installs an immutable preview and runs registered commands and live panels with project context', async () => {
 const { source, manager } = await fixture()
 const preview = await manager.prepare(source)
 await writeFile(join(source, 'index.mjs'), `throw Error('changed after preview')`)
 expect((await manager.commit(preview.preparedId)).enabled).toBe(false)
 await manager.setEnabled('hello.test', true)
 await expect(manager.invoke('hello.test', 'say')).resolves.toMatchObject({ ok: true, message: '[{"id":"one","title":"Task","status":"running"}]' })
 expect((await manager.panel('hello.test', 'p'))?.title).toBe('demo')
 await manager.setEnabled('hello.test', false)
 await expect(manager.invoke('hello.test', 'say')).rejects.toThrow(/enabled/)
})
it('installs globally but never enables the extension in another project', async () => {
 const { root, source, manager } = await fixture()
 await manager.install(source); await manager.setEnabled('hello.test', true)
 const other = new ExtensionManager(join(root, 'other'), 'other', root, { home: join(root, 'home') }); managers.push(other)
 expect(await other.list()).toMatchObject([{ enabled: false }])
 await expect(other.invoke('hello.test', 'say')).rejects.toThrow(/enabled/)
})
it('rejects an entry point escaping the artifact during preview', async () => {
 const { source, manager, manifest } = await fixture()
 await writeFile(join(source, 'extension.json'), JSON.stringify({ ...manifest, entry: '../outside.mjs' }))
 await expect(manager.prepare(source)).rejects.toThrow(/inside/)
})
it('stops another project worker when a globally installed extension is uninstalled', async () => {
 const { root, source, manager } = await fixture()
 await writeFile(join(source, 'index.mjs'), `export function onAction() { return { message: String(process.pid) } }`)
 await manager.install(source)
 const other = new ExtensionManager(join(root, 'other'), 'other', root, { home: join(root, 'home') }); managers.push(other)
 await other.setEnabled('hello.test', true)
 const pid = Number((await other.invoke('hello.test', 'say')).message)
 expect(() => process.kill(pid, 0)).not.toThrow()
 await manager.uninstall('hello.test')
 expect(() => process.kill(pid, 0)).toThrow()
})
it('restores code and extension-owned data when an updated activation fails', async () => {
 const { source, manager, manifest } = await fixture()
 await writeFile(join(source, 'index.mjs'), `export async function activate(context) { if (!await context.storage.get('value')) await context.storage.set('value', 'original'); context.commands.register('say', async () => ({ message: await context.storage.get('value') })); }`)
 await manager.install(source); await manager.setEnabled('hello.test', true)
 await writeFile(join(source, 'extension.json'), JSON.stringify({ ...manifest, version: '2.0.0' }))
 await writeFile(join(source, 'index.mjs'), `export async function activate(context) { await context.storage.set('value', 'broken'); throw Error('broken update'); }`)
 const preview = await manager.prepare(source)
 await expect(manager.commit(preview.preparedId)).rejects.toThrow('broken update')
 await expect(manager.invoke('hello.test', 'say')).resolves.toMatchObject({ message: 'original' })
 expect((await manager.list())[0]?.manifest.version).toBe('1.0.0')
})
