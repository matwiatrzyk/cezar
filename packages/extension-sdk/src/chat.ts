import { z } from 'zod'
export const chatIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:@-]+$/);
export const chatRefSchema = z.object({ id: chatIdSchema, kind: z.enum(['private', 'group']) });
export const chatReceiptSchema = z.object({ messageId: chatIdSchema, chatId: chatIdSchema });
export const chatButtonSchema = z.object({ text: z.string().min(1), data: z.string().min(1).max(128) });
export const chatMessageSchema = z.object({ text: z.string(), replyTo: chatReceiptSchema.optional(), buttons: z.array(z.array(chatButtonSchema)).optional() });
export const chatIdentitySchema = z.object({ id: chatIdSchema, username: z.string().min(1).max(128), discoveryUrl: z.string().url().refine(value => value.startsWith('https://')).optional() });
export const chatCredentialsSchema = z.record(z.string(), z.string());
export const chatFailureSchema = z.object({ kind: z.enum(['auth', 'conflict', 'rate_limited', 'gone', 'transient', 'blocked']), retryAfterMs: z.number().finite().positive().optional() });
export type ChatFailure = z.infer<typeof chatFailureSchema>;
export type ChatRef = z.infer<typeof chatRefSchema>;
export type ChatReceipt = z.infer<typeof chatReceiptSchema>;
export type ChatMessage = z.infer<typeof chatMessageSchema>;
export type ChatIdentity = z.infer<typeof chatIdentitySchema>;
export type ChatCredentials = z.infer<typeof chatCredentialsSchema>;
const actor = z.object({ id: chatIdSchema, label: z.string().max(256), username: z.string().max(128).optional() });
const base = { id: chatIdSchema, chat: chatRefSchema };
export const chatEventSchema = z.discriminatedUnion('kind', [
  z.object({ ...base, kind: z.literal('message'), user: actor, messageId: chatIdSchema, at: z.number().int().nonnegative(), text: z.string().max(65536), addressed: z.boolean(), replyTo: chatReceiptSchema.optional() }),
  z.object({ ...base, kind: z.literal('button'), user: actor, receipt: chatReceiptSchema, data: z.string().max(128) }),
  z.object({ ...base, kind: z.literal('membership'), reason: z.enum(['removed', 'migrated']), previousChatId: chatIdSchema.optional() }),
  z.object({ ...base, kind: z.literal('start'), user: actor, at: z.number().int().nonnegative(), code: z.string().max(128), title: z.string().max(256).optional() }),
]).superRefine((event, ctx) => {
 const receipt = event.kind === 'message' ? event.replyTo : event.kind === 'button' ? event.receipt : undefined;
 if (receipt && receipt.chatId !== event.chat.id) ctx.addIssue({ code: 'custom', message: 'Receipt belongs to another chat' });
});
export type ChatEvent = z.infer<typeof chatEventSchema>;

export const extensionChatProviderSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
  label: z.string().min(1).max(100),
  credentials: z.array(z.object({ name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/), label: z.string().min(1).max(100), secret: z.boolean().default(true) }).strict()).min(1).max(10),
  limits: z.object({ maxText: z.number().int().min(100).max(20000), buttonsPerMessage: z.number().int().min(0).max(100), perChatPerSecond: z.number().positive().max(100), perBotPerSecond: z.number().positive().max(1000) }).strict(),
  /** External IDs must distinguish private and group destinations. */
  commandPrefix: z.string().min(1).max(30).default('/'),
  groupPrefix: z.string().min(1).max(50).default('group:'),
  /** Setup help link, and the pairing link base when identify() returns no discoveryUrl. */
  discoveryUrl: z.string().url().refine(value => value.startsWith('https://'), 'discovery URL must use HTTPS'),
}).strict()
export type ExtensionChatProvider = z.infer<typeof extensionChatProviderSchema>
export const extensionChatBatchSchema = z.array(z.object({ sequence: z.number().int().nonnegative(), event: chatEventSchema }).strict()).max(100)
export type ExtensionChatBatch = z.infer<typeof extensionChatBatchSchema>
/** The host checkpoints each monotonically increasing sequence after durable acceptance.
 * receive must return within 25 seconds. No unsolicited effects or task starts are available. */
// Structural AbortSignal surface keeps the SDK independent of Node and DOM type libraries.
export interface ExtensionChatOperationContext {
  readonly signal: {
    readonly aborted: boolean
    throwIfAborted(): void
    addEventListener(type: 'abort', listener: () => void, options?: { once?: boolean }): void
    removeEventListener(type: 'abort', listener: () => void): void
  }
  /** Await after asynchronous preparation, immediately before each external effect.
   * Older hosts omit the context; older adapters remain callable but cannot cancel pending effects. */
  assertActive(): Promise<void>
}
export interface ExtensionChatAdapter {
  identify(operation?: ExtensionChatOperationContext): Promise<ChatIdentity>
  inspect(chatId: string, operation?: ExtensionChatOperationContext): Promise<{ id: string; kind: 'private' | 'group'; eligible: boolean }>
  send(chatId: string, message: ChatMessage, operation?: ExtensionChatOperationContext): Promise<ChatReceipt>
  clearButtons(receipt: ChatReceipt, operation?: ExtensionChatOperationContext): Promise<void>
  acknowledge(eventId: string, text: string, operation?: ExtensionChatOperationContext): Promise<void>
  isMember(chatId: string, userId: string, operation?: ExtensionChatOperationContext): Promise<boolean | undefined>
  receive(after: number | null, operation?: ExtensionChatOperationContext): Promise<ExtensionChatBatch>
  dispose?(): Promise<void>
}

/** Serializable, bounded provider failures; messages must never contain credentials. */
export class ExtensionChatError extends Error {
  readonly failure: ChatFailure
  constructor(failure: ChatFailure) {
    super('Chat transport: ' + failure.kind)
    this.failure = chatFailureSchema.parse(failure)
  }
}
