import { z } from 'zod';
export const chatProviderIdSchema = z.enum(['telegram', 'slack', 'discord']);
export const chatOpaqueIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:@-]+$/);
/** One HTTP definition; providers supply only their identifier/credential constraints. */
export function chatSchemas(ids: z.ZodType<string>, botId: z.ZodType<string>, username: z.ZodType<string>, credential: z.ZodType<string>) {
const telegramDomainErrorSchema = z.object({ error: z.string(), code: z.string() });

const identifier = z.string().min(1).max(128);
const telegramInboundIdSchema = ids;
const telegramInboundRevisionSchema = z.string().regex(/^[a-f0-9]{64}$/);
// `start` lets a person start new tasks with /task; like cancel/continue it is opt-in.
const telegramInboundPermissionSchema = z.enum(['respond', 'start', 'cancel', 'continue']);
const telegramInboundPermissionsSchema = z.array(telegramInboundPermissionSchema).min(1).max(4)
  .refine(value => value.includes('respond') && new Set(value).size === value.length);
const telegramInboundGrantSchema = z.object({
  id: z.uuid(), receiverId: identifier, chatId: telegramInboundIdSchema, userId: telegramInboundIdSchema,
  label: z.string().max(256), permissions: telegramInboundPermissionsSchema,
  // Every grant is task control: notifications need no grant (spec 2026-10-29-telegram-setup-and-replies).
  capability: z.literal('task_control'),
  generation: z.uuid(), enableGeneration: z.uuid(), approvedAt: z.number().int().nonnegative().safe(),
});
const telegramInboundHealthSchema = z.object({
  state: z.enum(['stopped', 'polling', 'backoff', 'conflict', 'credentials-unavailable', 'blocked']),
  lastSuccessfulPollAt: z.number().int().nonnegative().safe().optional(),
  droppedReplies: z.number().int().nonnegative().safe().optional(),
});
const telegramInboundReceiverSchema = z.object({
  receiverId: identifier, botId: telegramInboundIdSchema.optional(), inboundRevision: telegramInboundRevisionSchema,
  state: z.enum(['disabled', 'pairing', 'active', 'suspended', 'credentials-unavailable', 'conflict', 'blocked', 'stopped']),
  generation: z.uuid().optional(),
  /** Why task control was suspended by Telegram itself: the bot left the group or the person blocked it in a private chat, or the group became a supergroup. */
  suspendedReason: z.enum(['bot_removed', 'group_migrated']).optional(),
});
const telegramUnavailableReasonSchema = z.enum(['flag_off', 'webhooks_off', 'hosted', 'unavailable']);
/** Notifications need CEZ_WEBHOOKS=1 alone; task control also needs CEZ_CHAT_INBOUND=1. */
const telegramNotificationsAvailabilitySchema = z.object({ available: z.boolean(), reason: telegramUnavailableReasonSchema.exclude(['flag_off']).optional() });
const telegramTaskControlAvailabilitySchema = z.object({ available: z.boolean(), reason: telegramUnavailableReasonSchema.optional() });
// `available`/`reason` keep describing task control; `notifications`/`taskControl` name each level.
const telegramInboundStateResponseSchema = z.object({
  available: z.boolean(), reason: telegramUnavailableReasonSchema.optional(),
  notifications: telegramNotificationsAvailabilitySchema, taskControl: telegramTaskControlAvailabilitySchema,
  receivers: z.array(telegramInboundReceiverSchema),
  bots: z.array(z.object({ botId: telegramInboundIdSchema, username: username.optional(),
    inboundRevision: telegramInboundRevisionSchema.optional(), health: telegramInboundHealthSchema })),
  grants: z.array(telegramInboundGrantSchema),
});
/** One guided setup for private and group receivers; the dedicated-bot acknowledgement is required before polling starts. */
const telegramSetupBeginSchema = z.object({ receiverId: identifier, expectedRevision: telegramInboundRevisionSchema,
  token: credential.optional(), name: z.string().trim().min(1).max(100).optional(),
  dedicatedBot: z.literal(true), replaceExisting: z.literal(true).optional(), groupVisibilityAccepted: z.literal(true).optional() }).or(z.object({
  receiverId: identifier.optional(), expectedRevision: telegramInboundRevisionSchema.optional(), token: credential,
  name: z.string().trim().min(1).max(100).optional(), dedicatedBot: z.literal(true), replaceExisting: z.literal(true).optional(), groupVisibilityAccepted: z.literal(true).optional(),
}));
const telegramSetupBotSchema = z.object({ id: botId, username: username });
const telegramSetupBegunSchema = z.object({ setupId: z.uuid(), receiverId: identifier, bot: telegramSetupBotSchema,
  expiresAt: z.number().int().nonnegative().safe(), deepLink: z.string().url() });
/** A group candidate carries the comparison code the bot sent them privately. */
const telegramSetupStatusSchema = z.object({ status: z.enum(['waiting', 'candidate', 'confirmed', 'expired']), receiverId: identifier,
  bot: telegramSetupBotSchema, inboundRevision: telegramInboundRevisionSchema,
  candidate: z.object({ userId: telegramInboundIdSchema, chatType: z.enum(['private', 'group']), label: z.string().max(256), username: z.string().max(64).optional(), comparisonCode: z.string().regex(/^[0-9]{6}$/).optional(),
    /** The group's title, once the setup discovered a group. */
    chatTitle: z.string().max(256).optional() }).optional() });
const telegramSetupActivateSchema = z.object({ expectedRevision: telegramInboundRevisionSchema, candidateUserId: telegramInboundIdSchema,
  comparisonVerified: z.literal(true).optional(), taskControl: z.boolean().optional(), permissions: telegramInboundPermissionsSchema.optional(), activate: z.literal(true),
  // A token-led setup that discovered a group needs the same group-visibility consent as an existing receiver.
  groupVisibilityAccepted: z.literal(true).optional() })
  .superRefine((value, ctx) => { if (value.taskControl !== false && !value.permissions) ctx.addIssue({ code: 'custom', message: 'Task-control permissions are required', path: ['permissions'] }); });
const telegramSetupActivatedSchema = z.object({ grant: telegramInboundGrantSchema.optional(), receiverId: identifier.optional(), inboundRevision: telegramInboundRevisionSchema });
const telegramSetupCancelledSchema = z.object({ cancelled: z.literal(true) });
const telegramInboundReceiverPatchSchema = z.object({ expectedRevision: telegramInboundRevisionSchema, enabled: z.boolean(), groupVisibilityAccepted: z.literal(true).optional() });
const telegramInboundReceiverPatchedSchema = z.object({ state: z.enum(['active', 'disabled']), inboundRevision: telegramInboundRevisionSchema });
const telegramInboundGrantPatchSchema = z.object({ expectedRevision: telegramInboundRevisionSchema, permissions: telegramInboundPermissionsSchema });
const telegramInboundGrantPatchedSchema = z.object({ grant: telegramInboundGrantSchema, inboundRevision: telegramInboundRevisionSchema });
const telegramInboundRevokedSchema = z.object({ revoked: z.literal(true), inboundRevision: telegramInboundRevisionSchema });
const telegramInboundDisconnectedSchema = z.object({ disconnected: z.literal(true), inboundRevision: telegramInboundRevisionSchema });
const telegramInboundResetSchema = z.object({ expectedRevision: telegramInboundRevisionSchema, confirmReset: z.literal(true) });
const telegramInboundResetResponseSchema = z.object({ reset: z.literal(true), inboundRevision: telegramInboundRevisionSchema });
const telegramInboundRevisionQuerySchema = z.object({ expectedRevision: telegramInboundRevisionSchema });
const telegramInboundIdParamSchema = z.object({ id: z.uuid() });
const telegramInboundBotParamSchema = z.object({ botId: botId });
const telegramInboundActivityBaseSchema = z.object({
  id: z.uuid(), epoch: z.uuid(), updateId: z.number().int().nonnegative().safe(), at: z.number().int().nonnegative().safe(),
  botId: telegramInboundIdSchema, chatId: telegramInboundIdSchema.optional(), userId: telegramInboundIdSchema.optional(),
  receiverId: identifier.optional(), runId: identifier.optional(), actionId: identifier.optional(),
  kind: z.enum(['reply', 'answer', 'status', 'tasks', 'task', 'help', 'cancel', 'continue', 'unknown_command', 'rejection_summary']),
  reason: z.string().regex(/^[a-z_]{1,64}$/), count: z.number().int().positive().safe().optional(),
}).superRefine((row, ctx) => {
  if (row.kind === 'rejection_summary') {
    if (!['unauthorized', 'rate_limited'].includes(row.reason) || !row.count || row.at % 60_000 !== 0
      || row.userId !== undefined || row.chatId !== undefined || row.receiverId !== undefined || row.runId !== undefined || row.actionId !== undefined)
      ctx.addIssue({ code: 'custom', message: 'Invalid bot-wide rejection summary' });
  } else if (!row.userId || !row.chatId || row.count !== undefined) ctx.addIssue({ code: 'custom', message: 'Individual action requires an actor and chat' });
});
const telegramInboundActivitySchema = telegramInboundActivityBaseSchema.safeExtend({
  state: z.enum(['accepted', 'queued', 'deferred', 'rejected', 'uncertain']),
}).refine(row => row.kind !== 'rejection_summary' || row.state === 'rejected', 'Summary must be rejected');
const telegramInboundActivityQuerySchema = z.object({ receiverId: identifier.optional(), before: identifier.optional(), limit: z.coerce.number().int().min(1).max(100).default(50) });
const telegramInboundActivityResponseSchema = z.object({ entries: z.array(telegramInboundActivitySchema), nextCursor: identifier.optional() });
const telegramOrphanBindingSchema = z.object({ botId: telegramInboundIdSchema, projectId: identifier, projectName: z.string().max(256).optional(), orphaned: z.boolean(), inboundRevision: telegramInboundRevisionSchema });
const telegramOrphanBindingsSchema = z.object({ bindings: z.array(telegramOrphanBindingSchema), truncated: z.boolean() });
const telegramOrphanReleasedSchema = z.object({ released: z.literal(true) });
const telegramOrphanReleaseQuerySchema = telegramInboundRevisionQuerySchema.extend({ confirmOrphanRelease: z.literal('true') });

/** Generic invalidation only: no project, candidate, code or message on the bus. */
const telegramInboundInvalidationSchema = z.object({ changed: z.literal(true) });

return { telegramDomainErrorSchema, telegramInboundIdSchema, telegramInboundRevisionSchema, telegramInboundPermissionSchema, telegramInboundPermissionsSchema, telegramInboundGrantSchema, telegramInboundHealthSchema, telegramInboundReceiverSchema, telegramNotificationsAvailabilitySchema, telegramTaskControlAvailabilitySchema, telegramInboundStateResponseSchema, telegramSetupBeginSchema, telegramSetupBotSchema, telegramSetupBegunSchema, telegramSetupStatusSchema, telegramSetupActivateSchema, telegramSetupActivatedSchema, telegramSetupCancelledSchema, telegramInboundReceiverPatchSchema, telegramInboundReceiverPatchedSchema, telegramInboundGrantPatchSchema, telegramInboundGrantPatchedSchema, telegramInboundRevokedSchema, telegramInboundDisconnectedSchema, telegramInboundResetSchema, telegramInboundResetResponseSchema, telegramInboundRevisionQuerySchema, telegramInboundIdParamSchema, telegramInboundBotParamSchema, telegramInboundActivityBaseSchema, telegramInboundActivitySchema, telegramInboundActivityQuerySchema, telegramInboundActivityResponseSchema, telegramOrphanBindingSchema, telegramOrphanBindingsSchema, telegramOrphanReleasedSchema, telegramOrphanReleaseQuerySchema, telegramInboundInvalidationSchema };
}
const shared = chatSchemas(chatOpaqueIdSchema, chatOpaqueIdSchema, z.string().min(1).max(128), z.string().min(1).max(16384));
export const chatDomainErrorSchema = shared.telegramDomainErrorSchema;
export const chatInboundIdSchema = shared.telegramInboundIdSchema;
export const chatInboundRevisionSchema = shared.telegramInboundRevisionSchema;
export const chatInboundPermissionSchema = shared.telegramInboundPermissionSchema;
export const chatInboundPermissionsSchema = shared.telegramInboundPermissionsSchema;
export const chatInboundGrantSchema = shared.telegramInboundGrantSchema;
export const chatInboundHealthSchema = shared.telegramInboundHealthSchema;
export const chatInboundReceiverSchema = shared.telegramInboundReceiverSchema;
export const chatNotificationsAvailabilitySchema = shared.telegramNotificationsAvailabilitySchema;
export const chatTaskControlAvailabilitySchema = shared.telegramTaskControlAvailabilitySchema;
export const chatInboundStateResponseSchema = shared.telegramInboundStateResponseSchema;
export const chatSetupBeginSchema = shared.telegramSetupBeginSchema;
export const chatSetupBotSchema = shared.telegramSetupBotSchema;
export const chatSetupBegunSchema = shared.telegramSetupBegunSchema;
export const chatSetupStatusSchema = shared.telegramSetupStatusSchema;
export const chatSetupActivateSchema = shared.telegramSetupActivateSchema;
export const chatSetupActivatedSchema = shared.telegramSetupActivatedSchema;
export const chatSetupCancelledSchema = shared.telegramSetupCancelledSchema;
export const chatInboundReceiverPatchSchema = shared.telegramInboundReceiverPatchSchema;
export const chatInboundReceiverPatchedSchema = shared.telegramInboundReceiverPatchedSchema;
export const chatInboundGrantPatchSchema = shared.telegramInboundGrantPatchSchema;
export const chatInboundGrantPatchedSchema = shared.telegramInboundGrantPatchedSchema;
export const chatInboundRevokedSchema = shared.telegramInboundRevokedSchema;
export const chatInboundDisconnectedSchema = shared.telegramInboundDisconnectedSchema;
export const chatInboundResetSchema = shared.telegramInboundResetSchema;
export const chatInboundResetResponseSchema = shared.telegramInboundResetResponseSchema;
export const chatInboundRevisionQuerySchema = shared.telegramInboundRevisionQuerySchema;
export const chatInboundIdParamSchema = shared.telegramInboundIdParamSchema;
export const chatInboundBotParamSchema = shared.telegramInboundBotParamSchema;
export const chatInboundActivityBaseSchema = shared.telegramInboundActivityBaseSchema;
export const chatInboundActivitySchema = shared.telegramInboundActivitySchema;
export const chatInboundActivityQuerySchema = shared.telegramInboundActivityQuerySchema;
export const chatInboundActivityResponseSchema = shared.telegramInboundActivityResponseSchema;
export const chatOrphanBindingSchema = shared.telegramOrphanBindingSchema;
export const chatOrphanBindingsSchema = shared.telegramOrphanBindingsSchema;
export const chatOrphanReleasedSchema = shared.telegramOrphanReleasedSchema;
export const chatOrphanReleaseQuerySchema = shared.telegramOrphanReleaseQuerySchema;
export const chatInboundInvalidationSchema = shared.telegramInboundInvalidationSchema;
/** Platform constraints are checked at persistence/HTTP boundaries; orchestration treats IDs as opaque. */
const telegramIdentifier = z.string().regex(/^-?[1-9][0-9]{0,15}$/).refine(value => Number.isSafeInteger(Number(value)));
const telegramPositiveIdentifier = telegramIdentifier.refine(value => !value.startsWith('-'));
const discordIdentifier = z.string().regex(/^[1-9][0-9]{0,19}$/);
// Discord snowflakes do not encode channel privacy. Persist validated channel kind
// with the destination so cold-start authorization never guesses from an ID/cache.
const discordChatIdentifier = z.string().regex(/^discord:(?:dm:[1-9][0-9]{0,19}|guild:[1-9][0-9]{0,19}:[1-9][0-9]{0,19})$/);
export const chatIdentifierSchemas = {
 telegram: { bot: telegramPositiveIdentifier, user: telegramPositiveIdentifier, chat: telegramIdentifier, message: telegramPositiveIdentifier },
 slack: { bot: z.string().regex(/^T[A-Z0-9]+:U[A-Z0-9]+$/), user: z.string().regex(/^[UW][A-Z0-9]+$/), chat: z.string().regex(/^(?:private|group):T[A-Z0-9]+:U[A-Z0-9]+:[DCG][A-Z0-9]+$/), message: z.string().regex(/^[0-9]+\.[0-9]+$/) },
 discord: { bot: discordIdentifier, user: discordIdentifier, chat: discordChatIdentifier, message: discordIdentifier },
} as const;

