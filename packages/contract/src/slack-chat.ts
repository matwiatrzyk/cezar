import { z } from 'zod';
import { chatSchemas } from './chat.ts';
export const slackChatIdSchema = z.string().regex(/^(private|group):T[A-Z0-9]+:U[A-Z0-9]+:[CDG][A-Z0-9]+$/);
export const slackBotIdSchema = z.string().regex(/^T[A-Z0-9]+:U[A-Z0-9]+$/);
export const slackUserIdSchema = z.string().regex(/^[UW][A-Z0-9]+$/);
export const slackCredentialRecordSchema = z.strictObject({
 appToken: z.string().regex(/^xapp-[A-Za-z0-9-]{10,2000}$/),
 botToken: z.string().regex(/^xoxb-[A-Za-z0-9-]{10,2000}$/),
});
export const slackCredentialSchema = z.string().min(1).max(4096).refine(value => {
 try { return slackCredentialRecordSchema.safeParse(JSON.parse(value)).success; } catch { return false; }
}, 'Invalid Slack credentials');
// The shared factory uses this union for mixed bot/chat/user fields; persistence uses role-specific IDs.
export const slackSchemas = chatSchemas(z.union([slackChatIdSchema, slackBotIdSchema, slackUserIdSchema]), slackBotIdSchema, slackBotIdSchema, slackCredentialSchema);
export type SlackCredentials = z.infer<typeof slackCredentialRecordSchema>;
