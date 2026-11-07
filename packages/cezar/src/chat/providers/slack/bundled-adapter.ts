import { z } from 'zod'
import { chatMessageSchema, chatReceiptSchema, chatIdentitySchema, type ChatMessage, type ChatReceipt, type ChatIdentity } from '../../provider.ts'
import { decodeSlackCredentials } from './identity.ts'
import { createSlackWire, slackError } from './client.ts'
import { slackTransport } from './transport.ts'
import { normalizeSlackEnvelope, slackEnvelope } from './normalize.ts'

const infoSchema = z.object({ channel: z.object({ id: z.string(), is_im: z.boolean(), is_mpim: z.boolean().optional(), is_archived: z.boolean().optional(), is_member: z.boolean().optional(), user: z.string().optional() }) })
const identitySchema = z.object({ team_id: z.string(), user_id: z.string() })
type Socket = { readyState: number; on(name: string, handler: (...args: any[]) => void): void; send(value: string): void; terminate(): void; ping?(): void }
type ChatCredentials = Record<string, string>
type Batch = Array<{ sequence: number; event: unknown }>
type Adapter = { identify(): Promise<ChatIdentity>; inspect(chatId: string): Promise<{ id: string; kind: 'private' | 'group'; eligible: boolean }>; send(chatId: string, message: ChatMessage): Promise<ChatReceipt>; clearButtons(receipt: ChatReceipt): Promise<void>; acknowledge(eventId: string, text: string): Promise<void>; isMember(chatId: string, userId: string): Promise<boolean | undefined>; receive(after: number | null): Promise<Batch>; dispose?(): Promise<void> }

/** SDK adapter used by the immutable Slack worker. All platform I/O remains here. */
export function createSlackAdapter(values: ChatCredentials): Adapter {
 const credentials = decodeSlackCredentials(JSON.stringify(values))
 const wire = createSlackWire(async () => JSON.stringify(credentials))
 const transport = slackTransport(wire)
 let identity: { id: string; username: string } | undefined
 let socket: Socket | undefined
 let opening: Promise<void> | undefined
 let stopped = false
 let sequence = 0
 let queue: Batch = []
 const seen = new Set<string>()
 const inspectNative = async (channel: string) => {
  const me = identity ?? await transport.identify()
  const raw = infoSchema.parse(await wire.call('conversations.info', { channel }))
  const kind = raw.channel.is_im && raw.channel.is_mpim !== true ? 'private' : 'group'
  const id = `${kind}:${me.id}:${channel}`
  const membership = raw.channel.is_archived === true ? false : kind === 'private' ? true : raw.channel.is_member
  return { id, kind: kind as 'private' | 'group', eligible: membership === true }
 }
 const connect = async () => {
  if (stopped || socket) return
  const me = identity ?? await transport.identify(); identity = me
  const opened = z.object({ url: z.string() }).parse(await wire.call('apps.connections.open', {}))
  const ws = wire.socket(opened.url, () => !stopped) as unknown as Socket
  socket = ws
  await new Promise<void>((resolve, reject) => {
   let settled = false
   const finish = (error?: unknown) => { if (settled) return; settled = true; if (socket === ws) socket = undefined; error ? reject(error) : resolve() }
   ws.on('open', () => finish())
   ws.on('error', () => finish(slackError('network')))
   ws.on('close', () => { if (!settled) finish(); if (!stopped) { opening = undefined; void ensureConnected() } })
   ws.on('message', data => { void handle(data) })
  })
 }
 const ensureConnected = async () => {
  if (opening) return opening
  opening = connect().catch(() => { if (!stopped) setTimeout(() => { opening = undefined; void ensureConnected() }, 1000).unref() }).finally(() => { if (socket) opening = undefined })
  return opening
 }
 const handle = async (data: unknown) => {
  if (stopped || !socket) return
  let raw: unknown
  try { raw = JSON.parse(Buffer.isBuffer(data) ? data.toString() : String(data)) } catch { return }
  const parsed = slackEnvelope.safeParse(raw); if (!parsed.success) return
  try { socket.send(JSON.stringify({ envelope_id: parsed.data.envelope_id })) } catch { socket.terminate(); return }
  try {
   const event = await normalizeSlackEnvelope(parsed.data, (identity ?? await transport.identify()).id, inspectNative, Date.now())
   if (!event || seen.has(event.id)) return
   seen.add(event.id); sequence += 1
   queue.push({ sequence, event })
   if (queue.length > 100) queue = queue.slice(-100)
  } catch { /* one malformed or unavailable channel never tears down Socket Mode */ }
 }
 return {
  async identify() { const value = chatIdentitySchema.parse(identity ?? await transport.identify()); identity = value; return value },
  async inspect(chatId: string) { return transport.inspect(chatId) },
  async send(chatId: string, message: ChatMessage) { return chatReceiptSchema.parse(await transport.send(chatId, chatMessageSchema.parse(message))) },
  async clearButtons(receipt: ChatReceipt) { await transport.clearButtons(receipt) },
  async acknowledge() {},
  async isMember(chatId: string, userId: string) { return transport.isMember(chatId, userId) },
  async receive(after: number | null) {
   await ensureConnected()
   return queue.filter(item => after === null || item.sequence > after).slice(0, 100)
  },
  async dispose() { stopped = true; socket?.terminate(); socket = undefined; await opening }
 } satisfies Adapter
}
