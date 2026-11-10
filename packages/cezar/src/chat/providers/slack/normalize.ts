import { z } from 'zod';
import { createHash } from 'node:crypto';
import { chatEventSchema, type ChatEvent } from '../../provider.ts';
import { slackIds } from './identity.ts';
const envelopeSchema = z.object({ envelope_id: z.string().min(1).max(128), type: z.string(), payload: z.unknown(), retry_attempt: z.number().optional() });
const eventPayload = z.object({ team_id: z.string(), event_id: z.string(), event_time: z.number().optional(), authorizations: z.array(z.object({ user_id: z.string(), is_bot: z.boolean() })), event: z.record(z.string(), z.unknown()) });
const message = z.object({ type: z.enum(['message', 'app_mention']), channel: z.string(), user: slackIds.user, text: z.string().max(65536), ts: slackIds.message, thread_ts: slackIds.message.optional(), subtype: z.string().optional(), bot_id: z.string().optional(), channel_type: z.string().optional() });
export const slackEnvelope = envelopeSchema;
export async function normalizeSlackEnvelope(raw: unknown, botId: string, inspect: (channel: string) => Promise<{ id: string; kind: 'private' | 'group'; eligible: boolean }>, now: number, acceptAfter = now - 15 * 60_000): Promise<ChatEvent | undefined> {
 const envelope = envelopeSchema.parse(raw), parsedBot = slackIds.bot.safeParse(botId);
 if (!parsedBot.success) return;
 const [, team, bot] = botId.match(/^(T[A-Z0-9]+):(U[A-Z0-9]+)$/)!;
 if (envelope.type === 'slash_commands') {
  const parsed = z.object({ team_id: z.string().regex(/^T[A-Z0-9]+$/), user_id: slackIds.user, channel_id: z.string().regex(/^[CDG][A-Z0-9]+$/), command: z.literal('/cezar'), text: z.string().max(65536), trigger_id: z.string().min(1).max(256) }).safeParse(envelope.payload);
  if (!parsed.success || parsed.data.team_id !== team || parsed.data.user_id === bot) return;
  const value = parsed.data;
  const chat = await inspect(value.channel_id); if (!chat.eligible) return;
  // Slash commands are delivered over the authenticated socket without a message timestamp.
  // The stable trigger survives envelope retries; the normal journal and grants still apply.
  const id = `slash:${createHash('sha256').update(`${team}:${value.trigger_id}`).digest('hex')}`;
  const input = value.text.trim().replace(/^\//, '') || 'help';
  const text = /^(tasks|status|help)(?=\s|$)/.test(input) ? `/${input}` : '/help';
  return chatEventSchema.parse({ kind: 'message', id, messageId: id, chat, user: { id: value.user_id, label: value.user_id }, at: now, text, addressed: true });
 }
 if (envelope.type === 'events_api') {
  const parsedPayload = eventPayload.safeParse(envelope.payload); if (!parsedPayload.success) return;
  const payload = parsedPayload.data;
  if (payload.team_id !== team || !payload.authorizations.some(auth => auth.is_bot && auth.user_id === bot)) return;
  const event = payload.event;
  if (event.type === 'member_left_channel' && event.user === bot && typeof event.channel === 'string') {
   if (payload.event_time === undefined || payload.event_time * 1000 < acceptAfter || payload.event_time * 1000 > now + 60000) return;
   // Removal often makes conversations.info inaccessible. A member-left event is authoritative group evidence.
   return chatEventSchema.parse({ kind: 'membership', id: payload.event_id, chat: { id: slackIds.chat.parse(`group:${botId}:${event.channel}`), kind: 'group' }, reason: 'removed' });
  }
  const parsed = message.safeParse(event); if (!parsed.success) return;
  const value = parsed.data;
  if (value.bot_id || value.user === bot || value.subtype) return;
  const at = Math.floor(Number(value.ts) * 1000);
  if (at < acceptAfter || at < now - 15 * 60_000 || at > now + 60_000) return;
  const mention = `<@${bot}>`, threaded = value.thread_ts !== undefined && value.thread_ts !== value.ts;
  // A group drops unaddressed, uncorrelated text (conversation.ts), so only a declared non-DM skips the lookup.
  if (['channel', 'group', 'mpim'].includes(value.channel_type ?? '') && !value.channel.startsWith('D') && !value.text.includes(mention) && !threaded) return;
  const chat = await inspect(value.channel); if (!chat.eligible) return;
  const addressed = chat.kind === 'private' || value.text.includes(mention);
  let text = value.text.replaceAll(mention, '').trim().replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
  text = text.replace(/^cezar\s+(start|task|tasks|status|reply|cancel|continue|help)(?=\s|$)/i, (_match, command: string) => `/${command.toLowerCase()}`);
  const user = { id: value.user, label: value.user };
  const start = /^\/start\s+([A-Za-z0-9_-]{1,128})$/.exec(text);
  if (start && addressed) return chatEventSchema.parse({ kind: 'start', id: payload.event_id, chat, user, at, code: start[1] });
  return chatEventSchema.parse({ kind: 'message', id: `msg:${value.channel}:${value.ts}`, chat, user, at, text, addressed, messageId: value.ts,
   ...(threaded ? { replyTo: { chatId: chat.id, messageId: value.thread_ts! } } : {}) });
 }
 if (envelope.type === 'interactive') {
  const parsedPayload = z.object({ type: z.literal('block_actions'), team: z.object({ id: z.string() }), message: z.object({ user: z.string() }), user: z.object({ id: slackIds.user }), container: z.object({ channel_id: z.string(), message_ts: slackIds.message }), actions: z.array(z.object({ action_id: z.string(), value: z.string().max(128), action_ts: slackIds.message })).length(1) }).safeParse(envelope.payload);
  if (!parsedPayload.success) return;
  const payload = parsedPayload.data;
  if (payload.team.id !== team || payload.message.user !== bot) return;
  const action = payload.actions[0]!; if (!/^cezar_\d+$/.test(action.action_id)) return;
  if (Number(action.action_ts) * 1000 < acceptAfter || Number(action.action_ts) * 1000 < now - 15 * 60_000 || Number(action.action_ts) * 1000 > now + 60_000) return;
  const chat = await inspect(payload.container.channel_id); if (!chat.eligible) return;
  return chatEventSchema.parse({ kind: 'button', id: `button:${payload.container.channel_id}:${payload.user.id}:${action.action_ts}`, chat, user: { id: payload.user.id, label: payload.user.id }, receipt: { chatId: chat.id, messageId: payload.container.message_ts }, data: action.value });
 }
 return;
}
