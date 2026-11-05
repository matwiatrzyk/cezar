import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import { dirname } from 'node:path'
import { extensionManifestSchema, type ExtensionManifest, type ExtensionRpcResponse } from '@open-mercato/cezar-contract'
import { encodeFrame, parseFrame, MAX_PENDING_CALLS } from './rpc.ts'

export type ExtensionInstance = { id: string; manifest: ExtensionManifest; entry: string; projectId: string; generation?: string }
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
const workerSource = `
import readline from 'node:readline';
let ext;
const rl=readline.createInterface({input:process.stdin});
function out(v){const s=JSON.stringify(v);if(Buffer.byteLength(s)>1048576)process.exit(31);process.stdout.write(s+'\\n')}
rl.on('line',async line=>{let m;try{m=JSON.parse(line)}catch{return}if(m.type!=='request')return;
try{if(!ext) ext=await import(m.params.entry); const value=ext.default??ext.extension??ext;
let result;if(m.method==='activate'&&value.activate)result=await value.activate(m.params.context);else if(m.method==='invoke'&&value.onAction)result=await value.onAction(m.params.actionId,m.params.input,m.params.context);else if(m.method==='deactivate'&&value.deactivate)result=await value.deactivate();
out({type:'response',requestId:m.requestId,generation:m.generation,ok:true,result})}catch(e){out({type:'response',requestId:m.requestId,generation:m.generation,ok:false,error:{code:'EXTENSION_ERROR',message:e instanceof Error?e.message:String(e)}})}});` 

export class ExtensionHost {
  private readonly sessions = new Map<string, { process: ChildProcessWithoutNullStreams; pending: Map<string, Pending>; generation: string }>()
  async activate(instance: ExtensionInstance): Promise<void> {
    const manifest = extensionManifestSchema.parse(instance.manifest)
    if (this.sessions.has(instance.id)) return
    const generation = instance.generation ?? randomUUID()
    const child = spawn(process.execPath, ['--input-type=module', '-e', workerSource], { cwd: dirname(instance.entry), env: { NODE_ENV: 'production' }, stdio: ['pipe', 'pipe', 'pipe'] })
    const pending = new Map<string, Pending>(); this.sessions.set(instance.id, { process: child, pending, generation })
    const rl = createInterface({ input: child.stdout });
    rl.on('line', line => { try { const msg = parseFrame(line); if (msg.type === 'ready') return; this.settle(instance.id, msg) } catch { void this.deactivate(instance.id) } })
    const fail = (error: Error) => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error) }; pending.clear(); this.sessions.delete(instance.id) }
    child.once('error', fail); child.once('exit', code => { if (this.sessions.has(instance.id)) fail(new Error(`extension process exited (${code ?? 'unknown'})`)) })
    try { await this.call(instance.id, 'activate', { entry: instance.entry, context: { projectId: instance.projectId, permissions: manifest.permissions } }, 10_000) } catch (error) { await this.deactivate(instance.id); throw error }
  }
  async invoke(instanceId: string, commandId: string, input: unknown): Promise<unknown> { return this.call(instanceId, 'invoke', { actionId: commandId, input }, 30_000) }
  async deactivate(instanceId: string): Promise<void> {
    const session = this.sessions.get(instanceId); if (!session) return
    try { await this.call(instanceId, 'deactivate', {}, 5_000) } catch { /* process is being stopped */ }
    session.process.kill('SIGTERM'); this.sessions.delete(instanceId)
  }
  private call(id: string, method: 'activate'|'invoke'|'deactivate', params: unknown, timeoutMs: number): Promise<unknown> {
    const session = this.sessions.get(id); if (!session) return Promise.reject(new Error('extension is not active'))
    if (session.pending.size >= MAX_PENDING_CALLS) return Promise.reject(new Error('too many pending extension calls'))
    const requestId = randomUUID(); const generation = session.generation
    return new Promise((resolve, reject) => { const timer = setTimeout(() => { session.pending.delete(requestId); reject(new Error('extension RPC timed out')) }, timeoutMs); session.pending.set(requestId, { resolve, reject, timer }); try { session.process.stdin.write(encodeFrame({ type: 'request', requestId, generation, method, params })) } catch (error) { clearTimeout(timer); session.pending.delete(requestId); reject(error instanceof Error ? error : new Error(String(error))) } })
  }
  private settle(id: string, response: ExtensionRpcResponse): void { const session = this.sessions.get(id); if (!session || response.generation !== session.generation) return; const pending = session.pending.get(response.requestId); if (!pending) return; session.pending.delete(response.requestId); clearTimeout(pending.timer); response.ok ? pending.resolve(response.result) : pending.reject(new Error(response.error?.message ?? 'extension call failed')) }
}
