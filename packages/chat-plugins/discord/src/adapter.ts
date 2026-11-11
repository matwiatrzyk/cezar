import { ExtensionChatError, type ChatReceiveSession, type ChatMessage, type ChatReceipt, type ExtensionChatAdapter, type ExtensionChatBatch, type ExtensionChatOperationContext } from '@open-mercato/cezar-extension-sdk/chat'
import { Agent, request as undiciRequest } from 'undici'
import { lookup as dnsLookup } from 'node:dns/promises'
import WebSocket from 'ws'
import { z } from 'zod'
import { channelIdentity, parseChat, snowflake } from './identity.js'
import { discordChannelMember } from './membership.js'
import { MAX_RESPONSE_BYTES as MAX, pinPublicAddress, pinnedConnect, publicTarget, readCapped, type Address, type Lookup } from './pinned-request.js'

type Json = Record<string, unknown>
const obj = (v: unknown): Json | undefined => v && typeof v === 'object' && !Array.isArray(v) ? v as Json : undefined
const fail = (kind: 'auth'|'conflict'|'rate_limited'|'gone'|'transient'|'blocked', retryAfterMs?: number) => new ExtensionChatError({ kind, ...(retryAfterMs ? { retryAfterMs } : {}) })
const MAX_QUEUE = 256, MAX_QUEUE_BYTES = 4 * MAX, MAX_RECEIPTS = 256, TOKEN_TTL = 15 * 60 * 1000
export type DiscordRequestOptions = { lookup?: Lookup; request?: typeof undiciRequest }
export function discordRequest(token: string, options: DiscordRequestOptions = {}) {
 return async (method: string, path: string, body?: unknown, operation?: ExtensionChatOperationContext) => {
  await operation?.assertActive(); operation?.signal.throwIfAborted(); const controller = new AbortController(); const abort = () => controller.abort(); operation?.signal.addEventListener('abort', abort, { once: true }); let dispatcher: Agent | undefined
  try {
   const target = await pinPublicAddress('discord.com', options.lookup ?? (async h => dnsLookup(h, { all: true, verbatim: true })), controller.signal, 10000, fail); dispatcher = new Agent({ connect: pinnedConnect(target) })
   await operation?.assertActive(); operation?.signal.throwIfAborted(); const timer = setTimeout(abort, 10000); const response = await (options.request ?? undiciRequest)(`https://discord.com/api/v10${path}`, { method: method as any, dispatcher, signal: controller.signal, headersTimeout: 10000, bodyTimeout: 10000, headers: { authorization: `Bot ${token}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); const received = await readCapped(response.body, fail); clearTimeout(timer); let data: unknown; try { data = received.length ? JSON.parse(received.toString()) : undefined } catch { throw fail('transient') }
   if (response.statusCode === 429) { const retry = Number(obj(data)?.retry_after); throw fail('rate_limited', Number.isFinite(retry) ? retry * 1000 : 5000) } if (response.statusCode === 401) throw fail('auth'); if (response.statusCode === 404) throw fail('gone'); if (response.statusCode === 403) throw fail('blocked'); if (response.statusCode >= 500) throw fail('transient'); if (response.statusCode >= 400) throw fail('blocked'); return data
  } catch (e) { if (e instanceof ExtensionChatError) throw e; if (operation?.signal.aborted || controller.signal.aborted) throw fail('blocked'); throw fail('transient') } finally { operation?.signal.removeEventListener('abort', abort); await dispatcher?.close().catch(() => undefined) }
 }
}

const messageSchema = z.object({ id: snowflake, channel_id: snowflake, guild_id: snowflake.optional(), author: z.object({ id: snowflake, username: z.string(), bot: z.boolean().optional() }), content: z.string().max(65536), timestamp: z.string(), message_reference: z.object({ message_id: snowflake.optional(), channel_id: snowflake.optional() }).optional(), referenced_message: z.object({ id: snowflake, channel_id: snowflake, author: z.object({ id: snowflake, username: z.string(), bot: z.boolean().optional() }) }).nullable().optional() })
const frameSchema = z.object({ op: z.number().int(), d: z.unknown().optional(), s: z.number().int().nonnegative().nullable().optional(), t: z.string().nullable().optional() })
const interactionSchema = z.object({ id: snowflake, application_id: snowflake, type: z.union([z.literal(2), z.literal(3), z.literal(4)]), token: z.string().min(1).max(2048), channel_id: snowflake, guild_id: snowflake.optional(), user: z.object({ id: snowflake, username: z.string(), bot: z.boolean().optional() }).optional(), member: z.object({ user: z.object({ id: snowflake, username: z.string(), bot: z.boolean().optional() }) }).optional(), data: z.object({ custom_id: z.string().min(1).max(128).optional(), name: z.string().min(1).max(32).optional(), options: z.array(z.object({ name: z.string(), focused: z.boolean().optional(), value: z.union([z.string(), z.number(), z.boolean()]) })).optional() }).optional(), message: z.object({ id: snowflake, channel_id: snowflake, author: z.object({ id: snowflake, bot: z.boolean().optional() }) }).optional() })
export type DiscordSocketFactory = (url: string, options?: { lookup?: (...args: any[]) => void }) => WebSocket
export function createDiscordAdapter(credentials: Record<string, string>, request = discordRequest(credentials.token ?? ''), socket?: DiscordSocketFactory, gatewayLookup: (host: string, signal?: AbortSignal) => Promise<Address[]> = async h => dnsLookup(h, { all: true, verbatim: true }), reportTerminal: (message: string) => Promise<void> = async message => { console.error(message) }): ExtensionChatAdapter {
 let receiveContext: ChatReceiveSession | undefined
 let botId = ''; let gatewaySequence = 0; let deliverySequence = 0; let pending: ExtensionChatBatch | undefined; let queueBytes = 0; let ws: WebSocket | undefined; let disposed = false; const lifecycle = new AbortController(); let gatewayUrl = ''; let sessionId: string | undefined; const queue: Json[] = []; const interactionTokens = new Map<string, { token: string; applicationId: string; expiresAt: number; command: boolean }>(); let wake: (() => void) | undefined; let heartbeat: ReturnType<typeof setTimeout> | undefined; let heartbeatAck = true
 // State follows the bounded raw queue, not the shorter-lived reply-token cache.
 // Weak keys cannot retain consumed records, and platform payload fields cannot forge it.
 const conversion = new WeakMap<Json, { deferredUntil?: number; terminal?: 'gone' | 'expired' }>()
 const stateFor = (raw: Json) => { let state = conversion.get(raw); if (!state) { state = {}; conversion.set(raw, state) } return state }
 const pruneTokens = () => { for (const [id, receipt] of interactionTokens) if (receipt.expiresAt <= Date.now()) interactionTokens.delete(id) }
 const defer = async (raw: Json, data: z.infer<typeof interactionSchema>, type: 5 | 6, op?: ExtensionChatOperationContext) => {
  pruneTokens()
  const state = stateFor(raw)
  if (state.deferredUntil !== undefined) {
   if (state.deferredUntil <= Date.now()) { state.terminal = 'expired'; throw fail('gone') }
   return
  }
  const id = `interaction:${data.id}`
  const existing = interactionTokens.get(id)
  if (existing) { state.deferredUntil = existing.expiresAt; return }
  // Never evict a live receipt or acknowledge work we cannot retain.
  if (interactionTokens.size >= MAX_RECEIPTS) throw fail('rate_limited', 60000)
  await invoke('POST', `/interactions/${data.id}/${data.token}/callback`, { type, ...(type === 5 ? { data: { flags: 64 } } : {}) }, op)
  state.deferredUntil = Date.now() + TOKEN_TTL
  interactionTokens.set(id, { token: data.token, applicationId: data.application_id, expiresAt: state.deferredUntil, command: type === 5 })
 }
 const invoke = (m: string, p: string, b?: unknown, op?: ExtensionChatOperationContext) => request(m, p, b, op)
 const chat = async (id: string, op?: ExtensionChatOperationContext) => { const parsed = parseChat(id); const actual = channelIdentity(await invoke('GET', `/channels/${parsed.channel}`, undefined, op)); if (actual.id !== id) throw fail('blocked'); return actual }
 const validGateway = (value: string) => { let u: URL; try { u = new URL(value) } catch { throw fail('blocked') } if (u.protocol !== 'wss:' || !/^gateway(?:-[a-z0-9-]+)?\.discord\.gg$/.test(u.hostname) || u.port || u.username || u.password || u.pathname !== '/') throw fail('blocked'); u.search = '?v=10&encoding=json'; return u.toString() }
 const connect = async (op?: ExtensionChatOperationContext) => {
  if (!gatewayUrl) { const gateway = obj(await invoke('GET', '/gateway/bot', undefined, op))?.url; if (typeof gateway !== 'string') throw fail('blocked'); gatewayUrl = validGateway(gateway) }
  const host = new URL(gatewayUrl).hostname; const lookupController = new AbortController(); let timedOut = false; let lookupTimer: ReturnType<typeof setTimeout> | undefined
  const abortLookup = () => lookupController.abort(); const rejectLookup = (reject: (error: unknown) => void) => { lookupController.abort(); reject(fail(timedOut ? 'transient' : 'blocked')) }
  if (disposed || lifecycle.signal.aborted || op?.signal.aborted) throw fail('blocked')
  lifecycle.signal.addEventListener('abort', abortLookup, { once: true }); op?.signal.addEventListener('abort', abortLookup, { once: true })
  let addresses: Address[]
  try {
   addresses = await new Promise<Address[]>((resolve, reject) => {
   const onAbort = () => rejectLookup(reject)
   lookupController.signal.addEventListener('abort', onAbort, { once: true })
    if (lifecycle.signal.aborted || op?.signal.aborted) return onAbort()
    lookupTimer = setTimeout(() => { timedOut = true; onAbort() }, 10000)
    Promise.resolve().then(() => gatewayLookup(host, lookupController.signal)).then(resolve, reject)
   })
  } finally { if (lookupTimer) clearTimeout(lookupTimer); lifecycle.signal.removeEventListener('abort', abortLookup); op?.signal.removeEventListener('abort', abortLookup) }
  const target = publicTarget(addresses, fail); heartbeatAck = true
  const { lookup } = pinnedConnect(target)
  ws = (socket ?? ((u, options) => new WebSocket(u, { handshakeTimeout: 10000, maxPayload: MAX, lookup: options?.lookup as any })))(gatewayUrl, { lookup }); const connection = ws; let accepting = true; let settled = false; let graceful = false; let timer: ReturnType<typeof setTimeout>;
  await new Promise<void>((resolve, reject) => {
   const finish = (error?: unknown) => { if (settled) return; settled = true; clearTimeout(timer); if (error) reject(error); else resolve() }
   timer = setTimeout(() => { ws?.terminate(); finish(fail('transient')) }, 15000)
   ws!.once('open', () => {})
   ws!.on('error', () => finish(fail('transient')))
   ws!.on('close', () => { accepting = false; if (ws === connection) ws = undefined; clearTimeout(heartbeat); wake?.(); wake = undefined; if (!settled) finish(graceful ? undefined : fail('transient')) })
   ws!.on('message', raw => { if (!accepting) return; let frame: z.infer<typeof frameSchema>; try { frame = frameSchema.parse(JSON.parse(raw.toString())) } catch { finish(fail('blocked')); return }
    // Stop before consuming the overflowing dispatch; RESUME replays from the retained prefix.
    const bytes = Buffer.byteLength(raw.toString())
    if (frame.op === 0 && frame.t !== 'READY' && frame.t !== 'RESUMED' &&
      (queue.length >= MAX_QUEUE || queueBytes + bytes > MAX_QUEUE_BYTES)) {
     accepting = false; graceful = true; connection.terminate(); return
    }
    if (frame.s != null && Number.isSafeInteger(frame.s)) gatewaySequence = frame.s
    if (frame.op === 11) { heartbeatAck = true; return }
    if (frame.op === 1) { ws?.send(JSON.stringify({ op: 1, d: gatewaySequence })); return }
    if (frame.op === 10) { const hello = z.object({ heartbeat_interval: z.number().int().min(100).max(120000) }).safeParse(frame.d); if (!hello.success) return finish(fail('blocked')); const beat = () => { if (!heartbeatAck) { ws?.terminate(); return } heartbeatAck = false; ws?.send(JSON.stringify({ op: 1, d: gatewaySequence })); heartbeat = setTimeout(beat, hello.data.heartbeat_interval) }; clearTimeout(heartbeat); heartbeat = setTimeout(beat, Math.random() * hello.data.heartbeat_interval); ws?.send(JSON.stringify({ op: sessionId ? 6 : 2, d: sessionId ? { token: credentials.token, session_id: sessionId, seq: gatewaySequence } : { token: credentials.token, intents: 1 | 512 | 4096 | 32768, properties: { os: 'cezar', browser: 'cezar', device: 'cezar' } } })); return }
    if (frame.op === 7 || frame.op === 9) { if (frame.op === 9 && frame.d !== true) { sessionId = undefined; gatewaySequence = 0 } graceful = true; ws?.close(); return }
    if (frame.op === 0 && frame.t === 'READY') { const user = obj(obj(frame.d)?.user); const sid = obj(frame.d)?.session_id; if (typeof user?.id !== 'string' || user.bot !== true || typeof sid !== 'string') return finish(fail('auth')); botId = user.id; sessionId = sid; const resume = obj(frame.d)?.resume_gateway_url; if (typeof resume === 'string') gatewayUrl = validGateway(resume); clearTimeout(timer); finish(); return }
    if (frame.op === 0 && frame.t === 'RESUMED') { clearTimeout(timer); finish(); return }
    if (frame.op === 0) { const data = obj(frame.d) ?? {}; queue.push({ ...data, __type: frame.t, __bytes: bytes }); queueBytes += bytes; wake?.(); wake = undefined }
   })
  })
 }
 const next = async (op?: ExtensionChatOperationContext): Promise<Json | undefined> => {
  const deadline = Date.now() + 24000
  await op?.assertActive()
  op?.signal.throwIfAborted()
  if (disposed) throw fail('blocked')
  if (queue.length) return queue[0]
  if (!ws) await connect(op)
  if (disposed || op?.signal.aborted) throw fail('blocked')
  // READY and the first dispatch can arrive in the same turn; never wait after it is queued.
  if (queue.length) return queue[0]
  const remaining = deadline - Date.now()
  if (remaining <= 0) return undefined
  await new Promise<void>((resolve, reject) => {
   let done = false
   const finish = (error?: unknown) => {
    if (done) return
    done = true
    clearTimeout(timer)
    op?.signal.removeEventListener('abort', abort)
    lifecycle.signal.removeEventListener('abort', abort)
    if (wake === onWake) wake = undefined
    error ? reject(error) : resolve()
   }
   const abort = () => finish(fail('blocked'))
   const onWake = () => finish()
   const timer = setTimeout(onWake, remaining)
   wake = onWake
   op?.signal.addEventListener('abort', abort, { once: true })
   lifecycle.signal.addEventListener('abort', abort, { once: true })
   if (disposed || op?.signal.aborted) abort()
  })
  if (disposed || op?.signal.aborted) throw fail('blocked')
  return queue[0]
 }
 const convert = async (raw: Json, sequence: number, op?: ExtensionChatOperationContext): Promise<ExtensionChatBatch> => { const type = raw.__type; if (type === 'INTERACTION_CREATE') { const parsed = interactionSchema.safeParse(raw); const user = parsed.success ? parsed.data.member?.user ?? parsed.data.user : undefined; if (parsed.success && user && !user.bot && parsed.data.application_id === botId) {
    if (parsed.data.type === 4 && parsed.data.data?.name === 'tasks') {
     let choices: {name:string,value:string}[] = []
     const focused = parsed.data.data.options?.find(option => option.focused && option.name === 'task')
     if (receiveContext && focused && String(focused.value).length <= 128) {
      const session = receiveContext
      let timer: ReturnType<typeof setTimeout> | undefined
      const lookup = async () => {
       const interaction = await session.openInteraction({kind:'task-autocomplete',eventId:`interaction:${parsed.data.id}`,chat:{id:`discord:${parsed.data.guild_id ? `guild:${parsed.data.guild_id}:${parsed.data.channel_id}` : `dm:${parsed.data.channel_id}`}`,kind:parsed.data.guild_id ? 'group' : 'private'},user:{id:user.id,label:user.username},at:Date.now()})
       try { return await interaction.taskChoices(String(focused.value)) } finally { await interaction.dispose() }
      }
      try { choices = await Promise.race([lookup(),new Promise<never>((_,reject) => {timer=setTimeout(()=>reject(Error('autocomplete deadline')),1000)})]) } catch {} finally { clearTimeout(timer) }
     }
     await op?.assertActive()
     await invoke('POST',`/interactions/${parsed.data.id}/${parsed.data.token}/callback`,{type:8,data:{choices}},op)
     return [{sequence}]
    }
    if (parsed.data.type === 3 && parsed.data.data?.custom_id && parsed.data.message?.author.id === botId && parsed.data.message.channel_id === parsed.data.channel_id) {
     await defer(raw, parsed.data, 6, op)
     const c = await chat(`discord:${parsed.data.guild_id ? `guild:${parsed.data.guild_id}:${parsed.data.channel_id}` : `dm:${parsed.data.channel_id}`}`, op)
     return [{ sequence, event: { kind: 'button', id: `interaction:${parsed.data.id}`, chat: { id: c.id, kind: c.kind }, user: { id: user.id, label: user.username, username: user.username }, receipt: { chatId: c.id, messageId: parsed.data.message.id }, data: parsed.data.data.custom_id } }]
    }
    if (parsed.data.type === 2 && parsed.data.data?.name === 'tasks') {
     await defer(raw, parsed.data, 5, op)
     const c = await chat(`discord:${parsed.data.guild_id ? `guild:${parsed.data.guild_id}:${parsed.data.channel_id}` : `dm:${parsed.data.channel_id}`}`, op)
     const argument = parsed.data.data.options?.find(option => option.name === 'task')?.value
     const text = typeof argument === 'string' && argument ? `/status ${argument}` : '/tasks'
     return [{ sequence, event: { kind: 'message', id: `interaction:${parsed.data.id}`, chat: { id: c.id, kind: c.kind }, user: { id: user.id, label: user.username, username: user.username }, at: Date.now(), messageId: parsed.data.id, text, addressed: true } }]
    }
   } return [{ sequence }] }
   if (type !== 'MESSAGE_CREATE') return [{ sequence }]; const parsed = messageSchema.safeParse(raw); if (!parsed.success || parsed.data.author.bot || parsed.data.author.id === botId) return [{ sequence }]; const c = await chat(`discord:${parsed.data.guild_id ? `guild:${parsed.data.guild_id}:${parsed.data.channel_id}` : `dm:${parsed.data.channel_id}`}`, op); const mention = new RegExp(`^<@!?${botId}>\\s*`); const reply = parsed.data.referenced_message?.author.id === botId && parsed.data.referenced_message.channel_id === parsed.data.channel_id && parsed.data.message_reference?.channel_id === parsed.data.channel_id && parsed.data.message_reference.message_id === parsed.data.referenced_message.id; if (c.kind === 'group' && !mention.test(parsed.data.content) && !reply) return [{ sequence }]; const text = parsed.data.content.replace(mention, ''); return [{ sequence, event: { kind: 'message', id: `message:${parsed.data.id}`, chat: { id: c.id, kind: c.kind }, user: { id: parsed.data.author.id, label: parsed.data.author.username, username: parsed.data.author.username }, at: Date.parse(parsed.data.timestamp), messageId: parsed.data.id, text, addressed: c.kind === 'private' || mention.test(parsed.data.content), ...(reply ? { replyTo: { chatId: c.id, messageId: parsed.data.referenced_message!.id } } : {}) } }] }
 return {
  async identify(op) { const me = obj(await invoke('GET', '/users/@me', undefined, op)); if (!me || typeof me.id !== 'string' || me.bot !== true) throw fail('auth'); botId = me.id; return { id: me.id, username: typeof me.username === 'string' ? me.username : me.id, discoveryUrl: 'https://discord.com/developers/applications' } },
  async inspect(id, op) { const c = await chat(id, op); return { id, kind: c.kind, eligible: true } },
  async send(id, message: ChatMessage, op) { if (!message.text || message.text.length > 2000 || (message.buttons?.flat().length ?? 0) > 25 || message.buttons?.flat().some(button => button.text.length > 80 || button.data.length > 100)) throw fail('blocked'); const c = await chat(id, op); const components = (message.buttons ?? []).flat().reduce((rows: Json[][], b: { text: string; data: string }, i: number) => { const row = Math.floor(i / 5); (rows[row] ??= []).push({ type: 2, style: 1, label: b.text, custom_id: b.data }); return rows }, [] as Json[][]).map((components: Json[]) => ({ type: 1, components })); const result = obj(await invoke('POST', `/channels/${c.channel.id}/messages`, { content: message.text, allowed_mentions: { parse: [], replied_user: false }, flags: 4, components }, op)); if (typeof result?.id !== 'string' || result.channel_id !== c.channel.id) throw fail('blocked'); return { chatId: id, messageId: result.id } },
  async clearButtons(receipt: ChatReceipt, op) { const c = await chat(receipt.chatId, op); await invoke('PATCH', `/channels/${c.channel.id}/messages/${receipt.messageId}`, { components: [], allowed_mentions: { parse: [] } }, op) },
  async acknowledge(eventId, text, op) { pruneTokens(); const receipt = interactionTokens.get(eventId); if (!receipt) return; await invoke('PATCH', `/webhooks/${receipt.applicationId}/${receipt.token}/messages/@original`, { content: text.slice(0, 2000), allowed_mentions: { parse: [] } }, op); interactionTokens.delete(eventId) },
  async isMember(id, userId, op) { try { const c = await chat(id, op); if (c.kind === 'private') return c.channel.recipients?.some(x => x.id === userId); return await discordChannelMember((m, p, b) => invoke(m, p, b, op), c.channel.id, c.channel.guild_id!, userId) } catch (e) { if (e instanceof ExtensionChatError && e.failure.kind === 'gone') return false; return undefined } },
  async receive(after, op): Promise<ExtensionChatBatch> {
   await op?.assertActive(); op?.signal.throwIfAborted()
   if (disposed) throw fail('blocked')
   pruneTokens()
   if (after !== null && Number.isSafeInteger(after)) deliverySequence = Math.max(deliverySequence, after)
   if (pending && (after === null || after < pending[0]!.sequence)) return pending
   // The returned row remains replayable until the host reports its durable checkpoint.
   pending = undefined
   const raw = await next(op)
   if (!raw) return []
   if (!Number.isSafeInteger(deliverySequence + 1)) throw fail('blocked')
   const state = stateFor(raw)
   let batch: ExtensionChatBatch
   try {
    if (state.terminal) throw fail('gone')
    batch = await convert(raw, deliverySequence + 1, op)
   } catch (error) {
    // Cancellation, revoked authorization, transient errors and capacity backoff
    // never acknowledge the raw head. Only a per-record 404/expired receipt is terminal.
    await op?.assertActive(); op?.signal.throwIfAborted()
    if (disposed || !(error instanceof ExtensionChatError) || error.failure.kind !== 'gone') throw error
    state.terminal ??= 'gone'
    const id = snowflake.safeParse(raw.id)
    // Await the host logger before returning a checkpointable no-event row. If the
    // diagnostic cannot be published, keep the record and retry reporting, not its action.
    try {
     await reportTerminal(`Discord record ${id.success ? id.data : 'unknown'}: ${state.terminal}; action not processed. Submit it again if still needed.`)
    } catch { throw fail('transient') }
    batch = [{ sequence: deliverySequence + 1 }]
   }
   await op?.assertActive(); op?.signal.throwIfAborted()
   if (disposed) throw fail('blocked')
   deliverySequence++
   queue.shift(); queueBytes -= Number(raw.__bytes)
   pending = batch
   return batch
  },
  async receiveSession(session) {
   if (receiveContext) throw fail('conflict')
   receiveContext = session
   try {
    if (!botId) await this.identify(session)
    await invoke('PUT', `/applications/${botId}/commands`, [{name:'tasks',description:'List this project’s tasks',type:1,options:[{name:'task',description:'Open a task or show its status',type:3,required:false,autocomplete:true}]}],session)
    let after: number | null = null
    while (!session.signal.aborted) {
     const batch = await this.receive(after, session)
     for (const row of batch) {
      if (row.event) {
       await session.accept({kind:'event',event:row.event})
       // The core owns the real reply. Complete only the private native receipt,
       // after acceptance, without exposing task data to an unauthorized caller.
       if (interactionTokens.get(row.event.id)?.command) {
        await session.assertActive(); session.signal.throwIfAborted()
        await this.acknowledge(row.event.id, 'Command received. If you have access, Cezar replies in this chat.', session)
       }
      }
      after=row.sequence
     }
     await session.health({state:'polling'})
    }
   } finally { receiveContext=undefined; clearTimeout(heartbeat); ws?.terminate(); ws=undefined; if (session.signal.aborted) { queue.length=0; queueBytes=0; pending=undefined } }
  },
  async dispose() { disposed = true; queue.length = 0; queueBytes = 0; pending = undefined; interactionTokens.clear(); lifecycle.abort(); wake?.(); clearTimeout(heartbeat); ws?.terminate(); ws = undefined }
 }
}
