import { z } from 'zod'
import type { BundledChatFrame } from '../../../extensions/protocol.ts'
import type { BundledProviderHandle } from '../../../extensions/bundled-runtime.ts'
import type { ChatConnection, ChatConnectionOptions, ReceiveJournal } from '../../connection.ts'
import type { ChatEvent, ChatTransport } from '../../provider.ts'
import { discordTransport, type DiscordTransportOptions } from './index.ts'

/** Provider-local operations accepted by the bundled worker boundary. */
export const discordBundledOperationSchema = z.object({
  type: z.enum(['gatewayConnect', 'gatewayReceive', 'interactionAck', 'nativeCommand']),
  eventId: z.string().min(1).max(128).optional(),
  cursor: z.number().int().nonnegative().safe().optional(),
  payload: z.json().optional(),
}).strict().superRefine((operation, ctx) => {
  if ((operation.type === 'interactionAck' || operation.type === 'nativeCommand') && !operation.eventId) {
    ctx.addIssue({ code: 'custom', path: ['eventId'], message: 'interaction operations require an event id' })
  }
  if (operation.type === 'nativeCommand') {
    const payload = z.object({ query: z.string().max(128), chatId: z.string().max(256), userId: z.string().max(256) }).strict().safeParse(operation.payload)
    if (!payload.success) ctx.addIssue({ code: 'custom', path: ['payload'], message: 'invalid native command payload' })
  }
})
export type DiscordBundledOperation = z.infer<typeof discordBundledOperationSchema>

export const discordBundledContextSchema = z.object({
  projectId: z.string().min(1).max(256),
  token: z.string().min(1).max(32768),
}).strict()
export type DiscordBundledContext = z.infer<typeof discordBundledContextSchema>

/**
 * Compatibility-shaped host facade. Durable acceptance and journal checkpointing remain on the
 * host; a worker is only used for the receive connection when activation supplies a handle.
 */
export function discordBundledTransport(input: DiscordTransportOptions, worker?: BundledProviderHandle, valid: () => boolean = () => true,
  register?: (journal: ReceiveJournal, options: ChatConnectionOptions) => void): ChatTransport {
  const compatibility = discordTransport(input, valid)
  if (!worker) return compatibility
  const call = async (operation: string, value: unknown = {}) => {
    if (!valid()) throw new Error('bundled Discord worker is fenced')
    return worker.call('call', { operation, input: value })
  }
  return {
    ...compatibility,
    identify: () => call('identify') as ReturnType<ChatTransport['identify']>,
    inspect: chatId => call('inspect', { chatId }) as ReturnType<ChatTransport['inspect']>,
    send: (chatId, message) => call('send', { chatId, message }) as ReturnType<ChatTransport['send']>,
    clearButtons: receipt => call('clearButtons', receipt).then(() => undefined),
    acknowledge: (eventId, text) => call('acknowledge', { eventId, text }).then(() => undefined),
    isMember: (chatId, userId) => call('isMember', { chatId, userId }) as ReturnType<ChatTransport['isMember']>,
    guarded(check) { return discordBundledTransport(input, worker, () => valid() && check(), register) },
    connect(journal, options): ChatConnection {
      // The runtime activation owner installs frame delivery. This connection sends only the
      // bounded operation and never exposes a host callback or journal to the child process.
      return {
        start() {
          if (!valid()) return
          register?.(journal, options)
          worker.start()
          worker.send('gatewayConnect', { cursor: journal.extensionCursor?.() ?? undefined })
        },
        health: () => ({ state: 'stopped' as const }),
        async stop() { await worker.stop() },
      }
    },
  }
}

/** Strictly validate an operation before it is put on the internal worker stream. */
export function encodeDiscordBundledOperation(value: unknown): DiscordBundledOperation {
  return discordBundledOperationSchema.parse(value)
}

/** Host frame consumer used by activation code and focused worker tests. */
export async function acceptDiscordBundledFrame(frame: BundledChatFrame, generation: string, accept: (event: ChatEvent) => Promise<void>, checkpoint?: (cursor: number) => Promise<void>): Promise<boolean> {
  if (frame.providerId !== 'discord' || frame.generation !== generation || frame.type !== 'event' || frame.event === undefined) return false
  await accept(frame.event as ChatEvent)
  if (frame.cursor !== undefined) await checkpoint?.(frame.cursor)
  return true
}
