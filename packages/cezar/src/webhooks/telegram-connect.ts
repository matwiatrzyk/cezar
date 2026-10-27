import type { Agent } from 'undici';
import type { TelegramChat, TelegramConnectResponse } from '@open-mercato/cezar-contract';
import { DestinationPolicyError, validateDestination, type DestinationPolicy, type Lookup } from './destination.ts';

// "Connect chat" (spec 2026-10-27-telegram-webhook-receivers §5a). Messages are fixed strings: the
// token is in the request path, so nothing from a failed request may reach an error message.
export class TelegramConnectError extends Error {
  constructor(readonly status: 400 | 409 | 429 | 502, message: string, readonly retryAfterSeconds?: number) { super(message); }
}
const MAX_BODY = 1024 * 1024;
const unreachable = () => new TelegramConnectError(502, 'Could not reach Telegram. Check the connection and try again.');
function untilAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('aborted'));
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

async function call(token: string, method: 'getMe' | 'getUpdates', body: object, policy: DestinationPolicy, lookup?: Lookup, parentSignal?: AbortSignal): Promise<{ status: number; data: Record<string, unknown> }> {
  const controller = new AbortController();
  const abortParent = () => controller.abort();
  if (parentSignal?.aborted) controller.abort();
  else parentSignal?.addEventListener('abort', abortParent, { once: true });
  const timer = setTimeout(() => controller.abort(), 10_000);
  let dispatcher: Agent | undefined;
  try {
    const target = await untilAbort(validateDestination(`https://api.telegram.org/bot${token}/${method}`, { ...policy, allowLocalNetwork: false }, lookup), controller.signal);
    const { Agent, request } = await import('undici');
    dispatcher = new Agent({ connections: 1, pipelining: 1, connect: { rejectUnauthorized: true, autoSelectFamily: false,
      lookup(_hostname, options, callback) {
        if (options.all) callback(null, [{ address: target.address, family: target.family }]);
        else callback(null, target.address, target.family);
      } } });
    const result = await request(target.url, { dispatcher, method: 'POST', body: JSON.stringify(body), signal: controller.signal,
      maxRedirections: 0, headersTimeout: 10_000, bodyTimeout: 10_000, headers: { 'content-type': 'application/json', 'user-agent': 'cezar-webhooks/1' } });
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of result.body) {
      size += chunk.length;
      if (size > MAX_BODY) { result.body.destroy(); throw unreachable(); }
      chunks.push(Buffer.from(chunk));
    }
    const data: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!data || typeof data !== 'object') throw unreachable();
    return { status: result.statusCode, data: data as Record<string, unknown> };
  } catch (error) {
    if (error instanceof TelegramConnectError) throw error;
    if (error instanceof DestinationPolicyError) throw new TelegramConnectError(409, 'Telegram is not reachable under this server’s destination policy.');
    throw unreachable();
  } finally {
    clearTimeout(timer);
    if (dispatcher) await dispatcher.destroy().catch(() => undefined);
    parentSignal?.removeEventListener('abort', abortParent);
  }
}

// Telegram puts the 429 delay in `parameters.retry_after`; bound it so a bad value cannot stall setup.
function rateLimited(response: { status: number; data: Record<string, unknown> }): void {
  if (response.status !== 429) return;
  const wait = record(response.data.parameters)?.retry_after;
  throw new TelegramConnectError(429, 'Telegram is rate-limiting this bot; cezar will try again shortly.',
    typeof wait === 'number' && Number.isSafeInteger(wait) && wait > 0 ? Math.min(wait, 60) : 5);
}
const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
const text = (value: unknown, limit = 256) => typeof value === 'string' ? value.slice(0, limit) : undefined;
function chatOf(value: unknown): TelegramChat | undefined {
  const chat = record(value);
  const type = chat?.type;
  if (!chat || !Number.isSafeInteger(chat.id) || (type !== 'private' && type !== 'group' && type !== 'supergroup' && type !== 'channel')) return undefined;
  const person = [text(chat.first_name), text(chat.last_name)].filter(Boolean).join(' ');
  const title = text(chat.title) ?? (person || (text(chat.username) ? `@${text(chat.username)}` : String(chat.id)));
  return { id: String(chat.id), type, title: title.slice(0, 256) };
}

/** Reads the bot's pending updates without consuming them (no offset) and keeps only chat identities. */
export async function telegramConnect(input: { token: string; code: string }, options: { policy: DestinationPolicy; lookup?: Lookup; dryRun?: boolean; signal?: AbortSignal }): Promise<TelegramConnectResponse> {
  if (options.dryRun) {
    const chat: TelegramChat = { id: '-1001234567890', type: 'group', title: 'Dry-run chat' };
    return { bot: { username: 'cezar_dry_run_bot', name: 'cezar (dry run)' }, chats: [chat], match: chat };
  }
  const me = await call(input.token, 'getMe', {}, options.policy, options.lookup, options.signal);
  rateLimited(me);
  if (me.status === 401 || me.status === 404) throw new TelegramConnectError(400, 'Telegram rejected this bot token. Copy it again from @BotFather.');
  const bot = record(me.data.result);
  if (me.status !== 200 || me.data.ok !== true || !bot || typeof bot.username !== 'string') throw unreachable();
  const username = bot.username.slice(0, 64);
  // No allowed_updates: Telegram remembers it for the bot, which would change another consumer's feed.
  const updates = await call(input.token, 'getUpdates', { limit: 100, timeout: 0 }, options.policy, options.lookup, options.signal);
  rateLimited(updates);
  // 409 means a webhook is set or another app is long-polling; never delete or outrun it.
  if (updates.status === 409) throw new TelegramConnectError(409, 'This bot already delivers its updates to another app (a webhook or a polling bot). Use a bot dedicated to cezar, or enter the chat ID by hand.');
  if (updates.status !== 200 || updates.data.ok !== true || !Array.isArray(updates.data.result)) throw unreachable();
  const escaped = username.replace(/[^A-Za-z0-9_]/g, '');
  const start = new RegExp(`^/start(?:@${escaped})?\\s+${input.code}$`, 'i');
  const chats = new Map<string, TelegramChat>();
  let match: TelegramChat | undefined;
  for (const update of updates.data.result) {
    const item = record(update);
    const message = record(item?.message) ?? record(item?.channel_post);
    const member = record(item?.my_chat_member);
    const chat = chatOf(message?.chat ?? member?.chat);
    if (!chat) continue;
    chats.delete(chat.id); chats.set(chat.id, chat);
    const body = text(message?.text, 128)?.trim();
    // Channels have no start link, so posting the bare code there counts too.
    if (body && (start.test(body) || body === input.code)) match = chat;
  }
  return { bot: { username, name: text(bot.first_name) ?? username }, chats: [...chats.values()].reverse().slice(0, 20), ...(match ? { match } : {}), ...(updates.data.result.length >= 100 ? { truncated: true } : {}) };
}
