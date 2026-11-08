import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { extensionManifestSchema } from '@open-mercato/cezar-contract'
import { ExtensionHost } from './host.ts'
const roots: string[] = []
const hosts: ExtensionHost[] = []
afterEach(async () => { for (const host of hosts) await host.deactivate('test'); for (const root of roots) await rm(root, { recursive: true, force: true }) })
async function fixture(code: string) {
 const root = await mkdtemp(join(tmpdir(), 'extension-host-')); roots.push(root)
 const entry = join(root, 'index.mjs'); await writeFile(entry, code)
 const host = new ExtensionHost(); hosts.push(host)
 const manifest = extensionManifestSchema.parse({ id: 'test', name: 'Test', version: '1', apiVersion: '0.1', entry: 'index.mjs', actions: [{ id: 'read', label: 'Read' }], panels: [{ id: 'summary', title: 'Summary' }] })
 return { host, instance: { id: 'test', manifest, entry, projectId: 'project-a' } }
}
it('provides the project host API to registered commands across process IPC', async () => {
 const { host, instance } = await fixture(`export default { activate(context) { context.commands.register('read', async () => ({ message: JSON.stringify(await context.tasks.list()) })); } }`)
 await host.activate({ ...instance, dispatch: async (method: string) => { if (method === 'tasks.list') return [{ id: 'a' }]; throw Error('unknown') } })
 await expect(host.invoke('test', 'read', {})).resolves.toEqual({ message: '[{"id":"a"}]' })
})
it('hands a task-located panel the host-asserted runId and a V1 panel nothing at all (V1.1)', async () => {
 const { host, instance } = await fixture(`export default { activate(context) { context.panels.register('summary', (...args) => ({ id: 'summary', title: JSON.stringify(args) })); } }`)
 await host.activate(instance)
 await expect(host.panel('test', 'summary')).resolves.toEqual({ id: 'summary', title: '[]' })
 await expect(host.panel('test', 'summary', 'run-1')).resolves.toEqual({ id: 'summary', title: '[{"runId":"run-1"}]' })
 await expect(host.panel('test', 'summary', '../escape')).rejects.toThrow()
})
it('folds the host-asserted runId into a command input, for registered and legacy handlers (V1.1)', async () => {
 const { host, instance } = await fixture(`export default { activate(context) { context.commands.register('read', async input => ({ message: JSON.stringify(input ?? null) })); } }`)
 await host.activate(instance)
 await expect(host.invoke('test', 'read', { a: 1 })).resolves.toEqual({ message: '{"a":1}' })
 await expect(host.invoke('test', 'read', undefined)).resolves.toEqual({ message: 'null' })
 await expect(host.invoke('test', 'read', { a: 1 }, undefined, 'run-1')).resolves.toEqual({ message: '{"a":1,"runId":"run-1"}' })
 await expect(host.invoke('test', 'read', undefined, undefined, 'run-1')).resolves.toEqual({ message: '{"runId":"run-1"}' })
 const legacy = await fixture(`export function onAction(id, input) { return { message: JSON.stringify(input) }; }`)
 await legacy.host.activate(legacy.instance)
 await expect(legacy.host.invoke('test', 'read', {}, undefined, 'run-2')).resolves.toEqual({ message: '{"runId":"run-2"}' })
})
it('retains context for legacy onAction handlers', async () => {
 const { host, instance } = await fixture(`export function onAction(id, input, context) { return { message: context.projectId }; }`)
 await host.activate(instance)
 await expect(host.invoke('test', 'read', {})).resolves.toEqual({ message: 'project-a' })
})
it('rejects pending calls promptly when disabled and rejects future calls', async () => {
 const { host, instance } = await fixture(`export async function onAction(id, input, context) { await context.logger.info('started'); return new Promise(() => {}); }`)
 let started!: () => void
 const running = new Promise<void>(resolve => { started = resolve })
 await host.activate({ ...instance, dispatch: async () => { started(); return null } })
 const pending = expect(host.invoke('test', 'read', {})).rejects.toThrow(/stopp|disabled/)
 await running
 await Promise.all([host.deactivate('test'), pending])
 await expect(host.invoke('test', 'read', {})).rejects.toThrow(/active/)
})
it('rejects undeclared registrations at activation', async () => {
 const { host, instance } = await fixture(`export default { activate(context) { context.commands.register('undeclared', () => {}); } }`)
 await expect(host.activate(instance)).rejects.toThrow(/declared/)
})
it('delivers task events to a worker and releases its host subscription on disable', async () => {
 const { host, instance } = await fixture(`let resolveEvent; const event = new Promise(resolve => { resolveEvent = resolve }); export function activate(context) { context.taskEvents.subscribe(resolveEvent); context.commands.register('read', async () => ({ message: (await event).type })); }`)
 let listener: ((event: unknown) => void) | undefined
 let released = false
 await host.activate({ ...instance, subscribe: callback => { listener = callback; return () => { released = true; listener = undefined } } })
 const result = host.invoke('test', 'read', {})
 listener?.({ type: 'updated' })
 await expect(result).resolves.toEqual({ message: 'updated' })
 await host.deactivate('test')
 expect(released).toBe(true)
 expect(listener).toBeUndefined()
})
it('drops malformed provider failure details without terminating the worker', async () => {
 const { host, instance } = await fixture(`export function onAction(id,input){if(input.fail)throw Object.assign(Error('provider refused'),{failure:{kind:'rate_limited',retryAfterMs:0}});return {message:'alive'};}`)
 await host.activate(instance)
 await expect(host.invoke('test','read',{fail:true})).rejects.toThrow('provider refused')
 await expect(host.invoke('test','read',{})).resolves.toEqual({message:'alive'})
})
it('retries an adapter factory after a transient asynchronous rejection', async () => {
 const { host, instance } = await fixture(`export function activate(c){let attempt=0;c.chat.register('chat',async()=>{if(++attempt===1)throw Error('temporary');return {identify:async()=>({id:'bot',username:'Bot'})}});}`)
 instance.manifest = extensionManifestSchema.parse({...instance.manifest, capabilities:['commands','panels','chatProviders'], contributes:{chatProviders:[{id:'chat',label:'Chat',credentials:[{name:'token',label:'Token'}],discoveryUrl:'https://example.com',limits:{maxText:1000,buttonsPerMessage:0,perChatPerSecond:1,perBotPerSecond:1}}]}})
 await host.activate(instance)
 const call = {providerId:'chat',credential:'{"token":"test"}',operation:'identify',input:{}}
 await expect(host.chat('test',call)).rejects.toThrow('temporary')
 await expect(host.chat('test',call)).resolves.toEqual({id:'bot',username:'Bot'})
})
it('answers an oversized host reply with an error instead of killing the worker (L1)', async () => {
 const { host, instance } = await fixture(`export default { activate(context) { context.commands.register('read', async () => { try { await context.tasks.list() } catch (e) { return { message: e.message } } return { message: 'listed' } }); } }`)
 await host.activate({ ...instance, dispatch: async () => 'x'.repeat(2 * 1024 * 1024) })
 await expect(host.invoke('test', 'read', {})).resolves.toEqual({ message: 'Host response exceeds the IPC frame limit' })
 await expect(host.invoke('test', 'read', {})).resolves.toBeDefined()
})
it('survives stray stdout writes from extension code (L3)', async () => {
 const { host, instance } = await fixture(`process.stdout.write('loading\\n'); export default { activate(context) { process.stdout.write('{"not":"rpc"}\\n'); context.commands.register('read', async () => { process.stdout.write('progress 50%\\n'); return { message: 'still alive' } }); } }`)
 await host.activate(instance)
 await expect(host.invoke('test', 'read', {})).resolves.toEqual({ message: 'still alive' })
})
it('gives extension workers the same proxy/CA allowlist as bundled workers, never other env (M4)', async () => {
 const saved = { proxy: process.env.HTTPS_PROXY, secret: process.env.CEZ_TEST_SECRET }
 process.env.HTTPS_PROXY = 'http://proxy:3128'; process.env.CEZ_TEST_SECRET = 'nope'
 try {
  const { host, instance } = await fixture(`export function onAction() { return { message: JSON.stringify([process.env.HTTPS_PROXY, process.env.CEZ_TEST_SECRET ?? null]) }; }`)
  await host.activate(instance)
  await expect(host.invoke('test', 'read', {})).resolves.toEqual({ message: '["http://proxy:3128",null]' })
 } finally {
  if (saved.proxy === undefined) delete process.env.HTTPS_PROXY; else process.env.HTTPS_PROXY = saved.proxy
  if (saved.secret === undefined) delete process.env.CEZ_TEST_SECRET; else process.env.CEZ_TEST_SECRET = saved.secret
 }
})
it('a worker that dies during activation only rejects activate, never reports a failure too', async () => {
 const { host, instance } = await fixture(`process.exit(4)`)
 const failures: Error[] = []
 await expect(host.activate({ ...instance, onFailure: error => { failures.push(error) } })).rejects.toThrow(/exit/)
 expect(failures).toEqual([])
})
it('reports an unexpected exit after activation', async () => {
 const { host, instance } = await fixture(`export function onAction() { process.exit(6) }`)
 const failures: Error[] = []
 await host.activate({ ...instance, onFailure: error => { failures.push(error) } })
 await expect(host.invoke('test', 'read', {})).rejects.toThrow(/exit/)
 await expect.poll(() => failures.length).toBe(1)
})
it('redacts remembered secrets from both stdout and stderr crash diagnostics', async () => {
 const { host, instance } = await fixture(`export async function onAction(id,input,c) { const secret=await c.secrets.get('token'); process.stdout.write('stdout '+secret+'\\n'); process.stderr.write('stderr '+secret+'\\n',()=>process.exit(7)); return new Promise(()=>{}); }`)
 const secret = 'synthetic-crash-secret-98234'
 const logs: string[] = []
 const original = console.error
 console.error = (...args) => { logs.push(args.join(' ')) }
 try {
  await host.activate({ ...instance, dispatch: async () => secret, sanitize: value => typeof value === 'string' ? value.replaceAll(secret, '[REDACTED]') : value })
  await expect(host.invoke('test', 'read', {})).rejects.toThrow(/exit/)
  expect(logs.join('\n')).toContain('[REDACTED]')
  expect(logs.join('\n')).not.toContain(secret)
 } finally { console.error = original }
})
it.each(['abort', 'revoke'])('fences a real adapter delayed wire effect after %s', async mode => {
 const { host, instance } = await fixture(`export function activate(c) {
 let release; const gate=new Promise(r=>release=r);
 c.commands.register('read',()=>{release();return {message:'released'}});
 c.chat.register('chat',()=>({send:async(chatId,message,operation)=>{
   await c.logger.info('preparing'); await gate;
   await operation?.assertActive();
   operation?.signal.throwIfAborted();
   await c.storage.set('wire-effect',message.text);
   return {chatId,messageId:'sent'};
 }})); }`)
 instance.manifest = extensionManifestSchema.parse({...instance.manifest,capabilities:['commands','panels','chatProviders'],contributes:{chatProviders:[{id:'chat',label:'Chat',credentials:[{name:'token',label:'Token'}],discoveryUrl:'https://example.com',limits:{maxText:1000,buttonsPerMessage:0,perChatPerSecond:1,perBotPerSecond:1}}]}})
 let started!:()=>void
 const preparing = new Promise<void>(r=>{started=r})
 const effects: unknown[] = []
 const controller=new AbortController()
 let valid=true
 await host.activate({...instance,dispatch:async(method,params)=>{if(method==='logger.info')started();if(method==='storage.set')effects.push(params);return null}})
 const pending=host.chat('test',{providerId:'chat',credential:'{}',operation:'send',input:{chatId:'room',message:{text:'private'}}},{signal:controller.signal,valid:()=>valid}).catch(error=>error)
 await preparing
 if(mode==='abort')controller.abort();else valid=false
 await host.invoke('test','read',{})
 const result=await pending
 expect(result).toBeInstanceOf(Error)
 // The command releases preparation; give the worker's host call a complete IPC round trip.
 await host.invoke('test','read',{})
 expect(effects).toEqual([])
})
