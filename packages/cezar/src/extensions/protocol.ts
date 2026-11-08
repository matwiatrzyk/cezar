// Host <-> worker IPC frames (worker side: extension-worker.ts). Internal to the service: neither the
// public SDK nor the HTTP contract exports these, so the protocol can change with the host.
import { z } from 'zod'
import { chatFailureSchema } from '@open-mercato/cezar-contract'

export const extensionRpcResponseSchema = z.object({
  type: z.literal('response'), requestId: z.string().min(1).max(100), generation: z.string().min(1).max(100),
  ok: z.boolean(), result: z.unknown().optional(), error: z.object({ code: z.string(), message: z.string(), failure: chatFailureSchema.optional() }).optional(),
}).strict()
export type ExtensionRpcResponse = z.infer<typeof extensionRpcResponseSchema>

export const extensionHostRequestSchema = z.object({
  type: z.literal('hostRequest'), requestId: z.string().min(1).max(100), generation: z.string().min(1).max(100),
  method: z.enum(['tasks.list', 'tasks.get', 'tasks.propose', 'storage.get', 'storage.set', 'secrets.get', 'secrets.set', 'logger.info', 'logger.error', 'chat.assertActive']),
  params: z.unknown(), invocationId: z.string().uuid().optional(),
}).strict()
export type ExtensionHostRequest = z.infer<typeof extensionHostRequestSchema>
export const extensionStorageKeySchema = z.string().regex(/^[a-zA-Z0-9._-]{1,128}$/)
export const extensionStorageGetSchema = z.object({ key: extensionStorageKeySchema }).strict()
export const extensionStorageSetSchema = extensionStorageGetSchema.extend({ value: z.json() }).strict()
export const extensionSecretSetSchema = extensionStorageGetSchema.extend({ value: z.string().min(1).max(32768) }).strict()
export const extensionLogInputSchema = z.object({ message: z.string().max(4000) }).strict()
export const extensionEmptyInputSchema = z.object({}).strict()
/** A run id as the store mints it; the last check before it reaches a project store (V1.1). */
export const extensionRunIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)
/** worker→host `tasks.get` params. */
export const extensionTaskGetSchema = z.object({ runId: extensionRunIdSchema }).strict()
/** host→worker `panel` / `invoke` params (V1.1 adds the host-asserted `runId` for `task`-located
 *  contributions; the worker never receives one for any other location). */
export const extensionPanelCallSchema = z.object({ panelId: z.string().min(1).max(100), runId: extensionRunIdSchema.optional() }).strict()
export const extensionInvokeCallSchema = z.object({
  actionId: z.string().min(1).max(100), input: z.record(z.string(), z.unknown()).optional(),
  invocationId: z.string().uuid().optional(), runId: extensionRunIdSchema.optional(),
}).strict()


export const extensionChatCallSchema = z.object({
  providerId: z.string().min(1).max(64), credential: z.string().max(32768),
  operation: z.enum(['identify', 'inspect', 'send', 'clearButtons', 'acknowledge', 'isMember', 'receive']),
  input: z.unknown(),
}).strict()

// Bundled chat worker frames (spec 2026-11-07-bundled-chat-workers). The worker owns the
// platform socket; credentials, rotation, journal and accept stay on the host behind hostRequest.
const bundledBase = { providerId: z.enum(['slack', 'discord', 'telegram']), generation: z.string().min(1).max(100) }
const bundledRequestId = z.string().min(1).max(100)
export const bundledFailureSchema = z.object({ message: z.string().max(2000), failure: chatFailureSchema.optional() }).strict()
export const bundledHealthStateSchema = z.enum(['stopped', 'polling', 'backoff', 'conflict', 'credentials-unavailable', 'blocked'])
export const bundledCallOperationSchema = z.enum(['identify', 'inspect', 'send', 'clearButtons', 'acknowledge', 'isMember'])
export const bundledHostMethodSchema = z.enum(['accept', 'assertCredentials', 'rotate', 'nativeTasks', 'journal', 'process'])

/** Host -> worker. `start` is always the first frame, so a call can never precede the generation. */
export const bundledHostFrameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('start'), ...bundledBase, config: z.record(z.string(), z.string()) }).strict(),
  z.object({ type: z.literal('call'), ...bundledBase, requestId: bundledRequestId, operation: bundledCallOperationSchema, input: z.unknown() }).strict(),
  z.object({ type: z.literal('cancel'), ...bundledBase, requestId: bundledRequestId }).strict(),
  z.object({ type: z.literal('connect'), ...bundledBase }).strict(),
  z.object({ type: z.literal('disconnect'), ...bundledBase }).strict(),
  z.object({ type: z.literal('hostResponse'), ...bundledBase, requestId: bundledRequestId, ok: z.boolean(), result: z.unknown().optional(), error: bundledFailureSchema.optional() }).strict(),
  z.object({ type: z.literal('stop'), ...bundledBase }).strict(),
])
export type BundledHostFrame = z.infer<typeof bundledHostFrameSchema>

/** Worker -> host. Events reach the host through awaited acceptance/processing; Telegram journal reads and writes stay host-owned. */
export const bundledWorkerFrameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready'), ...bundledBase }).strict(),
  z.object({ type: z.literal('response'), ...bundledBase, requestId: bundledRequestId, ok: z.boolean(), result: z.unknown().optional(), error: bundledFailureSchema.optional() }).strict(),
  z.object({ type: z.literal('hostRequest'), ...bundledBase, requestId: bundledRequestId, method: bundledHostMethodSchema, params: z.unknown().optional() }).strict(),
  z.object({ type: z.literal('health'), ...bundledBase, state: bundledHealthStateSchema }).strict(),
])
export type BundledWorkerFrame = z.infer<typeof bundledWorkerFrameSchema>
