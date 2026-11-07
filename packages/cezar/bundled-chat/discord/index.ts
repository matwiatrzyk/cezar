import { createInterface } from 'node:readline'
import { z } from 'zod'
import { bundledChatFrameSchema } from '../../src/extensions/protocol.ts'
import { discordGateway } from '../../src/chat/providers/discord/gateway.ts'
import { discordRequest } from '../../src/chat/providers/discord/rest.ts'
import { discordTransport } from '../../src/chat/providers/discord/index.ts'
import { decodeDiscordCredentials } from '../../src/chat/providers/discord/identity.ts'
import { discordBundledContextSchema, discordBundledOperationSchema } from '../../src/chat/providers/discord/bundled-adapter.ts'
import type { ChatEvent } from '../../src/chat/provider.ts'

const inputSchema = z.object({
  type: z.string().min(1).max(64), providerId: z.literal('discord'), generation: z.string().min(1).max(100),
  context: z.unknown().optional(), cursor: z.number().int().nonnegative().safe().optional(),
  eventId: z.string().min(1).max(128).optional(), payload: z.unknown().optional(), requestId: z.string().optional(), operation: z.string().optional(), input: z.unknown().optional(),
}).passthrough()

let generation = ''
let running: { stop(): Promise<void> } | undefined
let token = ''
let cursor = 0
let outbound: ReturnType<typeof discordTransport> | undefined

function emit(frame: unknown) {
  const parsed = bundledChatFrameSchema.safeParse(frame)
  if (parsed.success) process.stdout.write(`${JSON.stringify(parsed.data)}\n`)
}
function emitEvent(value: ChatEvent) {
  emit({ type: 'event', providerId: 'discord', generation, cursor, event: value })
}

async function start(context: unknown) {
  const parsed = discordBundledContextSchema.parse(context)
  token = decodeDiscordCredentials(parsed.token)
  const request = discordRequest(token, () => Boolean(running))
  outbound = discordTransport({ token, request }, () => Boolean(running))
  const connection = discordGateway({
    token, request, valid: () => Boolean(running),
    onReceiveCursor: value => { cursor = value },
    options: {
      needed: () => Boolean(running),
      assertCredentials: async () => { decodeDiscordCredentials(parsed.token) },
      process: async () => {},
      accept: async value => emitEvent(value),
      onHealth: health => emit({ type: 'health', providerId: 'discord', generation, state: health.state }),
    },
  })
  running = connection
  connection.start()
}

async function stop() {
  const current = running
  running = undefined
  outbound = undefined
  if (current) await current.stop()
  if (generation) emit({ type: 'health', providerId: 'discord', generation, state: 'stopped' })
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
lines.on('line', line => {
  void (async () => {
    let raw: z.infer<typeof inputSchema>
    try { raw = inputSchema.parse(JSON.parse(line)) } catch { return }
    if (raw.providerId !== 'discord') return
    if (raw.type === 'start') {
      generation = raw.generation
      try { await start(raw.context) } catch { emit({ type: 'health', providerId: 'discord', generation, state: 'blocked' }) }
      return
    }
    if (raw.generation !== generation) return
    if (raw.type === 'stop') { await stop(); return }
    if (raw.type === 'call' && raw.requestId && outbound) {
      try {
        const input = raw.input ?? {}; let result: unknown
        if (raw.operation === 'identify') result = await outbound.identify()
        else if (raw.operation === 'inspect') result = await outbound.inspect(z.object({ chatId: z.string() }).parse(input).chatId)
        else if (raw.operation === 'send') { const x = z.object({ chatId: z.string(), message: z.unknown() }).parse(input); result = await outbound.send(x.chatId, x.message as never) }
        else if (raw.operation === 'clearButtons') result = await outbound.clearButtons(input as never)
        else if (raw.operation === 'acknowledge') { const x = z.object({ eventId: z.string(), text: z.string() }).parse(input); result = await outbound.acknowledge(x.eventId, x.text) }
        else if (raw.operation === 'isMember') { const x = z.object({ chatId: z.string(), userId: z.string() }).parse(input); result = await outbound.isMember(x.chatId, x.userId) }
        else throw Error('unknown Discord operation')
        process.stdout.write(`${JSON.stringify({ type: 'response', requestId: raw.requestId, generation, ok: true, result })}\n`)
      } catch (error) { process.stdout.write(`${JSON.stringify({ type: 'response', requestId: raw.requestId, generation, ok: false, error: { message: error instanceof Error ? error.message : String(error) } })}\n`) }
      return
    }
    const operation = discordBundledOperationSchema.safeParse({ type: raw.type, eventId: raw.eventId, cursor: raw.cursor, payload: raw.payload })
    if (!operation.success) return
    if (operation.data.type === 'gatewayReceive' && operation.data.cursor !== undefined) cursor = operation.data.cursor
    // gatewayConnect is handled by the connection above. interactionAck and nativeCommand are
    // validated operation markers; their wire effects are performed only by gateway-owned logic.
  })().catch(() => undefined)
})
