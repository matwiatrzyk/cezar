import { z } from 'zod';
import { telegramInboundIdSchema } from './telegram.ts';

const identifier = z.string().min(1).max(128);
const timestamp = z.number().int().nonnegative().safe();

export const telegramTaskSourceStateSchema = z.enum([
  'received', 'claimed', 'uncertain', 'finished', 'expired', 'delivery_failed',
]);

/** Durable, private correlation. Prompt text and Telegram profile data never enter this record. */
export const telegramSourceRecordSchema = z.strictObject({
  id: z.uuid(), projectId: identifier, receiverId: identifier, grantId: z.uuid(),
  grantGeneration: z.uuid(), enableGeneration: z.uuid(), chatId: telegramInboundIdSchema,
  userId: telegramInboundIdSchema, sourceMessageId: z.number().int().positive().safe(),
  updateId: z.number().int().nonnegative().safe(), episodeId: identifier, requestId: z.uuid(),
  runId: identifier.optional(), state: telegramTaskSourceStateSchema,
  createdAt: timestamp, updatedAt: timestamp,
});
export type TelegramSourceRecord = z.infer<typeof telegramSourceRecordSchema>;

export const telegramTaskCreateRequestSchema = z.strictObject({
  text: z.string().trim().min(1).max(4000), source: telegramSourceRecordSchema.pick({
    id: true, projectId: true, receiverId: true, grantId: true, grantGeneration: true,
    enableGeneration: true, chatId: true, userId: true, sourceMessageId: true,
    updateId: true, episodeId: true, requestId: true, createdAt: true, updatedAt: true,
  }),
});
export type TelegramTaskCreateRequest = z.infer<typeof telegramTaskCreateRequestSchema>;

export const telegramTaskCreateResultSchema = z.discriminatedUnion('created', [
  z.strictObject({ created: z.literal(true), runId: identifier }),
  z.strictObject({ created: z.literal(false), reason: z.enum(['account_unavailable', 'provider_unavailable', 'project_unavailable', 'creation_failed']) }),
]);
export type TelegramTaskCreateResult = z.infer<typeof telegramTaskCreateResultSchema>;

/** Status projections deliberately omit chat, user and Telegram message identifiers. */
export const telegramSourceStatusSchema = telegramSourceRecordSchema.pick({
  id: true, projectId: true, receiverId: true, requestId: true, runId: true,
  state: true, createdAt: true, updatedAt: true,
});
export type TelegramSourceStatus = z.infer<typeof telegramSourceStatusSchema>;
