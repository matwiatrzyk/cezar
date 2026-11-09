import { ExtensionChatError, type ChatMessage, type ChatReceipt, type ExtensionChatAdapter, type ExtensionChatBatch, type ExtensionChatOperationContext } from '@open-mercato/cezar-extension-sdk/chat'
import { Agent, request as undiciRequest } from 'undici'
import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import WebSocket from 'ws'
import { z } from 'zod'
import { channelIdentity, parseChat, snowflake } from './identity.js'
import { discordChannelMember } from './membership.js'

type Address = { address: string; family: number }; type Json = Record<string, unknown>
const obj = (v: unknown): Json | undefined => v && typeof v === 'object' && !Array.isArray(v) ? v as Json : undefined
const fail = (kind: 'auth'|'conflict'|'rate_limited'|'gone'|'transient'|'blocked', retryAfterMs?: number) => new ExtensionChatError({ kind, ...(retryAfterMs ? { retryAfterMs } : {}) })
const MAX = 1024 * 1024
const publicAddress = (raw: string) => {
 const a = raw.replace(/^\[|\]$/g, '');
 if (isIP(a) === 4) { const p = a.split('.').map(Number); if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false; const n = p[0]! * 2 ** 24 + p[1]! * 2 ** 16 + p[2]! * 256 + p[3]!; return p[0] !== 0 && p[0] !== 10 && p[0] !== 127 && !(p[0] === 169 && p[1] === 254) && !(p[0] === 172 && p[1]! >= 16 && p[1]! <= 31) && !(p[0] === 192 && p[1] === 168) && !(p[0] === 192 && p[1] === 0 && p[2] === 0) && !(p[0] === 198 && p[1] === 18) && !(p[0] === 198 && p[1] === 51 && p[2] === 100) && !(p[0] === 203 && p[1] === 0 && p[2] === 113) && p[0]! < 224 && n !== 0xffffffff;
 }
 if (isIP(a) !== 6 || a.includes('%')) return false;
 const lower = a.toLowerCase(); return !lower.startsWith('fc') && !lower.startsWith('fd') && !lower.startsWith('fe8') && !lower.startsWith('fe9') && !lower.startsWith('fea') && !lower.startsWith('feb') && !lower.startsWith('ff');
}
export type DiscordRequestOptions = { lookup?: (host: string) => Promise<Address[]>; request?: typeof undiciRequest }
export function discordRequest(token: string, options: DiscordRequestOptions = {}) {
 return async (method: string, path: string, body?: unknown, operation?: ExtensionChatOperationContext) => {
  await operation?.assertActive(); operation?.signal.throwIfAborted(); const controller = new AbortController(); const abort = () => controller.abort(); operation?.signal.addEventListener('abort', abort, { once: true }); let dispatcher: Agent | undefined
  try {
   const addresses = await (options.lookup ?? (async h => dnsLookup(h, { all: true, verbatim: true })))('discord.com'); const valid = addresses.filter(a => publicAddress(a.address) && a.family === isIP(a.address)); if (!valid.length || valid.length !== addresses.length) throw fail('blocked'); const target = valid[0]!; dispatcher = new Agent({ connect: { rejectUnauthorized: true, autoSelectFamily: false, lookup(_h, o, cb) { if (o.all) cb(null, [target]); else cb(null, target.address, target.family) } } })
   const timer = setTimeout(abort, 10000); const response = await (options.request ?? undiciRequest)(`https://discord.com/api/v10${path}`, { method: method as any, dispatcher, signal: controller.signal, headersTimeout: 10000, bodyTimeout: 10000, headers: { authorization: `Bot ${token}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); const chunks: Buffer[] = []; let bytes = 0; for await (const chunk of response.body) { bytes += chunk.length; if (bytes > MAX) throw fail('blocked'); chunks.push(Buffer.from(chunk)) } clearTimeout(timer); let data: unknown; try { data = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined } catch { throw fail('transient') }
   if (response.statusCode === 429) { const retry = Number(obj(data)?.retry_after); throw fail('rate_limited', Number.isFinite(retry) ? retry * 1000 : 5000) } if (response.statusCode === 401) throw fail('auth'); if (response.statusCode === 404) throw fail('gone'); if (response.statusCode === 403) throw fail('blocked'); if (response.statusCode >= 500) throw fail('transient'); if (response.statusCode >= 400) throw fail('blocked'); return data
  } catch (e) { if (e instanceof ExtensionChatError) throw e; if (operation?.signal.aborted || controller.signal.aborted) throw fail('blocked'); throw fail('transient') } finally { operation?.signal.removeEventListener('abort', abort); await dispatcher?.close().catch(() => undefined) }
 }
}

const messageSchema = z.object({ id: snowflake, channel_id: snowflake, guild_id: snowflake.optional(), author: z.object({ id: snowflake, username: z.string(), bot: z.boolean().optional() }), content: z.string().max(65536), timestamp: z.string() })
const frameSchema = z.object({ op: z.number().int(), d: z.unknown().optional(), s: z.number().int().nonnegative().nullable().optional(), t: z.string().nullable().optional() })
const interactionSchema = z.object({ id: snowflake, application_id: snowflake, type: z.union([z.literal(2), z.literal(3)]), token: z.string().min(1).max(2048), channel_id: snowflake, guild_id: snowflake.optional(), user: z.object({ id: snowflake, username: z.string(), bot: z.boolean().optional() }).optional(), member: z.object({ user: z.object({ id: snowflake, username: z.string(), bot: z.boolean().optional() }) }).optional(), data: z.object({ custom_id: z.string().min(1).max(128), name: z.string().optional() }).optional(), message: z.object({ id: snowflake, channel_id: snowflake, author: z.object({ id: snowflake, bot: z.boolean().optional() }) }).optional() })
export type DiscordSocketFactory = (url: string) => WebSocket
export function createDiscordAdapter(credentials: Record<string, string>, request = discordRequest(credentials.token ?? ''), socket?: DiscordSocketFactory): ExtensionChatAdapter {
 let botId = ''; let sequence = 0; let ws: WebSocket | undefined; let disposed = false; let gatewayUrl = ''; let sessionId: string | undefined; const queue: Json[] = []; const interactionTokens = new Map<string, { token: string; applicationId: string }>(); let wake: (() => void) | undefined; let heartbeat: ReturnType<typeof setTimeout> | undefined; let heartbeatAck = true
 const invoke = (m: string, p: string, b?: unknown, op?: ExtensionChatOperationContext) => request(m, p, b, op)
 const chat = async (id: string, op?: ExtensionChatOperationContext) => { const parsed = parseChat(id); const actual = channelIdentity(await invoke('GET', `/channels/${parsed.channel}`, undefined, op)); if (actual.id !== id) throw fail('blocked'); return actual }
 const validGateway = (value: string) => { let u: URL; try { u = new URL(value) } catch { throw fail('blocked') } if (u.protocol !== 'wss:' || !/^gateway(?:-[a-z0-9-]+)?\.discord\.gg$/.test(u.hostname) || u.port || u.username || u.password || u.pathname !== '/') throw fail('blocked'); u.search = '?v=10&encoding=json'; return u.toString() }
 const connect = async (op?: ExtensionChatOperationContext) => {
  if (!gatewayUrl) { const gateway = obj(await invoke('GET', '/gateway/bot', undefined, op))?.url; if (typeof gateway !== 'string') throw fail('blocked'); gatewayUrl = validGateway(gateway) }
  ws = (socket ?? (u => new WebSocket(u, { handshakeTimeout: 10000, maxPayload: MAX })))(gatewayUrl); let settled = false; let timer: ReturnType<typeof setTimeout>;
  await new Promise<void>((resolve, reject) => {
   const finish = (error?: unknown) => { if (settled) return; settled = true; clearTimeout(timer); if (error) reject(error); else resolve() }
   timer = setTimeout(() => { ws?.terminate(); finish(fail('transient')) }, 15000)
   ws!.once('open', () => {})
   ws!.on('error', () => finish(fail('transient')))
   ws!.on('close', () => { ws = undefined; clearTimeout(heartbeat); wake?.(); wake = undefined; if (!settled) finish(fail('transient')) })
   ws!.on('message', raw => { let frame: z.infer<typeof frameSchema>; try { frame = frameSchema.parse(JSON.parse(raw.toString())) } catch { finish(fail('blocked')); return }
    if (frame.s != null && Number.isSafeInteger(frame.s)) sequence = Math.max(sequence, frame.s)
    if (frame.op === 11) { heartbeatAck = true; return }
    if (frame.op === 1) { ws?.send(JSON.stringify({ op: 1, d: sequence })); return }
    if (frame.op === 10) { const hello = z.object({ heartbeat_interval: z.number().int().min(100).max(120000) }).safeParse(frame.d); if (!hello.success) return finish(fail('blocked')); const beat = () => { if (!heartbeatAck) { ws?.terminate(); return } heartbeatAck = false; ws?.send(JSON.stringify({ op: 1, d: sequence })); heartbeat = setTimeout(beat, hello.data.heartbeat_interval) }; clearTimeout(heartbeat); heartbeat = setTimeout(beat, Math.random() * hello.data.heartbeat_interval); ws?.send(JSON.stringify({ op: sessionId ? 6 : 2, d: sessionId ? { token: credentials.token, session_id: sessionId, seq: sequence } : { token: credentials.token, intents: 1 | 512 | 4096 | 32768, properties: { os: 'cezar', browser: 'cezar', device: 'cezar' } } })); return }
    if (frame.op === 0 && frame.t === 'READY') { const user = obj(obj(frame.d)?.user); const sid = obj(frame.d)?.session_id; if (typeof user?.id !== 'string' || user.bot !== true || typeof sid !== 'string') return finish(fail('auth')); botId = user.id; sessionId = sid; clearTimeout(timer); finish(); return }
    if (frame.op === 0 && frame.t === 'RESUMED') { clearTimeout(timer); finish(); return }
    if (frame.op === 0) { const data = obj(frame.d) ?? {}; queue.push({ ...data, __type: frame.t, __seq: frame.s }); wake?.(); wake = undefined }
   })
  })
 }
 const next = async (op?: ExtensionChatOperationContext) => { while (!queue.length) { await op?.assertActive(); op?.signal.throwIfAborted(); if (!ws) await connect(op); await new Promise<void>((resolve, reject) => { const timer = setTimeout(resolve, 24000); const abort = () => { clearTimeout(timer); reject(fail('blocked')) }; wake = () => { clearTimeout(timer); resolve() }; op?.signal.addEventListener('abort', abort, { once: true }) }) } return queue.shift() }
 return {
  async identify(op) { const me = obj(await invoke('GET', '/users/@me', undefined, op)); if (!me || typeof me.id !== 'string' || me.bot !== true) throw fail('auth'); botId = me.id; return { id: me.id, username: typeof me.username === 'string' ? me.username : me.id, discoveryUrl: 'https://discord.com/developers/applications' } },
  async inspect(id, op) { const c = await chat(id, op); return { id, kind: c.kind, eligible: true } },
  async send(id, message: ChatMessage, op) { if (!message.text || message.text.length > 2000 || (message.buttons?.flat().length ?? 0) > 25) throw fail('blocked'); const c = await chat(id, op); const components = (message.buttons ?? []).flat().reduce((rows: Json[][], b: { text: string; data: string }, i: number) => { const row = Math.floor(i / 5); (rows[row] ??= []).push({ type: 2, style: 1, label: b.text.slice(0, 80), custom_id: b.data }); return rows }, [] as Json[][]).map((components: Json[]) => ({ type: 1, components })); const result = obj(await invoke('POST', `/channels/${c.channel.id}/messages`, { content: message.text, allowed_mentions: { parse: [] }, components }, op)); if (typeof result?.id !== 'string' || result.channel_id !== c.channel.id) throw fail('blocked'); return { chatId: id, messageId: result.id } },
  async clearButtons(receipt: ChatReceipt, op) { const c = await chat(receipt.chatId, op); await invoke('PATCH', `/channels/${c.channel.id}/messages/${receipt.messageId}`, { components: [], allowed_mentions: { parse: [] } }, op) },
  async acknowledge(eventId, text, op) { const receipt = interactionTokens.get(eventId); if (!receipt) return; await invoke('PATCH', `/webhooks/${receipt.applicationId}/${receipt.token}/messages/@original`, { content: text.slice(0, 2000), allowed_mentions: { parse: [] } }, op); interactionTokens.delete(eventId) },
  async isMember(id, userId, op) { try { const c = await chat(id, op); if (c.kind === 'private') return c.channel.recipients?.some(x => x.id === userId); return await discordChannelMember((m, p, b, s) => invoke(m, p, b, { signal: s, assertActive: async () => {} } as never), c.channel.id, c.channel.guild_id!, userId) } catch (e) { if (e instanceof ExtensionChatError && e.failure.kind === 'gone') return false; return undefined } },
  async receive(after, op): Promise<ExtensionChatBatch> { if (disposed) throw fail('blocked'); if (after !== null && Number.isSafeInteger(after)) sequence = Math.max(sequence, after); const raw = await next(op); if (!raw) return []; const seq = Number(raw.__seq); if (Number.isSafeInteger(seq)) sequence = Math.max(sequence, seq); const type = raw.__type; if (type === 'INTERACTION_CREATE') { const parsed = interactionSchema.safeParse(raw); const user = parsed.success ? parsed.data.member?.user ?? parsed.data.user : undefined; if (parsed.success && user && !user.bot && parsed.data.application_id === botId && parsed.data.type === 3 && parsed.data.data?.custom_id && parsed.data.message?.author.id === botId) { interactionTokens.set(parsed.data.id, { token: parsed.data.token, applicationId: parsed.data.application_id }); const c = await chat(`discord:${parsed.data.guild_id ? `guild:${parsed.data.guild_id}:${parsed.data.channel_id}` : `dm:${parsed.data.channel_id}`}`, op); await invoke('POST', `/interactions/${parsed.data.id}/${parsed.data.token}/callback`, { type: 6 }, op); return [{ sequence, event: { kind: 'button', id: `interaction:${parsed.data.id}`, chat: { id: c.id, kind: c.kind }, user: { id: user.id, label: user.username, username: user.username }, receipt: { chatId: c.id, messageId: parsed.data.message.id }, data: parsed.data.data.custom_id } } as never] } return [{ sequence }] }
   if (type !== 'MESSAGE_CREATE') return [{ sequence }]; const parsed = messageSchema.safeParse(raw); if (!parsed.success || parsed.data.author.bot || parsed.data.author.id === botId) return [{ sequence }]; const c = await chat(`discord:${parsed.data.guild_id ? `guild:${parsed.data.guild_id}:${parsed.data.channel_id}` : `dm:${parsed.data.channel_id}`}`, op); const mention = new RegExp(`^<@!?${botId}>\\s*`); if (c.kind === 'group' && !mention.test(parsed.data.content)) return [{ sequence }]; const text = parsed.data.content.replace(mention, ''); return [{ sequence, event: { kind: 'message', id: `message:${parsed.data.id}`, chat: { id: c.id, kind: c.kind }, user: { id: parsed.data.author.id, label: parsed.data.author.username, username: parsed.data.author.username }, at: Date.parse(parsed.data.timestamp), messageId: parsed.data.id, text, addressed: c.kind === 'private' || mention.test(parsed.data.content) } } as never] },
  async dispose() { disposed = true; wake?.(); clearTimeout(heartbeat); ws?.terminate(); ws = undefined }
 }
}
