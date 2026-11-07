import WebSocket from 'ws';
import { z } from 'zod';
import type { ChatConnection, ChatConnectionOptions, ChatHealth } from '../../connection.ts';
import { chatEventSchema, ChatTransportError } from '../../provider.ts';
import { discordApplicationCommands, discordCommandInteractionCallback } from './native-commands.ts';
import { channelIdentity, snowflake } from './identity.ts';
import { discordMessageRelevant, discordUser, normalizeDiscordMessage, type DiscordChannelCache } from './session.ts';
import type { DiscordRequest } from './rest.ts';
const frameSchema = z.object({ op: z.number().int(), d: z.unknown().optional(), s: z.number().int().nonnegative().nullable().optional(), t: z.string().nullable().optional() });
const readySchema = z.object({ session_id: z.string().min(1), resume_gateway_url: z.string().url(), user: discordUser });
const interactionSchema = z.object({ id: snowflake, application_id: snowflake, type: z.union([z.literal(2), z.literal(3), z.literal(4)]), token: z.string().regex(/^[A-Za-z0-9_.-]{1,2048}$/), channel_id: snowflake, guild_id: snowflake.optional(), user: discordUser.optional(), member: z.object({ user: discordUser }).optional(), data: z.object({ custom_id: z.string().min(1).max(100).optional(), component_type: z.literal(2).optional(), name: z.string().optional(), options: z.array(z.object({ name: z.string(), value: z.union([z.string(), z.number(), z.boolean()]), focused: z.boolean().optional() })).optional() }).optional(), message: z.object({ id: snowflake, channel_id: snowflake, author: discordUser }).optional() });
// Only event-scoped REST failures may be discarded; guards and session failures stay fatal.
class DiscordInputFailure extends Error {}
// A rate-limited lookup parks its event off the serial queue so later input keeps flowing.
class DiscordHold extends Error { constructor(readonly wait: number) { super('hold'); } }
const HOLD_LIMIT_MS = 60000, HOLD_CAP = 100, ACK_DEADLINE_MS = 2500, LOOKUP_TIMEOUT_MS = 10000, DROP_REPORT_MS = 60000;
const CHANNEL_EVENTS = ['CHANNEL_UPDATE', 'CHANNEL_DELETE', 'THREAD_UPDATE', 'THREAD_DELETE'];
export const DISCORD_INTENTS = 1 | 512 | 4096 | 32768;
export type DiscordSocketFactory = (url: string) => WebSocket;
export function discordGateway(input: { token: string | (() => Promise<string>); request: DiscordRequest; options: ChatConnectionOptions; valid(): boolean; socket?: DiscordSocketFactory; now?: () => number; onReceiveCursor?: (cursor: number) => void }): ChatConnection {
 const { options, request } = input, now = input.now ?? Date.now;
 let health: ChatHealth = { state: 'stopped' }, running: Promise<void> | undefined, stopped = true;
 let socket: WebSocket | undefined, controller = new AbortController(), session: string | undefined, resumeUrl: string | undefined, sequence: number | null = null;
 let token = '', commandsRegistered = false;
 let queue = Promise.resolve(), pending = 0, startsRemaining = 0, startsResetAt = 0, fail: (error: unknown) => void = () => {};
 const holds = new Set<Promise<void>>();
 const knownChannels = new Map<string, { id: string; kind: 'private' | 'group'; guild?: string }>();
 const channels: DiscordChannelCache = new Map();
 const active = () => !stopped && input.valid() && options.needed() && !controller.signal.aborted;
 const guard = async () => { token = typeof input.token === 'string' ? input.token : await input.token(); try { await options.assertCredentials(); } catch { throw new ChatTransportError({ kind: 'blocked' }); } if (!active()) throw new ChatTransportError({ kind: 'blocked' }); };
 const retryAfter = (error: ChatTransportError) => Math.max(error.failure.kind === 'rate_limited' ? error.failure.retryAfterMs ?? 1000 : 1000, 50);
 const eventRequest: DiscordRequest = async (...args) => {
  try { return await request(...args); }
  catch (error) {
   if (!(error instanceof ChatTransportError) || error.failure.kind === 'auth') throw error;
   // A permission loss rejects this input, but a lost credential or
   // ownership fence must still stop the connection, including mid-request changes.
   await guard();
   if (error.failure.kind === 'rate_limited') throw new DiscordHold(retryAfter(error));
   throw new DiscordInputFailure();
  }
 };
 // The deferred ACK retries a 429 only while Discord's interaction deadline allows it.
 const acknowledge = async (path: string, body: { type: number; data?: { flags: number } } = { type: 6 }) => {
  const deadline = Date.now() + ACK_DEADLINE_MS, signal = AbortSignal.any([controller.signal, AbortSignal.timeout(ACK_DEADLINE_MS)]);
  for (;;) try { await guard(); await request('POST', path, body, signal, active); return; }
  catch (error) {
   if (!(error instanceof ChatTransportError) || error.failure.kind === 'auth') throw error;
   await guard();
   if (error.failure.kind === 'rate_limited' && Date.now() + retryAfter(error) < deadline) { await delay(retryAfter(error)); continue; }
   throw new DiscordInputFailure();
  }
 };
 type Ack = { promise: Promise<void>; settled: boolean };
 type Item = { type: string; data: unknown; botId: string; seq: number; ack?: Ack; since?: number };
 // Per-chat FIFO: while a chat's event is parked, later events of that chat queue behind it.
 const lanes = new Map<string, Item[]>();
 let parked = 0, unkeyed = 0;
 // Channel lifecycle events do no lookup and carry membership removal: never capped or dropped (spec).
 const exempt = (item: Item) => CHANNEL_EVENTS.includes(item.type);
 const invalidate = (data: unknown) => { const id = z.object({ id: snowflake }).safeParse(data); if (id.success) channels.delete(id.data.id); };
 // Dropped input is reported as one bounded, id-free warning per window.
 let drops = new Map<string, number>(), dropTimer: ReturnType<typeof setTimeout> | undefined;
 const reportDrops = (rearm = true) => {
  dropTimer = undefined; if (!drops.size) return;
  const summary = [...drops].map(([what, count]) => `${count} ${what}`).join(', '); drops = new Map();
  console.warn(`Discord dropped held chat input (${summary}); Gateway resume cannot replay it.`);
  if (rearm) { dropTimer = setTimeout(reportDrops, DROP_REPORT_MS); dropTimer.unref?.(); }
 };
 const dropped = (item: Item, reason: 'cap' | 'budget') => {
  const guild = typeof item.data === 'object' && item.data && 'guild_id' in item.data && item.data.guild_id;
  const what = `${guild ? 'guild' : 'direct'} over the ${reason === 'cap' ? `${HOLD_CAP}-event hold cap` : `${HOLD_LIMIT_MS / 1000} s hold budget`}`;
  drops.set(what, (drops.get(what) ?? 0) + 1); if (!dropTimer) reportDrops();
 };
 const laneOf = ({ type, data }: Item) => {
  const d = typeof data === 'object' && data ? data as { channel_id?: unknown; id?: unknown } : {};
  const id = ['MESSAGE_CREATE', 'INTERACTION_CREATE'].includes(type) ? d.channel_id : CHANNEL_EVENTS.includes(type) ? d.id : undefined;
  return typeof id === 'string' ? id : `#${++unkeyed}`;
 };
 const clear = (key: string) => { const lane = lanes.get(key); if (lane) { parked -= lane.filter(item => !exempt(item)).length; lanes.delete(key); } };
 const release = (key: string, wait: Promise<unknown>) => {
  const hold: Promise<void> = wait.then(() => {}, () => {}).then(() => { holds.delete(hold); if (!active()) { clear(key); return; } queue = queue.then(() => drain(key)).catch(() => {}); });
  holds.add(hold);
 };
 // Runs a lane from its head; returns while its head is parked on a hold or an unsettled ACK.
 async function drain(key: string) {
  const lane = lanes.get(key); if (!lane) return;
  while (lane.length) {
   const item = lane[0]!;
   if (item.ack && !item.ack.settled) { release(key, item.ack.promise); return; }
   try { await receive(item.type, item.data, item.botId, item.seq, item.ack?.promise); }
   catch (error) {
    if (error instanceof DiscordHold) {
     item.since ??= Date.now();
     // Past the budget or cap only this event is dropped: Gateway resume cannot replay it (spec).
     const inBudget = Date.now() - item.since + error.wait <= HOLD_LIMIT_MS;
     if (inBudget && parked <= HOLD_CAP) { release(key, delay(error.wait)); return; }
     dropped(item, inBudget ? 'cap' : 'budget');
    } else if (!(error instanceof DiscordInputFailure)) fail(error);
   }
   lane.shift(); if (!exempt(item)) parked--;
  }
  lanes.delete(key);
 }
 function dispatch(item: Item) {
  queue = queue.then(() => {
   const key = laneOf(item), lane = lanes.get(key);
   if (exempt(item)) invalidate(item.data);
   if (lane) {
    // Chatter the core ignores needs no order and must not consume the cap.
    if (item.type === 'MESSAGE_CREATE' && !discordMessageRelevant(item.data, item.botId)) return;
    // The cache is already invalidated, so one queued removal per type keeps the lane bounded.
    if (exempt(item)) { if (!lane.some(queued => queued.type === item.type)) lane.push(item); return; }
    if (parked < HOLD_CAP) { item.since = Date.now(); lane.push(item); parked++; } else dropped(item, 'cap');
    return;
   }
   lanes.set(key, [item]); if (!exempt(item)) parked++; return drain(key);
  }).catch(() => {}).finally(() => { pending--; });
 }
 const update = (state: ChatHealth['state']) => { health = { state, ...(state === 'polling' ? { lastSuccessfulPollAt: now() } : {}) }; options.onHealth(health); };
 // Lookups share REST's 10 s timeout; a hung GET still stalls the serial receive queue that long (spec).
 const lookupSignal = () => AbortSignal.any([controller.signal, AbortSignal.timeout(LOOKUP_TIMEOUT_MS)]);
 const delay = (ms: number) => new Promise<void>(resolve => { const done = () => { clearTimeout(timer); controller.signal.removeEventListener('abort', done); resolve(); }; const timer = setTimeout(done, ms); controller.signal.addEventListener('abort', done, { once: true }); });
 const gatewayUrl = (url: string) => { const parsed = new URL(url); if (parsed.protocol !== 'wss:' || !/^gateway(?:-[a-z0-9-]+)?\.discord\.gg$/.test(parsed.hostname) || parsed.port || parsed.pathname !== '/' || parsed.username || parsed.password) throw new ChatTransportError({ kind: 'blocked' }); parsed.search = '?v=10&encoding=json'; return parsed.toString(); };
  async function receive(type: string, data: unknown, botId: string, seq: number, acknowledged?: Promise<void>) {
  await guard();
  if (CHANNEL_EVENTS.includes(type)) invalidate(data);
  if (type === 'GUILD_DELETE') { const guild = z.object({ id: snowflake, unavailable: z.boolean().optional() }).safeParse(data); if (guild.success && !guild.data.unavailable) for (const [id, chat] of channels) if (chat.channel.guild_id === guild.data.id) channels.delete(id); }
  if (type === 'MESSAGE_CREATE') { const event = await normalizeDiscordMessage(data, botId, eventRequest, channels, lookupSignal()); await guard(); if (event) { const parts = event.chat.id.split(':'); knownChannels.set(parts.at(-1)!, { ...event.chat, ...(parts[1] === 'guild' ? { guild: parts[2]! } : {}) }); await options.accept(chatEventSchema.parse(event)); } }
  if (type === 'INTERACTION_CREATE') {
   const parsed = interactionSchema.safeParse(data); if (!parsed.success) return;
   const event = parsed.data, user = event.member?.user ?? event.user;
   if (!user || user.bot || event.application_id !== botId) return;
   if (event.type === 4) {
    if (event.data?.name !== 'tasks' || !event.data.options?.some(option => option.focused && option.name === 'task')) return;
    const focused = event.data.options.find(option => option.focused && option.name === 'task')?.value;
    if (typeof focused !== 'string') return;
    const chat = channelIdentity(await eventRequest('GET', `/channels/${event.channel_id}`, undefined, lookupSignal()));
    if (chat.channel.id !== event.channel_id || chat.channel.guild_id !== event.guild_id) return;
    const choices = await input.options.nativeCommands?.tasks(focused, chat.id, user.id) ?? [];
    await eventRequest('POST', `/interactions/${event.id}/${event.token}/callback`, discordCommandInteractionCallback(choices), undefined, active);
    return;
   }
   if (event.type === 3) {
    if (!event.data?.custom_id || !event.message || event.message.author.id !== botId || event.message.channel_id !== event.channel_id) return;
    await acknowledged;
    const chat = channelIdentity(await eventRequest('GET', `/channels/${event.channel_id}`, undefined, lookupSignal()));
    if (chat.channel.id !== event.channel_id || chat.channel.guild_id !== event.guild_id) return;
    await guard(); await options.accept(chatEventSchema.parse({ kind: 'button', id: `interaction:${event.id}`, chat: { id: chat.id, kind: chat.kind }, user: { id: user.id, label: user.username }, receipt: { chatId: chat.id, messageId: event.message.id }, data: event.data.custom_id }));
    return;
   }
   if (event.type !== 2 || !event.data?.name) return;
   if (event.data.name !== 'tasks') return;
   await acknowledged;
   try {
    const chat = channelIdentity(await eventRequest('GET', `/channels/${event.channel_id}`, undefined, lookupSignal()));
    if (chat.channel.id !== event.channel_id || chat.channel.guild_id !== event.guild_id) return;
    const argument = event.data.options?.find(option => option.name === 'task')?.value;
    const text = typeof argument === 'string' && argument ? `/status ${argument}` : '/tasks';
    await guard(); await options.accept(chatEventSchema.parse({ kind: 'message', id: `interaction:${event.id}`, chat: { id: chat.id, kind: chat.kind }, user: { id: user.id, label: user.username }, at: Date.now(), messageId: event.id, text, addressed: true }));
   } finally {
    // Finish the private deferred response even when the command is refused. The chat
    // core owns the actual reply and authorization; this receipt exposes no task data.
    await request('PATCH', `/webhooks/${event.application_id}/${event.token}/messages/@original`, { content: 'Command received. If you have access, Cezar replies in this chat.', allowed_mentions: { parse: [] } }, controller.signal, active).catch(() => undefined);
   }
  }
  if (type === 'GUILD_CREATE') {
   const guild = z.object({ id: snowflake, channels: z.array(z.unknown()) }).safeParse(data);
   if (guild.success) for (const raw of guild.data.channels) { try { const chat = channelIdentity({ ...raw as object, guild_id: guild.data.id }); knownChannels.set(chat.channel.id, { id: chat.id, kind: chat.kind, guild: guild.data.id }); } catch { /* Unsupported channel. */ } }
  }
  if (type === 'GUILD_DELETE' || type === 'CHANNEL_DELETE') {
   const removed = z.object({ id: snowflake, unavailable: z.boolean().optional() }).safeParse(data);
   if (!removed.success || removed.data.unavailable) return;
   for (const [channel, chat] of knownChannels) if (type === 'GUILD_DELETE' ? chat.guild === removed.data.id : channel === removed.data.id) {
    await guard(); await options.accept({ kind: 'membership', id: `removed:${removed.data.id}:${channel}:${seq}`, chat: { id: chat.id, kind: chat.kind }, reason: 'removed' }); knownChannels.delete(channel);
   }
  }
 }
 async function cycle(url: string): Promise<void> {
  await guard();
  await new Promise<void>((resolve, reject) => {
   if (!active()) { reject(new ChatTransportError({ kind: 'blocked' })); return; }
   const ws = (input.socket ?? (url => new WebSocket(url, { maxPayload: 1024 * 1024, handshakeTimeout: 10000 })))(gatewayUrl(url)); socket = ws;
   let heartbeat: ReturnType<typeof setTimeout> | undefined, acknowledged = true, botId = '', settled = false;
   const handshake = setTimeout(() => finish(), 15000);
   const abort = () => finish();
   controller.signal.addEventListener('abort', abort, { once: true });
   const finish = (error?: unknown) => { if (settled) return; settled = true; if (fail === finish) fail = () => {}; clearTimeout(handshake); clearTimeout(heartbeat); controller.signal.removeEventListener('abort', abort); ws.removeAllListeners(); ws.on('error', () => {}); ws.terminate(); if (error) reject(error); else resolve(); };
   fail = finish;
   const send = async (op: number, d: unknown) => { await guard(); if (settled || !active() || ws.readyState !== WebSocket.OPEN) return; ws.send(JSON.stringify({ op, d })); };
   const beat = async (interval: number) => { if (!acknowledged) { finish(); return; } acknowledged = false; try { await send(1, sequence); } catch (error) { finish(error); return; } if (!settled && active()) heartbeat = setTimeout(() => { void beat(interval); }, interval); };
   ws.on('error', () => finish());
   ws.on('close', code => { if ([4004, 4010, 4011, 4012, 4013, 4014].includes(code)) finish(new ChatTransportError({ kind: code === 4004 ? 'auth' : 'blocked' })); else { if ([4007, 4009].includes(code)) { session = undefined; resumeUrl = undefined; sequence = null; } finish(); } });
   ws.on('message', raw => {
    let frame: z.infer<typeof frameSchema>; try { frame = frameSchema.parse(JSON.parse(raw.toString())); } catch { finish(new ChatTransportError({ kind: 'blocked' })); return; }
    if (frame.op === 11) { acknowledged = true; return; }
    if (frame.op === 7) { finish(); return; }
    if (frame.op === 9) { if (frame.d !== true) { session = undefined; resumeUrl = undefined; sequence = null; } finish(); return; }
    if (frame.op === 1) { void send(1, sequence).catch(finish); return; }
    if (frame.op === 10) {
     const hello = z.object({ heartbeat_interval: z.number().int().min(100).max(120000) }).safeParse(frame.d); if (!hello.success) { finish(); return; }
     clearTimeout(heartbeat); heartbeat = setTimeout(() => { void beat(hello.data.heartbeat_interval); }, Math.random() * hello.data.heartbeat_interval);
     if (!session && --startsRemaining < 0) { finish(new ChatTransportError({ kind: 'blocked' })); return; }
     void send(session ? 6 : 2, session ? { token, session_id: session, seq: sequence } : { token, intents: DISCORD_INTENTS, properties: { os: process.platform, browser: 'cezar', device: 'cezar' } }).catch(finish); return;
    }
    if (frame.op !== 0 || frame.s == null) return;
    if (sequence !== null && frame.s <= sequence) return;
    sequence = frame.s;
    input.onReceiveCursor?.(frame.s);
   if (frame.t === 'READY') { const ready = readySchema.safeParse(frame.d); if (!ready.success || !ready.data.user.bot) { finish(); return; } if (ready.data.user.id !== knownBot) { finish(new ChatTransportError({ kind: 'auth' })); return; } knownChannels.clear(); channels.clear(); session = ready.data.session_id; resumeUrl = ready.data.resume_gateway_url; botId = ready.data.user.id; if (!commandsRegistered) { commandsRegistered = true; void request('PUT', `/applications/${botId}/commands`, discordApplicationCommands(), controller.signal, active).catch(() => { commandsRegistered = false; }); } clearTimeout(handshake); update('polling'); return; }
    if (frame.t === 'RESUMED') { clearTimeout(handshake); update('polling'); return; }
    if (!botId) { // Resume retains the identity established by the REST bot check.
     botId = knownBot;
    }
    if (++pending > 100) { pending--; finish(new ChatTransportError({ kind: 'blocked' })); return; }
    let acknowledgement: Ack | undefined;
    if (frame.t === 'INTERACTION_CREATE') {
     const interaction = interactionSchema.safeParse(frame.d);
     if (interaction.success && interaction.data.type === 3 && interaction.data.application_id === knownBot && interaction.data.message?.author.id === knownBot && interaction.data.channel_id === interaction.data.message.channel_id) {
      const event = interaction.data;
      const ack: Ack = { promise: acknowledge(`/interactions/${event.id}/${event.token}/callback`), settled: false };
      void ack.promise.then(() => { ack.settled = true; }, () => { ack.settled = true; }); acknowledgement = ack;
     }
     if (interaction.success && interaction.data.type === 2 && interaction.data.application_id === knownBot && interaction.data.data?.name === 'tasks') {
      const event = interaction.data;
      const user = event.member?.user ?? event.user;
      if (user && !user.bot) {
       const ack: Ack = { promise: acknowledge(`/interactions/${event.id}/${event.token}/callback`, { type: 5, data: { flags: 64 } }), settled: false };
       void ack.promise.then(() => { ack.settled = true; }, () => { ack.settled = true; }); acknowledgement = ack;
      }
     }
    }
    dispatch({ type: frame.t ?? '', data: frame.d, botId, seq: frame.s, ...(acknowledgement ? { ack: acknowledgement } : {}) });
   });
  });
 }
 let knownBot = '';
 async function run() {
  try {
   const discover = async () => {
    for (;;) {
     try {
      await guard(); const me = discordUser.parse(await request('GET', '/users/@me', undefined, controller.signal));
      if (!me.bot) throw new ChatTransportError({ kind: 'auth' }); knownBot = me.id;
      const gateway = z.object({ url: z.string().url(), shards: z.number().int(), session_start_limit: z.object({ remaining: z.number().int(), reset_after: z.number().nonnegative().optional() }) }).parse(await request('GET', '/gateway/bot', undefined, controller.signal));
      if (gateway.shards > 1) throw new ChatTransportError({ kind: 'blocked' });
      startsRemaining = gateway.session_start_limit.remaining; startsResetAt = now() + (gateway.session_start_limit.reset_after ?? 60000);
      return gateway;
     } catch (error) {
      if (!active() || !(error instanceof ChatTransportError) || !['transient', 'rate_limited'].includes(error.failure.kind)) throw error;
      update('backoff'); await delay(error.failure.retryAfterMs ?? 5000);
     }
    }
   };
   let gateway = await discover();
   while (active()) {
    if (!session && startsRemaining < 1) {
     // The identify budget refills after reset_after (a minute when Discord omits it); then refresh it.
     update('backoff'); await delay(Math.max(startsResetAt - now(), 1000)); if (active()) gateway = await discover(); continue;
    }
    try { await cycle(resumeUrl ?? gateway.url); } catch (error) { if (error instanceof ChatTransportError && ['auth', 'blocked'].includes(error.failure.kind)) throw error; } if (active()) { update('backoff'); await delay(5000); } }
  } catch (error) { controller.abort(); if (!stopped) update(error instanceof ChatTransportError && error.failure.kind === 'auth' ? 'credentials-unavailable' : 'blocked'); }
 }
 return { start() { if (running) return; stopped = false; controller = new AbortController(); running = run(); }, health: () => health, async stop() { stopped = true; controller.abort(); socket?.terminate(); await running; await Promise.all(holds); await queue; clearTimeout(dropTimer); reportDrops(false); update('stopped'); } };
}
