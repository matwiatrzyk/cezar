// Host <-> worker IPC frames (worker side: worker-source.ts). Internal to the service: neither the
// public SDK nor the HTTP contract exports these, so the protocol can change with the host.
import { z } from 'zod'
import { chatFailureSchema } from '@open-mercato/cezar-contract'

export const extensionRpcRequestSchema = z.object({
  type: z.literal('request'), requestId: z.string().min(1).max(100), generation: z.string().min(1).max(100),
  method: z.enum(['activate', 'invoke', 'panel', 'form', 'chat', 'deactivate']), params: z.unknown(),
}).strict()
export const extensionRpcResponseSchema = z.object({
  type: z.literal('response'), requestId: z.string().min(1).max(100), generation: z.string().min(1).max(100),
  ok: z.boolean(), result: z.unknown().optional(), error: z.object({ code: z.string(), message: z.string(), failure: chatFailureSchema.optional() }).optional(),
}).strict()
export const extensionRpcReadySchema = z.object({ type: z.literal('ready'), generation: z.string() }).strict()
export type ExtensionRpcRequest = z.infer<typeof extensionRpcRequestSchema>
export type ExtensionRpcResponse = z.infer<typeof extensionRpcResponseSchema>

export const extensionHostRequestSchema = z.object({
  type: z.literal('hostRequest'), requestId: z.string().min(1).max(100), generation: z.string().min(1).max(100),
  method: z.enum(['tasks.list', 'tasks.propose', 'storage.get', 'storage.set', 'secrets.get', 'secrets.set', 'logger.info', 'logger.error']),
  params: z.unknown(), invocationId: z.string().uuid().optional(),
}).strict()
export type ExtensionHostRequest = z.infer<typeof extensionHostRequestSchema>
export const extensionStorageKeySchema = z.string().regex(/^[a-zA-Z0-9._-]{1,128}$/)
export const extensionStorageGetSchema = z.object({ key: extensionStorageKeySchema }).strict()
export const extensionStorageSetSchema = extensionStorageGetSchema.extend({ value: z.json() }).strict()
export const extensionSecretSetSchema = extensionStorageGetSchema.extend({ value: z.string().min(1).max(32768) }).strict()
export const extensionLogInputSchema = z.object({ message: z.string().max(4000) }).strict()
export const extensionEmptyInputSchema = z.object({}).strict()


export const extensionChatCallSchema = z.object({
  providerId: z.string().min(1).max(64), credential: z.string().max(32768),
  operation: z.enum(['identify', 'inspect', 'send', 'clearButtons', 'acknowledge', 'isMember', 'receive']),
  input: z.unknown(),
}).strict()

/** Frames emitted by a bundled provider.  This is deliberately narrower than the
 * extension protocol: provider events cross the boundary only as opaque, validated
 * chat events and never as callbacks or host objects. */
export const bundledChatFrameSchema = z.object({
  type: z.enum(['event', 'health']),
  providerId: z.string().min(1).max(64),
  generation: z.string().min(1).max(100),
  cursor: z.number().int().nonnegative().safe().optional(),
  event: z.unknown().optional(),
  state: z.enum(['stopped', 'polling', 'backoff', 'conflict', 'credentials-unavailable', 'blocked']).optional(),
}).strict().superRefine((frame, ctx) => {
  if (frame.type === 'event' && frame.event === undefined) ctx.addIssue({ code: 'custom', path: ['event'], message: 'event frame requires event' })
  if (frame.type === 'health' && frame.state === undefined) ctx.addIssue({ code: 'custom', path: ['state'], message: 'health frame requires state' })
})
export type BundledChatFrame = z.infer<typeof bundledChatFrameSchema>
