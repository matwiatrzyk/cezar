import { z } from 'zod';
import { ChatTransportError, chatMessageSchema, chatReceiptSchema, type ChatTransport, type ChatServiceDescriptor } from '../../provider.ts';
import { slackCredentials, slackIds, slackChat, decodeSlackCredentials } from './identity.ts';
import { slackPresentation } from './presentation.ts';
import { type SlackWire, slackError } from './client.ts';
import { slackConnection } from './connection.ts';
export const slackMessageSchema = chatMessageSchema.extend({ replyTo: chatReceiptSchema.optional() });
const identity = z.object({ team_id: z.string().regex(/^T[A-Z0-9]+$/), user_id: slackIds.user });
const conversation = z.object({ channel: z.object({ id: z.string(), is_im: z.boolean(), is_mpim: z.boolean().optional(), is_archived: z.boolean().optional(), is_member: z.boolean().optional(), user: z.string().optional() }) });
export const slackServiceDescriptor: ChatServiceDescriptor = {
 id: 'slack', label: 'Slack', format: 'slack.v1', credentials: slackCredentials, ids: slackIds, presentation: slackPresentation,
 limits: { maxText: 4000, buttonsPerMessage: 25, perChatPerSecond: 1, perBotPerSecond: 10 },
 destination(credential) { decodeSlackCredentials(credential); return 'https://slack.com/api/chat.postMessage'; },
 credentialBotId: () => undefined,
};
type Inspected = { id: string; kind: 'private' | 'group'; eligible: boolean; membership: boolean | undefined; user: string | undefined };
const CACHE_TTL_MS = 5 * 60_000, CACHE_SIZE = 500;
/** Shared by a transport and its guarded views, so a fresh check or a gone error reaches the inbound cache. */
interface SlackShared { channels: Map<string, { value: Inspected; until: number }>; texts: Map<string, string>; infoLimitedUntil: number }
function remember<V>(map: Map<string, V>, key: string, value: V) { map.delete(key); map.set(key, value); if (map.size > CACHE_SIZE) map.delete(map.keys().next().value!); }
function sections(text: string): unknown[] {
 const blocks: unknown[] = [];
 let remaining = text;
 while (remaining) {
  let end = Math.min(3000, remaining.length);
  const amp = remaining.lastIndexOf('&', end - 1);
  if (amp >= 0 && remaining.indexOf(';', amp) >= end) end = amp;
  if (/[\uD800-\uDBFF]/.test(remaining[end - 1] ?? '')) end--;
  if (!end) throw slackError('blocked');
  blocks.push({ type: 'section', text: { type: 'mrkdwn', text: remaining.slice(0, end), verbatim: true } });
  remaining = remaining.slice(end);
 }
 return blocks;
}
export function slackTransport(wire: SlackWire, valid: () => boolean = () => true, shared: SlackShared = { channels: new Map(), texts: new Map(), infoLimitedUntil: 0 }): ChatTransport {
 let me: { id: string; username: string } | undefined;
 const call: SlackWire['call'] = async (method, body, signal, guard) => {
  if (signal?.aborted || !valid() || (guard && !guard())) throw slackError('blocked');
  try { return await wire.call(method, body, signal, () => valid() && (!guard || guard())); } catch (error) {
   if (error instanceof ChatTransportError && error.failure.kind === 'gone' && typeof body.channel === 'string') shared.channels.delete(body.channel);
   throw error;
  }
 };
 const identify = async (signal?: AbortSignal) => {
  const result = identity.parse(await call('auth.test', {}, signal));
  const id = slackIds.bot.parse(`${result.team_id}:${result.user_id}`);
  me = { id, username: id }; return me;
 };
 const checkChat = async (id: string, signal?: AbortSignal) => {
  const ref = slackChat(id), bot = me ?? await identify(signal);
  if (ref.botId !== bot.id) throw slackError('blocked');
  return ref;
 };
 // Inbound events may reuse an eligible lookup; authorization paths always ask Slack.
 const inspectNative = async (channel: string, signal?: AbortSignal, cached = false): Promise<Inspected> => {
  const bot = me ?? await identify(signal), hit = shared.channels.get(channel);
  if (cached && hit && hit.until > Date.now() && slackChat(hit.value.id).botId === bot.id) return hit.value;
  if (Date.now() < shared.infoLimitedUntil) throw slackError('ratelimited', shared.infoLimitedUntil - Date.now());
  let raw: unknown;
  try { raw = await call('conversations.info', { channel }, signal); } catch (error) {
   if (error instanceof ChatTransportError && error.failure.kind === 'rate_limited') shared.infoLimitedUntil = Date.now() + (error.failure.retryAfterMs ?? 5000);
   throw error;
  }
  const { channel: info } = conversation.parse(raw);
  if (info.id !== channel) throw slackError('blocked');
  const kind = info.is_im && info.is_mpim !== true ? 'private' : 'group';
  const id = slackIds.chat.parse(`${kind}:${bot.id}:${channel}`);
  // Inspection fails closed; membership must retain missing evidence as unknown.
  const membership = info.is_archived === true ? false : kind === 'private' ? true : info.is_member;
  const value: Inspected = { id, kind, eligible: membership === true, membership, user: info.user };
  if (value.eligible) remember(shared.channels, channel, { value, until: Date.now() + CACHE_TTL_MS }); else shared.channels.delete(channel);
  return value;
 };
 const transport: ChatTransport = {
  identify,
  guarded(guard) { return slackTransport(wire, () => valid() && guard(), shared); },
  async inspect(id) { const ref = await checkChat(id); const inspected = await inspectNative(ref.channel); if (inspected.id !== id) throw slackError('blocked'); return inspected; },
  async send(id, message, signal, guard) {
   const ref = await checkChat(id, signal);
   const thread = slackMessageSchema.parse(message).replyTo;
   if (thread && thread.chatId !== id) throw slackError('blocked');
   if (thread) slackIds.message.parse(thread.messageId);
   const buttons = message.buttons?.flat() ?? [];
   if (!message.text || message.text.length > 4000 || buttons.length > 25 || buttons.some(button => button.text.length > 75 || button.data.length > 128)) throw slackError('blocked');
   const blocks = sections(message.text);
   if (buttons.length) blocks.push({ type: 'actions', elements: buttons.map((button, index) => ({ type: 'button', action_id: `cezar_${index}`, text: { type: 'plain_text', text: button.text, emoji: false }, value: button.data })) });
   const result = z.object({ channel: z.string(), ts: slackIds.message }).parse(await call('chat.postMessage', { channel: ref.channel, ...(thread ? { thread_ts: thread.messageId } : {}), text: message.text, mrkdwn: true, parse: 'none', unfurl_links: false, unfurl_media: false, ...(buttons.length ? { blocks } : {}) }, signal, guard));
   if (result.channel !== ref.channel) throw slackError('blocked');
   if (buttons.length) remember(shared.texts, `${ref.channel}:${result.ts}`, message.text);
   return { chatId: id, messageId: result.ts };
  },
  // chat.update needs text: keep the original sections, and never overwrite a message whose text is unknown.
  async clearButtons(receipt, signal) {
   const ref = await checkChat(receipt.chatId, signal); slackIds.message.parse(receipt.messageId);
   const key = `${ref.channel}:${receipt.messageId}`;
   let text = shared.texts.get(key);
   if (text === undefined) {
    const messages = z.object({ messages: z.array(z.object({ ts: z.string(), user: z.string().optional(), text: z.string().optional() })) });
    const history = messages.parse(await call('conversations.history', { channel: ref.channel, latest: receipt.messageId, oldest: receipt.messageId, inclusive: true, limit: 1 }, signal));
    text = history.messages.find(item => item.ts === receipt.messageId && item.user === ref.bot)?.text;
    // conversations.history omits thread replies; answer buttons are often sent into a thread.
    if (text === undefined) {
     const replies = messages.parse(await call('conversations.replies', { channel: ref.channel, ts: receipt.messageId, latest: receipt.messageId, inclusive: true, limit: 1 }, signal));
     text = replies.messages.find(item => item.ts === receipt.messageId && item.user === ref.bot)?.text;
    }
   }
   if (!text || text.length > 4000) return;
   await call('chat.update', { channel: ref.channel, ts: receipt.messageId, text, blocks: sections(text) }, signal);
   shared.texts.delete(key);
  },
  // Socket envelopes are acknowledged immediately, before serialized core work.
  async acknowledge() {},
  async isMember(id, userId, signal) {
   try {
    const ref = await checkChat(id, signal), info = await inspectNative(ref.channel, signal);
    if (info.id !== id || info.membership === false) return false;
    if (info.membership === undefined) return undefined;
    if (ref.kind === 'private') return userId === ref.botId ? true : info.user === undefined ? undefined : info.user === userId;
    let cursor = '';
    for (let page = 0; page < 100; page++) {
     const result = z.object({ members: z.array(z.string()), response_metadata: z.object({ next_cursor: z.string().optional() }).optional() }).parse(await call('conversations.members', { channel: ref.channel, limit: 200, ...(cursor ? { cursor } : {}) }, signal));
     if (result.members.includes(userId) || (userId === ref.botId && result.members.includes(ref.bot))) return true;
     cursor = result.response_metadata?.next_cursor ?? ''; if (!cursor) return false;
    }
    return undefined;
   } catch (error) { return error instanceof ChatTransportError && error.failure.kind === 'gone' ? false : undefined; }
  },
  connect(_journal, options, now) { return slackConnection({ wire: { call, socket: (url, guard) => wire.socket(url, () => valid() && guard()) }, identify, inspectNative, forget: channel => { shared.channels.delete(channel); }, valid, options, now }); },
 };
 return transport;
}