/** Qualified destinations retain privacy and, for Slack, the authenticated bot namespace. */
export function qualifiedChatKind(provider: z.infer<typeof chatProviderIdSchema>, id: string): 'private' | 'group' | undefined {
 if (!chatIdentifierSchemas[provider].chat.safeParse(id).success) return;
 if (provider === 'slack') return id.startsWith('private:') ? 'private' : 'group';
 if (provider === 'discord') return id.startsWith('discord:dm:') ? 'private' : 'group';
 return undefined;
}
export function chatDestinationMatchesBot(provider: z.infer<typeof chatProviderIdSchema>, id: string, botId: string): boolean {
 return chatIdentifierSchemas[provider].chat.safeParse(id).success && (provider !== 'slack' || id.split(':').slice(1, 3).join(':') === botId);
}

// Generic types derive from the same schemas used by middleware and persistence.
export type ChatDomainError = z.infer<typeof chatDomainErrorSchema>;
export type ChatInboundId = z.infer<typeof chatInboundIdSchema>;
export type ChatInboundRevision = z.infer<typeof chatInboundRevisionSchema>;
export type ChatInboundPermission = z.infer<typeof chatInboundPermissionSchema>;
export type ChatInboundPermissions = z.infer<typeof chatInboundPermissionsSchema>;
export type ChatInboundGrant = z.infer<typeof chatInboundGrantSchema>;
export type ChatInboundHealth = z.infer<typeof chatInboundHealthSchema>;
export type ChatInboundReceiver = z.infer<typeof chatInboundReceiverSchema>;
export type ChatNotificationsAvailability = z.infer<typeof chatNotificationsAvailabilitySchema>;
export type ChatTaskControlAvailability = z.infer<typeof chatTaskControlAvailabilitySchema>;
export type ChatInboundStateResponse = z.infer<typeof chatInboundStateResponseSchema>;
export type ChatSetupBegin = z.infer<typeof chatSetupBeginSchema>;
export type ChatSetupBot = z.infer<typeof chatSetupBotSchema>;
export type ChatSetupBegun = z.infer<typeof chatSetupBegunSchema>;
export type ChatSetupStatus = z.infer<typeof chatSetupStatusSchema>;
export type ChatSetupActivate = z.infer<typeof chatSetupActivateSchema>;
export type ChatSetupActivated = z.infer<typeof chatSetupActivatedSchema>;
export type ChatSetupCancelled = z.infer<typeof chatSetupCancelledSchema>;
export type ChatInboundReceiverPatch = z.infer<typeof chatInboundReceiverPatchSchema>;
export type ChatInboundReceiverPatched = z.infer<typeof chatInboundReceiverPatchedSchema>;
export type ChatInboundGrantPatch = z.infer<typeof chatInboundGrantPatchSchema>;
export type ChatInboundGrantPatched = z.infer<typeof chatInboundGrantPatchedSchema>;
export type ChatInboundRevoked = z.infer<typeof chatInboundRevokedSchema>;
export type ChatInboundDisconnected = z.infer<typeof chatInboundDisconnectedSchema>;
export type ChatInboundReset = z.infer<typeof chatInboundResetSchema>;
export type ChatInboundResetResponse = z.infer<typeof chatInboundResetResponseSchema>;
export type ChatInboundRevisionQuery = z.infer<typeof chatInboundRevisionQuerySchema>;
export type ChatInboundIdParam = z.infer<typeof chatInboundIdParamSchema>;
export type ChatInboundBotParam = z.infer<typeof chatInboundBotParamSchema>;
export type ChatInboundActivityBase = z.infer<typeof chatInboundActivityBaseSchema>;
export type ChatInboundActivity = z.infer<typeof chatInboundActivitySchema>;
export type ChatInboundActivityQuery = z.infer<typeof chatInboundActivityQuerySchema>;
export type ChatInboundActivityResponse = z.infer<typeof chatInboundActivityResponseSchema>;
export type ChatOrphanBinding = z.infer<typeof chatOrphanBindingSchema>;
export type ChatOrphanBindings = z.infer<typeof chatOrphanBindingsSchema>;
export type ChatOrphanReleased = z.infer<typeof chatOrphanReleasedSchema>;
export type ChatOrphanReleaseQuery = z.infer<typeof chatOrphanReleaseQuerySchema>;
export type ChatInboundInvalidation = z.infer<typeof chatInboundInvalidationSchema>;
