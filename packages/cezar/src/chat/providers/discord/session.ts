import { z } from 'zod';
import { ChatTransportError, type ChatSession, type ChatEvent } from '../../provider.ts';
import { channelIdentity, parseChat, snowflake } from './identity.ts';
import { discordChannelMember } from './membership.ts';
import type { DiscordRequest } from './rest.ts';
export const discordUser = z.object({ id: snowflake, username: z.string().min(1).max(128), bot: z.boolean().optional() });
export const discordMessage = z.object({ id: snowflake, channel_id: snowflake, guild_id: snowflake.optional(), author: discordUser, content: z.string().max(65536), timestamp: z.iso.datetime({ offset: true }), message_reference: z.object({ message_id: snowflake.optional(), channel_id: snowflake.optional() }).optional(), referenced_message: z.object({ id: snowflake, channel_id: snowflake, author: discordUser }).nullable().optional() });
export function discordSession(request: DiscordRequest): ChatSession & { inspect(id: string): Promise<{ id: string; kind: 'private' | 'group'; eligible: boolean }> } {
 const inspect = async (id: string, signal?: AbortSignal) => {
  const expected = parseChat(id), actual = channelIdentity(await request('GET', `/channels/${expected.channel}`, undefined, signal));
  if (actual.id !== id) throw new ChatTransportError({ kind: 'blocked' }); return actual;
 };
 return {
  async identify(signal) { const me = discordUser.parse(await request('GET', '/users/@me', undefined, signal)); if (!me.bot) throw new ChatTransportError({ kind: 'auth' }); return { id: me.id, username: me.id }; },
  async inspect(id) { const chat = await inspect(id); return { id, kind: chat.kind, eligible: true }; },
  async send(id, message, signal, valid) {
   const buttons = message.buttons?.flat() ?? [];
   if (!message.text.length || message.text.length > 2000 || buttons.length > 25) throw new ChatTransportError({ kind: 'blocked' });
   const rows = Array.from({ length: Math.ceil(buttons.length / 5) }, (_, index) => buttons.slice(index * 5, index * 5 + 5));
   const components = rows.map(row => {
    if (!row.length || row.length > 5) throw new ChatTransportError({ kind: 'blocked' });
    return { type: 1, components: row.map(button => { if (button.text.length > 80 || button.data.length > 100) throw new ChatTransportError({ kind: 'blocked' }); return { type: 2, style: 1, label: button.text, custom_id: button.data }; }) };
   });
   const chat = await inspect(id, signal);
   const parsed = z.object({ id: snowflake, channel_id: snowflake }).safeParse(await request('POST', `/channels/${chat.channel.id}/messages`, { content: message.text, allowed_mentions: { parse: [], replied_user: false }, flags: 4, components }, signal, valid));
   if (!parsed.success) throw new ChatTransportError({ kind: 'blocked' });
   const result = parsed.data;
   if (result.channel_id !== chat.channel.id) throw new ChatTransportError({ kind: 'blocked' });
   return { chatId: id, messageId: result.id };
  },
  async clearButtons(receipt, signal) { const chat = await inspect(receipt.chatId, signal); snowflake.parse(receipt.messageId); await request('PATCH', `/channels/${chat.channel.id}/messages/${receipt.messageId}`, { components: [], allowed_mentions: { parse: [] } }, signal); },
  // Component interactions are deferred by ingress within Discord's three-second deadline.
  async acknowledge() {},
  async isMember(id, userId, signal) {
   try {
    snowflake.parse(userId); const chat = await inspect(id, signal);
    if (chat.kind === 'private') return chat.channel.recipients?.some(user => user.id === userId);
    return await discordChannelMember(request, chat.channel.id, chat.channel.guild_id!, userId, signal);
   } catch (error) { return error instanceof ChatTransportError && error.failure.kind === 'gone' ? false : undefined; }
  },
 };
}
/** Channel identities the Gateway has resolved; the owner bounds it and invalidates it on channel events. */
export type DiscordChannelCache = Map<string, ReturnType<typeof channelIdentity>>;
// A group hears only mentions and Replies to this bot (conversation.ts), so other chatter needs no lookup.
const relevant = (message: z.infer<typeof discordMessage>, botId: string, mention: RegExp) => !message.author.bot && (!message.guild_id || mention.test(message.content) || message.referenced_message?.author.id === botId);
const mentionOf = (botId: string) => new RegExp(`^<@!?${botId}>\\s*`);
/** False for a MESSAGE_CREATE that normalizeDiscordMessage would ignore without a lookup. */
export function discordMessageRelevant(value: unknown, botId: string): boolean { const parsed = discordMessage.safeParse(value); return parsed.success && relevant(parsed.data, botId, mentionOf(botId)); }
export async function normalizeDiscordMessage(value: unknown, botId: string, request: DiscordRequest, channels?: DiscordChannelCache, signal?: AbortSignal): Promise<ChatEvent | undefined> {
 const parsed = discordMessage.safeParse(value); if (!parsed.success) return;
 const message = parsed.data, mention = mentionOf(botId);
 if (!relevant(message, botId, mention)) return;
 let actual = channels?.get(message.channel_id);
 if (!actual || actual.channel.guild_id !== message.guild_id) {
  channels?.delete(message.channel_id);
  const metadata = await request('GET', `/channels/${message.channel_id}`, undefined, signal);
  try { actual = channelIdentity(metadata); } catch { return; }
  if (actual.channel.id !== message.channel_id || actual.channel.guild_id !== message.guild_id) return;
  if (channels) { channels.set(message.channel_id, actual); if (channels.size > 512) channels.delete(channels.keys().next().value!); }
 }
 const addressed = actual.kind === 'private' || mention.test(message.content);
 const text = message.content.replace(mention, '');
 const user = { id: message.author.id, label: message.author.username, username: message.author.username };
 const common = { id: `message:${message.id}`, chat: { id: actual.id, kind: actual.kind }, user, at: Date.parse(message.timestamp) };
 const code = /^\/start\s+([A-Za-z0-9_-]{1,128})$/.exec(text)?.[1];
 if (code && addressed) return { ...common, kind: 'start', code };
 const ref = message.referenced_message;
 const reply = ref && ref.author.id === botId && ref.channel_id === message.channel_id && message.message_reference?.channel_id === message.channel_id && message.message_reference.message_id === ref.id;
 return { ...common, kind: 'message', text, messageId: message.id, addressed, ...(reply ? { replyTo: { chatId: actual.id, messageId: ref.id } } : {}) };
}
