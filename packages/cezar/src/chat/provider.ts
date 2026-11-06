import { chatProviderIdSchema as providerId, chatOpaqueIdSchema } from '@open-mercato/cezar-contract';
import { z } from 'zod';

/** Internal boundary. Opaque platform identifiers are never interpreted by orchestration. */
export const chatProviderIdSchema = providerId;
export type ChatProviderId = z.infer<typeof chatProviderIdSchema>;
export const chatIdSchema = chatOpaqueIdSchema;
export const chatRefSchema = z.object({ id: chatIdSchema, kind: z.enum(['private', 'group']) });
export const chatReceiptSchema = z.object({ messageId: chatIdSchema, chatId: chatIdSchema });
export const chatButtonSchema = z.object({ text: z.string().min(1), data: z.string().min(1).max(128) });
export const chatMessageSchema = z.object({ text: z.string(), replyTo: chatReceiptSchema.optional(), buttons: z.array(z.array(chatButtonSchema)).optional() });
export const chatIdentitySchema = z.object({ id: chatIdSchema, username: z.string().min(1).max(128) });
export const chatCredentialsSchema = z.record(z.string(), z.string());
export const chatFailureSchema = z.object({ kind: z.enum(['auth', 'conflict', 'rate_limited', 'gone', 'transient', 'blocked']), retryAfterMs: z.number().finite().positive().optional() });
export type ChatFailure = z.infer<typeof chatFailureSchema>;
export class ChatTransportError extends Error {
  constructor(readonly failure: ChatFailure) { super(`Chat transport: ${failure.kind}`); }
}
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
export interface ChatEventSink {
  /** Resolves only after the core has durably handled or rejected the event. */
  accept(event: ChatEvent): Promise<void>;
}
export interface ChatSession {
  identify(signal?: AbortSignal): Promise<ChatIdentity>;
  send(chatId: string, message: ChatMessage, signal?: AbortSignal, valid?: () => boolean): Promise<ChatReceipt>;
  clearButtons(receipt: ChatReceipt, signal?: AbortSignal): Promise<void>;
  acknowledge(eventId: string, text: string, signal?: AbortSignal): Promise<void>;
  isMember(chatId: string, userId: string, signal?: AbortSignal): Promise<boolean | undefined>;
}
/** Rendering is provider-owned; no wire markup or callback fields cross this boundary. */
export interface ChatProvider {
  readonly id: ChatProviderId;
  readonly label: string;
  readonly credentials: readonly { name: string; label: string; pattern?: RegExp }[];
  readonly limits: { maxText: number; buttonsPerMessage: number; perChatPerSecond: number; perBotPerSecond: number };
  readonly ids: { bot: z.ZodType<string>; chat: z.ZodType<string>; user: z.ZodType<string>; message: z.ZodType<string> };
  renderText(text: string, max?: number, username?: string): string;
  command(name: string, username?: string): string;
  discoveryLink(username: string, code: string): string;
}
export interface ChatTransport extends ChatSession {
 /** The guard is rechecked at the last asynchronous preparation boundary before every wire call. */
 guarded(valid: () => boolean): ChatTransport;
 inspect(chatId: string): Promise<{ id: string; kind: 'private' | 'group'; eligible: boolean }>;
 connect(journal: import('./connection.ts').ReceiveJournal, options: import('./connection.ts').ChatConnectionOptions, now?: () => number): import('./connection.ts').ChatConnection;
}
export interface ChatServiceDescriptor {
 credentials: ChatProvider['credentials'];
 id: ChatProviderId; label: string; format: string;
 ids: ChatProvider['ids']; presentation: import('./presentation.ts').ChatPresentation;
 limits: ChatProvider['limits'];
 /** Local credential encoding only; these functions never perform I/O. */
 destination(credential: string): string;
 credentialBotId(destination: string | undefined): string | undefined;
}
