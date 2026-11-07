import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { ExtensionManager } from './manager.ts'
const roots: string[] = []
const managers: ExtensionManager[] = []
afterEach(async () => { await Promise.all(managers.splice(0).map(manager => manager.close())); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
type ManagerLog = NonNullable<NonNullable<ConstructorParameters<typeof ExtensionManager>[3]>['log']>
async function fixture(restarts?: { maxRestarts?: number; delayMs?: () => number }, log?: ManagerLog) {
 const root = await mkdtemp(join(tmpdir(), 'cezar-extension-')); roots.push(root)
 const source = join(root, 'hello'); await mkdir(source)
 const manifest = { id: 'hello.test', name: 'Hello', version: '1.0.0', apiVersion: '0.1', entry: 'index.mjs', permissions: ['project.read'], panels: [{ id: 'p', title: 'Panel' }], actions: [{ id: 'say', label: 'Say' }] }
 await writeFile(join(source, 'extension.json'), JSON.stringify(manifest))
 await writeFile(join(source, 'index.mjs'), `export default { activate(context) { context.commands.register('say', async () => ({ message: JSON.stringify(await context.tasks.list()) })); context.panels.register('p', async () => ({ id: 'p', title: context.projectId, text: 'live' })); } }`)
 const manager = new ExtensionManager(join(root, 'data'), 'demo', root, { home: join(root, 'home'), listTasks: async () => [{ id: 'one', title: 'Task', status: 'running' }], ...(restarts ? { restarts } : {}), ...(log ? { log } : {}) }); managers.push(manager)
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

it('requires the reviewed artifact and restores approved workers after a cockpit restart', async () => {
 const { root, source, manager, manifest } = await fixture()
 const old = await manager.install(source)
 await manager.setEnabled('hello.test', true, old.integrity)
 await manager.close()
 const restored = new ExtensionManager(join(root, 'data'), 'demo', root, { home: join(root, 'home') }); managers.push(restored)
 await restored.restore()
 expect((await restored.list())[0]?.status).toBe('running')
 await expect(restored.panel('hello.test', 'p')).resolves.toMatchObject({ title: 'demo' })
 await restored.setEnabled('hello.test', false)
 await writeFile(join(source, 'extension.json'), JSON.stringify({ ...manifest, version: '2.0.0', permissions: ['task.create'] }))
 await restored.install(source)
 await expect(restored.setEnabled('hello.test', true, old.integrity)).rejects.toThrow(/artifact changed/)
 expect((await restored.list())[0]?.enabled).toBe(false)
})

it('restarts a worker that died after activation, with bounded backoff (M4)', async () => {
 const { source, manager } = await fixture({ delayMs: () => 20 })
 await writeFile(join(source, 'index.mjs'), `export function activate(c) { c.commands.register('say', () => { process.exit(5) }); c.panels.register('p', () => ({id:'p',title:String(process.pid)})); }`)
 await manager.install(source); await manager.setEnabled('hello.test', true)
 const first = (await manager.panel('hello.test', 'p'))?.title
 await expect(manager.invoke('hello.test', 'say')).rejects.toThrow(/exit/)
 await expect.poll(async () => (await manager.list())[0]?.status).toBe('running')
 const second = (await manager.panel('hello.test', 'p'))?.title
 expect(second).toBeDefined()
 expect(second).not.toBe(first)
})

it('leaves a crash-looping worker visibly failed once restarts are exhausted, and permits explicit retry', async () => {
 const delay = vi.fn(() => 20), logs: string[] = []
 const { source, manager } = await fixture({ maxRestarts: 2, delayMs: delay }, (_level, message) => { logs.push(message) })
 await writeFile(join(source, 'index.mjs'), `export function activate(c) { setTimeout(() => process.exit(5), 30); c.panels.register('p', () => ({id:'p',title:'alive'})); }`)
 await manager.install(source)
 await manager.setEnabled('hello.test', true)
 // Each crash shows `failed` while it tears down; the exhausted decision is the settled state.
 await expect.poll(() => logs.some(line => /restarts exhausted/.test(line)), { timeout: 10_000 }).toBe(true)
 expect(delay).toHaveBeenCalledTimes(2)
 expect((await manager.list())[0]).toMatchObject({ status: 'failed', error: expect.stringMatching(/exit/) })
 await expect(manager.panel('hello.test', 'p')).rejects.toThrow(/exit/)
 await manager.setEnabled('hello.test', true)
 expect((await manager.list())[0]?.status).toBe('running')
})

it('rolls back both active projects and their private storage when the second activation fails', async () => {
 const { root, source, manager, manifest } = await fixture()
 await writeFile(join(source, 'index.mjs'), `export async function activate(c) { if(!await c.storage.get('value'))await c.storage.set('value',c.projectId); c.commands.register('say',async()=>({message:await c.storage.get('value')})); }`)
 await manager.install(source); await manager.setEnabled('hello.test', true)
 const other = new ExtensionManager(join(root, 'other'), 'other', root, { home: join(root, 'home') }); managers.push(other)
 await other.setEnabled('hello.test', true)
 await writeFile(join(source, 'extension.json'), JSON.stringify({ ...manifest, version: '2.0.0' }))
 await writeFile(join(source, 'index.mjs'), `export async function activate(c) { await c.storage.set('value','broken'); if(c.projectId==='other') throw Error('second project failed'); c.commands.register('say',()=>({message:'new'})); }`)
 await expect(manager.install(source)).rejects.toThrow('second project failed')
 expect((await manager.invoke('hello.test', 'say')).message).toBe('demo')
 expect((await other.invoke('hello.test', 'say')).message).toBe('other')
 expect((await other.list())[0]?.manifest.version).toBe('1.0.0')
})

it('serializes same-id activation and isolates task proposals from task creation', async () => {
 const { source, manager, manifest } = await fixture()
 await writeFile(join(source, 'extension.json'), JSON.stringify({ ...manifest, permissions: ['task.create'] }))
 await writeFile(join(source, 'index.mjs'), `export async function activate(c) { const count=(await c.storage.get('activations')??0)+1; await c.storage.set('activations',count); c.commands.register('say',async()=>{await c.tasks.propose({title:'Review',prompt:'Review the project'});return {message:String(count)}}); }`)
 await manager.install(source)
 await Promise.all([manager.setEnabled('hello.test', true), manager.setEnabled('hello.test', true)])
 expect(await manager.invoke('hello.test', 'say')).toEqual({ ok: true, message: '1', proposals: [{ title: 'Review', prompt: 'Review the project' }] })
})

it('redacts registered secrets from successful and failed command results', async () => {
 const { source, manager } = await fixture()
 await writeFile(join(source, 'index.mjs'), `export async function activate(c) { await c.secrets.set('token','private-extension-token-12345'); c.commands.register('say', async input => { const secret=await c.secrets.get('token'); if(input?.fail)throw Error(secret); return {message:secret}; }); }`)
 await manager.install(source); await manager.setEnabled('hello.test', true)
 expect((await manager.invoke('hello.test', 'say')).message).toBe('[REDACTED]')
 await expect(manager.invoke('hello.test', 'say', { fail: true })).rejects.toThrow('[REDACTED]')
})

it('rolls back extension-owned secrets and optionally removes only their namespace on uninstall', async () => {
 const { source, manager, manifest } = await fixture()
 await writeFile(join(source, 'index.mjs'), `export async function activate(c) { if(!await c.secrets.get('token'))await c.secrets.set('token','original-secret'); c.commands.register('say',async()=>({message:(await c.secrets.get('token'))==='original-secret'?'original':'wrong'})); }`)
 await manager.install(source); await manager.setEnabled('hello.test', true)
 await writeFile(join(source, 'extension.json'), JSON.stringify({ ...manifest, version: '2.0.0' }))
 await writeFile(join(source, 'index.mjs'), `export async function activate(c) { await c.secrets.set('token','broken-secret'); await c.secrets.set('new','introduced-secret'); throw Error('bad migration'); }`)
 await expect(manager.install(source)).rejects.toThrow('bad migration')
 expect((await manager.invoke('hello.test','say')).message).toBe('original')
 await manager.uninstall('hello.test', true)
 expect(await manager.list()).toEqual([])
})

it('renders registered settings, validates declared fields, and never returns password defaults', async () => {
 const { source, manager, manifest } = await fixture()
 await writeFile(join(source, 'extension.json'), JSON.stringify({ ...manifest, contributes: { forms: [{ id:'settings',title:'Settings',commandId:'say',fields:[{key:'name',label:'Name',type:'text',required:true},{key:'token',label:'Token',type:'password'}] }] } }))
 await writeFile(join(source, 'index.mjs'), `export function activate(c) { c.forms.register('settings',()=>({id:'settings',title:'Settings',commandId:'say',fields:[{key:'name',label:'Name',type:'text',required:true},{key:'token',label:'Token',type:'password'}],values:{token:'never-render'}}));c.commands.register('say',async input=>{await c.storage.set('name',input.name); return {message:input.token ?? input.name};}); }`)
 await manager.install(source); await manager.setEnabled('hello.test', true)
 expect((await manager.forms('hello.test'))[0]?.values).toEqual({})
 await expect(manager.invoke('hello.test','say',{name:42})).rejects.toThrow()
 await expect(manager.invoke('hello.test','say',{name:'Operator',undeclared:true})).rejects.toThrow()
 expect((await manager.invoke('hello.test','say',{name:'Operator'})).message).toBe('Operator')
 expect((await manager.invoke('hello.test','say',{name:'Operator',token:'form-password'})).message).toBe('[REDACTED]')
})

it('refuses an installed artifact modified after approval', async () => {
 const { root, source, manager } = await fixture()
 const record = await manager.install(source)
 const digest = createHash('sha256').update(record.integrity!).digest('hex')
 await writeFile(join(root, 'home/extensions/artifacts/hello.test/1.0.0', digest, 'index.mjs'), 'export function activate() {}')
 await expect(manager.setEnabled('hello.test', true, record.integrity)).rejects.toThrow(/artifact changed/)
 expect((await manager.list())[0]).toMatchObject({ enabled: false, status: 'failed' })
})

it('waits for failed-worker chat teardown before retrying the same provider', async () => {
 const { root, source, manager, manifest } = await fixture()
 const { watchChatExtensions, chatProvider } = await import('../chat/registry.ts')
 await writeFile(join(source, 'extension.json'), JSON.stringify({ ...manifest, contributes: { chatProviders: [{ id:'chat', label:'Chat', credentials:[{name:'token',label:'Token'}], discoveryUrl:'https://chat.example.com', limits:{maxText:4000,buttonsPerMessage:0,perChatPerSecond:1,perBotPerSecond:1} }] } }))
 await writeFile(join(source, 'index.mjs'), `export function activate(c) { c.commands.register('say',()=>process.exit(5)); c.chat.register('chat',()=>({})); }`)
 await manager.install(source); await manager.setEnabled('hello.test', true)
 // An independent cockpit whose worker activation paces the absence check below.
 const pacer = await fixture(); await pacer.manager.install(pacer.source)
 let release!: () => void, entered!: () => void
 const teardown = new Promise<void>(resolve => { entered = resolve })
 const off = watchChatExtensions(root, async () => {
   if (!chatProvider('hello.test/chat', root)) { entered(); await new Promise<void>(resolve => { release = resolve }) }
 })
 try {
   await expect(manager.invoke('hello.test', 'say')).rejects.toThrow(/exit/)
   await teardown
   let retried = false
   const retry = manager.setEnabled('hello.test', true).then(() => { retried = true })
   // A whole worker activation started after the retry finishes while the retry is still held.
   await pacer.manager.setEnabled('hello.test', true)
   expect((await pacer.manager.list())[0]?.status).toBe('running')
   expect(retried).toBe(false)
   release(); await retry
   expect(chatProvider('hello.test/chat', root)).toBeDefined()
 } finally { off(); release?.() }
})
it('isolates concurrent proposals, discards failed proposals and rejects background proposals', async () => {
 const { source, manager, manifest } = await fixture()
 manifest.permissions.push('task.create')
 await writeFile(join(source, 'extension.json'), JSON.stringify(manifest))
 await writeFile(join(source, 'index.mjs'), `export async function activate(c) {
   let backgroundRejected=false;
   try { await c.tasks.propose({title:'Background',prompt:'background'}); } catch {backgroundRejected=true;}
   c.commands.register('say',async input=>{
     if(input?.name) await c.tasks.propose({title:input.name,prompt:input.name});
     if(input?.fail) throw Error('command failed');
     if(input?.delay) await new Promise(r=>setTimeout(r,input.delay));
     return {message:String(backgroundRejected)};
   });
 }`)
 await manager.install(source); await manager.setEnabled('hello.test',true)
 await expect(manager.invoke('hello.test','say',{name:'failed',fail:true})).rejects.toThrow('command failed')
 expect(await manager.invoke('hello.test','say')).toEqual({ok:true,message:'true'})
 const [a,b] = await Promise.all([manager.invoke('hello.test','say',{name:'a',delay:200}),manager.invoke('hello.test','say',{name:'b',delay:30})])
 expect(a.proposals).toEqual([{title:'a',prompt:'a'}]); expect(b.proposals).toEqual([{title:'b',prompt:'b'}])
})
it('keeps consent in a project that was closed during an update, unless the update asks for more', async () => {
 const { root, source, manager, manifest } = await fixture()
 await manager.install(source)
 const closedDir = join(root, 'closed')
 const closed = new ExtensionManager(closedDir, 'closed', root, { home: join(root, 'home') })
 await closed.setEnabled('hello.test', true); await closed.close()
 await writeFile(join(source, 'extension.json'), JSON.stringify({ ...manifest, version: '1.1.0' }))
 await manager.install(source)
 const reopened = new ExtensionManager(closedDir, 'closed', root, { home: join(root, 'home') }); managers.push(reopened)
 expect(await reopened.list()).toMatchObject([{ manifest: { version: '1.1.0' }, enabled: true }])
 await reopened.close()
 await writeFile(join(source, 'extension.json'), JSON.stringify({ ...manifest, version: '1.2.0', permissions: ['project.read', 'task.create'] }))
 await manager.install(source)
 const widened = new ExtensionManager(closedDir, 'closed', root, { home: join(root, 'home') }); managers.push(widened)
 expect(await widened.list()).toMatchObject([{ manifest: { version: '1.2.0' }, enabled: false }])
})
it('forgets a closed registered project approval on uninstall so a reinstall asks again', async () => {
 const { root, source, manager } = await fixture()
 const other = join(root, 'repo2'); const otherData = join(other, '.ai/cezar'); await mkdir(otherData, { recursive: true })
 await mkdir(join(root, 'home'), { recursive: true }); await writeFile(join(root, 'home', 'config.json'), JSON.stringify({ projects: [{ id: 'repo2', root: other, name: 'repo2' }] }))
 await manager.install(source)
 const closed = new ExtensionManager(otherData, 'repo2', other, { home: join(root, 'home') })
 await closed.setEnabled('hello.test', true); await closed.close()
 await manager.uninstall('hello.test')
 await manager.install(source)
 const reopened = new ExtensionManager(otherData, 'repo2', other, { home: join(root, 'home') }); managers.push(reopened)
 expect(await reopened.list()).toMatchObject([{ enabled: false }])
})
it('keeps only the installed artifact after an update and none after uninstall', async () => {
 const { root, source, manager, manifest } = await fixture()
 const { readdir } = await import('node:fs/promises')
 const artifacts = join(root, 'home', 'extensions', 'artifacts', 'hello.test')
 await manager.install(source)
 await writeFile(join(source, 'extension.json'), JSON.stringify({ ...manifest, version: '1.1.0' }))
 await manager.install(source)
 expect(await readdir(artifacts)).toEqual(['1.1.0'])
 await manager.uninstall('hello.test')
 await expect(readdir(artifacts)).rejects.toThrow(/ENOENT/)
})
it('drops consent in every project when a same-id artifact from another source replaces it (M2)', async () => {
 const { root, source, manager } = await fixture()
 const { cp } = await import('node:fs/promises')
 const other = join(root, 'repo2'); const otherData = join(other, '.ai/cezar'); await mkdir(otherData, { recursive: true })
 await mkdir(join(root, 'home'), { recursive: true }); await writeFile(join(root, 'home', 'config.json'), JSON.stringify({ projects: [{ id: 'repo2', root: other, name: 'repo2' }] }))
 await manager.install(source); await manager.setEnabled('hello.test', true)
 const closed = new ExtensionManager(otherData, 'repo2', other, { home: join(root, 'home') })
 await closed.setEnabled('hello.test', true); await closed.close()
 const fork = join(root, 'fork'); await cp(source, fork, { recursive: true })
 await writeFile(join(fork, 'index.mjs'), `export function onAction() { return { message: 'fork code' } }`)
 const preview = await manager.prepare(fork)
 expect(preview.replaces).toEqual({ version: '1.0.0', sourceChanged: true, keepsConsent: false, enabledProjects: 2 })
 await manager.commit(preview.preparedId)
 expect((await manager.list())[0]).toMatchObject({ source: fork, enabled: false, status: 'disabled' })
 await expect(manager.invoke('hello.test', 'say')).rejects.toThrow(/enabled/)
 const reopened = new ExtensionManager(otherData, 'repo2', other, { home: join(root, 'home') }); managers.push(reopened)
 await reopened.restore()
 expect((await reopened.list())[0]).toMatchObject({ enabled: false, status: 'disabled' })
})
it('previews every consent-relevant change of a same-source update (L5)', async () => {
 const { source, manager, manifest } = await fixture()
 await writeFile(join(source, 'extension.json'), JSON.stringify({ ...manifest, capabilities: ['commands', 'panels'] }))
 await manager.install(source); await manager.setEnabled('hello.test', true)
 await writeFile(join(source, 'extension.json'), JSON.stringify({ ...manifest, version: '1.1.0', capabilities: ['commands', 'panels'] }))
 const same = await manager.prepare(source)
 expect(same).toMatchObject({ addedPermissions: [], addedCapabilities: [], replaces: { version: '1.0.0', sourceChanged: false, keepsConsent: true, enabledProjects: 1 } })
 await manager.discard(same.preparedId)
 await writeFile(join(source, 'extension.json'), JSON.stringify({ ...manifest, version: '1.1.0', capabilities: ['commands', 'panels', 'taskEvents'] }))
 const widened = await manager.prepare(source)
 expect(widened).toMatchObject({ addedPermissions: [], addedCapabilities: ['taskEvents'], replaces: { keepsConsent: false, enabledProjects: 1 } })
 expect((await manager.commit(widened.preparedId)).enabled).toBe(false)
 const fresh = await (await fixture()).manager.prepare(source)
 expect(fresh.replaces).toBeUndefined()
 expect(fresh.addedCapabilities).toEqual(['commands', 'panels', 'taskEvents'])
})

it('treats a malformed stored chat credential as a permanent auth failure, not a transient retry (M3)', async () => {
 const { root, source, manager, manifest } = await fixture()
 const { chatTransport } = await import('../chat/registry.ts')
 await writeFile(join(source, 'extension.json'), JSON.stringify({ ...manifest, contributes: { chatProviders: [{ id:'chat', label:'Chat', credentials:[{name:'token',label:'Token',secret:true}], discoveryUrl:'https://chat.example.com', limits:{maxText:4000,buttonsPerMessage:0,perChatPerSecond:1,perBotPerSecond:1} }] } }))
 await writeFile(join(source, 'index.mjs'), `export function activate(c) { c.chat.register('chat', () => ({ identify: async () => ({ id: 'bot', username: 'Bot' }) })); }`)
 await manager.install(source); await manager.setEnabled('hello.test', true)
 await expect(chatTransport(root, 'hello.test/chat', '{"token":"ok"}')!.identify()).resolves.toEqual({ id: 'bot', username: 'Bot' })
 for (const credential of ['not json', '{"token":5}', '[]']) {
  await expect(chatTransport(root, 'hello.test/chat', credential)!.identify()).rejects.toMatchObject({ failure: { kind: 'auth' } })
 }
})
