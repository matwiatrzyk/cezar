import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import { extensionManifestSchema, chatFailureSchema, type ExtensionManifest } from '@open-mercato/cezar-contract'
import { extensionRpcResponseSchema, extensionHostRequestSchema } from './protocol.ts'
import { encodeFrame, MAX_FRAME_BYTES, MAX_PENDING_CALLS } from './rpc.ts'
import { workerSource } from './worker-source.ts'

export type ExtensionInstance = { id: string; manifest: ExtensionManifest; entry: string; projectId: string; generation?: string; sanitize?: (value: unknown) => unknown; onFailure?: (error: Error) => void; dispatch?: (method: string, params: unknown, signal: AbortSignal, invocationId?: string) => Promise<unknown>; subscribe?: (listener: (event: unknown) => void) => (() => void) }
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
type Session = { process: ChildProcessWithoutNullStreams; pending: Map<string, Pending>; generation: string; controller: AbortController; stopping: boolean; ready?: Promise<void>; stopped?: Promise<void>; exit: Promise<void>; hostCalls: number; unsubscribe?: () => void }

export class ExtensionHost {
 private readonly sessions = new Map<string, Session>()
 async activate(instance: ExtensionInstance): Promise<void> {
  const existing = this.sessions.get(instance.id)
  if(existing) { if(existing.stopping) throw Error('extension stopped'); return existing.ready }
  const manifest = extensionManifestSchema.parse(instance.manifest)
  const child = spawn(process.execPath, ['--input-type=module', '-e', workerSource], { cwd: dirname(instance.entry), env: { NODE_ENV: 'production' }, stdio: ['pipe', 'pipe', 'pipe'] })
  let exited!: () => void
  const session: Session = { process: child, pending: new Map(), generation: instance.generation ?? randomUUID(), controller: new AbortController(), stopping: false, exit: new Promise(resolve => {exited=resolve}), hostCalls: 0 }
  this.sessions.set(instance.id, session)
  let stderrTail = ''
  child.stderr.on('data', (chunk: Buffer) => { stderrTail = (stderrTail + chunk.toString('utf8')).slice(-4096) })
  child.once('exit', code => { if (!session.stopping && stderrTail.trim()) console.error(`[extension ${instance.id}] worker exited (${code ?? 'signal'}); last stderr:\n${stderrTail.trim()}`) })
  const fail = (error: Error) => {session.unsubscribe?.(); session.controller.abort(); this.rejectPending(session,error); if(this.sessions.get(instance.id)===session) { this.sessions.delete(instance.id); if(!session.stopping) instance.onFailure?.(error) }}
  child.once('error', error => {fail(error);exited()})
  child.once('exit', () => {fail(Error('extension process exited'));exited()})
  child.stdin.on('error', () => {fail(Error('extension IPC closed'));child.kill('SIGKILL')})
  let buffer = Buffer.alloc(0)
  child.stdout.on('data', (chunk: Buffer) => {
   buffer=Buffer.concat([buffer,chunk]); let end: number
   try {
    while((end=buffer.indexOf(10))!==-1) {
     if(end>MAX_FRAME_BYTES) throw Error('extension IPC frame exceeds 1 MiB')
     const raw: unknown=JSON.parse(buffer.subarray(0,end).toString());buffer=buffer.subarray(end+1)
     const request=extensionHostRequestSchema.safeParse(raw)
     if(request.success) {
      const message=request.data
      if(session.stopping || message.generation!==session.generation)continue
      if(++session.hostCalls>MAX_PENDING_CALLS) throw Error('too many pending host calls')
      void Promise.resolve().then(async()=>{
       if(session.controller.signal.aborted)throw Error('extension stopped')
       if(!instance.dispatch)throw Error('host operation unavailable')
       return instance.dispatch(message.method,message.params,session.controller.signal,message.invocationId)
      }).then(result=>this.respond(session,message.requestId,{ok:true,result}),()=>this.respond(session,message.requestId,{ok:false,error:{code:'HOST_ERROR',message:'Host operation failed or access denied'}})).finally(()=>{session.hostCalls--})
     } else {
      // Invalid optional provider diagnostics must not invalidate an otherwise valid RPC error.
      if (raw && typeof raw === 'object' && 'error' in raw && raw.error && typeof raw.error === 'object' && 'failure' in raw.error && !chatFailureSchema.safeParse(raw.error.failure).success) delete raw.error.failure
      const response=extensionRpcResponseSchema.parse(raw)
      if(response.generation!==session.generation)continue
      const pending=session.pending.get(response.requestId);if(!pending)continue
      session.pending.delete(response.requestId);clearTimeout(pending.timer)
      response.ok?pending.resolve(instance.sanitize ? instance.sanitize(response.result) : response.result):pending.reject(Object.assign(Error(String(instance.sanitize ? instance.sanitize(response.error?.message??'extension call failed') : response.error?.message??'extension call failed')), response.error?.failure ? { failure: response.error.failure } : {}))
     }
    }
    if(buffer.length>MAX_FRAME_BYTES)throw Error('extension IPC frame exceeds 1 MiB')
   } catch(error) {fail(error instanceof Error?error:Error('invalid IPC'));child.kill('SIGKILL')}
  })
  let resyncPending = false
  const publish = (event: unknown) => {
    if (session.stopping || session.controller.signal.aborted) return
    if (child.stdin.writableNeedDrain) { resyncPending = true; return }
    try { child.stdin.write(encodeFrame({ type: 'event', generation: session.generation, event })) }
    catch { child.kill('SIGKILL') }
  }
  child.stdin.on('drain', () => { if (resyncPending) { resyncPending = false; publish({ type: 'resyncRequired' }) } })
  session.ready = this.call(session, 'activate', { entry: instance.entry, manifest, context: { projectId: instance.projectId, permissions: manifest.permissions } }, 10_000)
    .then(() => { session.unsubscribe = instance.subscribe?.(publish) })
    .catch(async error => { await this.deactivate(instance.id); throw error })
  return session.ready
 }
 private respond(session: Session, requestId: string, response: Record<string,unknown>) {
  if(session.controller.signal.aborted)return
  try {session.process.stdin.write(encodeFrame({type:'hostResponse',requestId,generation:session.generation,...response}))}catch {session.process.kill('SIGKILL')}
 }
 async invoke(id: string, actionId: string, input: unknown, invocationId?: string): Promise<unknown> {const session=await this.active(id);return this.call(session,'invoke',{actionId,input,invocationId},30_000)}
 async panel(id: string, panelId: string): Promise<unknown> {const session=await this.active(id);return this.call(session,'panel',{panelId},30_000)}
 async form(id: string, formId: string): Promise<unknown> {const session=await this.active(id);return this.call(session,'form',{formId},30_000)}
 async chat(id: string, params: unknown): Promise<unknown> {const session=await this.active(id);return this.call(session,'chat',params,30_000)}
 private async active(id: string) {const session=this.sessions.get(id);if(!session||session.stopping)throw Error('extension is not active');await session.ready;if(session.stopping||this.sessions.get(id)!==session)throw Error('extension is not active');return session}
 async deactivate(id: string): Promise<void> {
  const session=this.sessions.get(id);if(!session)return
  if(session.stopped)return session.stopped
  session.stopping=true;session.unsubscribe?.();session.controller.abort();this.rejectPending(session,Error('extension stopped'))
  session.stopped=(async()=>{
   const deadline=setTimeout(()=>session.process.kill('SIGKILL'),5_000)
   try {await this.call(session,'deactivate',{},5_000)}catch {/* force stop at deadline */}
   session.process.kill('SIGTERM');await session.exit;clearTimeout(deadline)
   if(this.sessions.get(id)===session)this.sessions.delete(id)
  })()
  return session.stopped
 }
 private rejectPending(session: Session,error: Error){for(const pending of session.pending.values()){clearTimeout(pending.timer);pending.reject(error)}session.pending.clear()}
 private call(session: Session, method: string, params: unknown, timeout: number): Promise<unknown> {
  if(session.pending.size>=MAX_PENDING_CALLS)return Promise.reject(Error('too many pending extension calls'))
  const requestId=randomUUID()
  return new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>{session.pending.delete(requestId);reject(Error('extension RPC timed out'));if(method!=='deactivate')session.process.kill('SIGKILL')},timeout)
   session.pending.set(requestId,{resolve,reject,timer})
   try{session.process.stdin.write(encodeFrame({type:'request',requestId,generation:session.generation,method,params}))}catch(error){clearTimeout(timer);session.pending.delete(requestId);reject(error)}
  })
 }
}
