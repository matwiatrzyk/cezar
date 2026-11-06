import { Hono } from 'hono';
import { slackSchemas, discordSchemas, chatSetupBegunSchema } from '@open-mercato/cezar-contract';
import { createChatRoutes } from '../server/telegram.ts';
import { WebhookService } from '../webhooks/service.ts';
import { WebhookScheduler } from '../webhooks/scheduler.ts';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type WebSocket from 'ws';
import { afterEach, expect, it, vi } from 'vitest';
import { SlackInbound } from '../server/slack-service.ts';
import { DiscordInbound } from '../server/discord-service.ts';
import { encodeSlackCredentials } from './providers/slack/identity.ts';
import type { PrivateReceiver } from '../webhooks/endpoints.ts';
import type { ChatInbound } from './service.ts';
import type { ChatBotRuntime } from './runtime.ts';
import { readInboundState, type InboundStateStore } from './state.ts';
import { BotLease } from './ownership.ts';
import type { ChatSetups } from './setup.ts';

class Socket extends EventEmitter {
  readyState = 1;
  send() {}
  ping() {}
  terminate() {}
}
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean(); vi.unstubAllEnvs(); });
function internals(service: ChatInbound) {
  return service as unknown as { setup: ChatSetups; bots: Map<string, { runtime: ChatBotRuntime; state: InboundStateStore; lease: BotLease }> };
}
function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function fixture(provider: 'slack' | 'discord', realStore = false) {
  vi.stubEnv('CEZ_WEBHOOKS', '1'); vi.stubEnv('CEZ_CHAT_INBOUND', '1');
  const directory = await mkdtemp(join(tmpdir(), 'chat-lifecycle-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  vi.stubEnv('CEZ_HOME', join(directory, 'home'));
  const botId = provider === 'slack' ? 'T123:U123' : '12345';
  const userId = provider === 'slack' ? 'U456' : '456';
  const token = provider === 'slack' ? encodeSlackCredentials({ appToken: 'xapp-synthetic12345', botToken: 'xoxb-synthetic12345' })
    : `${'a'.repeat(24)}.${'b'.repeat(6)}.${'c'.repeat(27)}`;
  const receivers: PrivateReceiver[] = [], sockets: Socket[] = [];
  let seq = 1;
  let pauseIdentity = false;
  const identityEntered = barrier();
  const identity = async (signal?: AbortSignal) => {
    if (!pauseIdentity) return;
    pauseIdentity = false; identityEntered.resolve();
    await new Promise<void>((_, reject) => {
      const abort = () => reject(new Error('aborted startup'));
      if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    });
  };
  const socket = () => {
    const ws = new Socket(); sockets.push(ws);
    setTimeout(() => {
      if (provider === 'slack') ws.emit('open');
      else ws.emit('message', JSON.stringify({ op: 0, t: 'READY', s: seq++, d: {
        session_id: randomUUID(), resume_gateway_url: 'wss://gateway.discord.gg', user: { id: botId, username: 'Bot', bot: true },
      } }));
    }, 0);
    return ws as unknown as WebSocket;
  };
  const slack = { socket, call: vi.fn(async (method: string, body: Record<string, unknown>, signal?: AbortSignal) => {
    if (method === 'auth.test') { await identity(signal); return { team_id: 'T123', user_id: 'U123' }; }
    if (method === 'apps.connections.open') return { url: 'wss://wss-primary.slack.com' };
    if (method === 'conversations.info') return { channel: { id: body.channel, is_im: body.channel === 'D456', is_member: true, user: userId } };
    if (method === 'conversations.members') return { members: ['U123', userId] };
    if (method === 'chat.postMessage') return { channel: body.channel, ts: '1700000000.000001' };
    throw new Error(method);
  }) };
  const discord = { token, socket, request: vi.fn(async (_method: string, path: string, _body?: unknown, signal?: AbortSignal) => {
    if (path === '/users/@me') { await identity(signal); return { id: botId, username: 'Bot', bot: true }; }
    if (path === '/gateway/bot') return { url: 'wss://gateway.discord.gg', shards: 1, session_start_limit: { remaining: 100 } };
    if (path === '/channels/789') return { id: '789', type: 0, guild_id: '999', permission_overwrites: [] };
    if (path === '/channels/456') return { id: '456', type: 1, recipients: [{ id: userId }] };
    if (path.startsWith('/guilds/999/members/')) return { user: { id: path.split('/').at(-1) }, roles: [] };
    if (path === '/guilds/999') return { id: '999', owner_id: '999' };
    if (path === '/guilds/999/roles') return [{ id: '999', permissions: '1024' }];
    if (path.endsWith('/messages')) return { id: '111', channel_id: path.split('/')[2] };
    throw new Error(path);
  }) };
  const options = { projectId: 'project', root: directory, directory, installationId: randomUUID(), mode: 'local' as const,
    receivers: () => receivers, context: async () => { throw new Error('no project in lifecycle fixture'); }, deliver: async () => { throw new Error('unexpected delivery'); }, episode: () => undefined, changed() {},
    createReceiverFromToken: async (_token: string, _name: string | undefined, chatId: string) => {
      const receiver = { id: randomUUID(), revision: 1, deliveryRevision: 1, format: `${provider}.v1`, chatId,
        state: 'active', lastTest: 'success', profile: 'standard', events: ['task.attention_required'],
        chatSecret: { sha256: createHash('sha256').update(token).digest('hex') } } as PrivateReceiver;
      receivers.push(receiver); return receiver;
    },
  };
  const construct = () => provider === 'slack'
    ? new SlackInbound({ ...options, wire: () => slack, wireCredential: () => slack })
    : new DiscordInbound({ ...options, discord: () => discord, discordCredential: () => discord });
  let service = construct();
  let webhooks: WebhookService | undefined;
  if (realStore) {
    execFileSync('git', ['init', '-q'], { cwd: directory, timeout: 5000 });
    webhooks = (await WebhookService.open({ root: directory, dataDir: join(directory, '.ai/cezar'), projectId: 'project',
      mode: 'local', serverPorts: () => [], scheduler: new WebhookScheduler(),
      slackWire: () => slack, discordOptions: () => discord }))!;
    service = webhooks[provider];
    cleanups.push(() => webhooks!.dispose());
  }
  const app = new Hono().route('/api/v1', createChatRoutes(provider, async () => service, () => undefined,
    provider === 'slack' ? slackSchemas : discordSchemas));
  const api = (path: string, body: unknown) => app.request(`/api/v1/${provider}/${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  cleanups.push(async () => {
    await Promise.all([...internals(service).bots.values()].map(bot => bot.runtime?.stop()));
    await service.dispose();
  });
  const ready = () => vi.waitFor(() => expect(service.list().bots[0]?.health.state).toBe('polling'));
  const begin = () => service.beginSetup({ token, dedicatedBot: true });
  const sendStart = (deepLink: string, group: boolean) => {
    const code = provider === 'slack' ? new URL(deepLink).searchParams.get('cezar_start') : new URL(deepLink).hash.split('=')[1];
    const ws = sockets.at(-1)!;
    if (provider === 'slack') ws.emit('message', JSON.stringify({ envelope_id: randomUUID(), type: 'events_api',
      payload: { team_id: 'T123', event_id: randomUUID(), authorizations: [{ user_id: 'U123', is_bot: true }],
        event: { type: 'message', channel: group ? 'C789' : 'D456', user: userId,
          ts: (Date.now() / 1000).toFixed(6), text: `${group ? '<@U123> ' : ''}cezar start ${code}` } } }));
    else ws.emit('message', JSON.stringify({ op: 0, t: 'MESSAGE_CREATE', s: seq++, d: {
      id: String(seq + 100), channel_id: group ? '789' : '456', ...(group ? { guild_id: '999' } : {}),
      author: { id: userId, username: 'Person' }, content: `${group ? '<@12345> ' : ''}/start ${code}`, timestamp: new Date().toISOString(),
    } }));
  };
  const discover = async () => {
    const begun = await begin(); await ready(); sendStart(begun.deepLink, true);
    await vi.waitFor(() => expect(service.setupStatus(begun.setupId).status).toBe('candidate'));
    await service.activateSetup(begun.setupId, { activate: true, taskControl: false, groupVisibilityAccepted: true,
      expectedRevision: service.setupStatus(begun.setupId).inboundRevision, candidateUserId: userId });
  };
  const approve = async () => {
    const begun = await service.beginSetup({ receiverId: receivers[0]!.id, dedicatedBot: true, groupVisibilityAccepted: true,
      expectedRevision: service.list().receivers[0]!.inboundRevision });
    await ready(); sendStart(begun.deepLink, false);
    await vi.waitFor(() => expect(service.setupStatus(begun.setupId).candidate?.comparisonCode).toBeTruthy());
    await service.activateSetup(begun.setupId, { activate: true, permissions: ['respond'], comparisonVerified: true, groupVisibilityAccepted: true,
      expectedRevision: service.setupStatus(begun.setupId).inboundRevision, candidateUserId: userId });
  };
  const privateGrant = async () => {
    const begun = await begin(); await ready(); sendStart(begun.deepLink, false);
    await vi.waitFor(() => expect(service.setupStatus(begun.setupId).status).toBe('candidate'));
    await service.activateSetup(begun.setupId, { activate: true, permissions: ['respond'],
      expectedRevision: service.setupStatus(begun.setupId).inboundRevision, candidateUserId: userId });
    await service.dispose(); service = construct(); await service.load(); await service.start(); await ready();
  };
  return { api, webhooks, token, observe: () => webhooks!.on(`${provider}-change`, () => service.list()), privateGrant, get service() { return service; }, bot: () => internals(service).bots.get(botId)!, begin, ready, discover, approve, sendStart,
    sockets, userId, pauseIdentity: () => { pauseIdentity = true; return identityEntered.promise; },
    restart: async (start = true) => { await service.dispose(); service = construct(); await service.load(); if (start) await service.start(); },
  };
}

it.each(['slack', 'discord'] as const)('%s receives private group approval after same-token notification activation', async provider => {
  const x = await fixture(provider);
  await x.discover(); await x.approve();
  expect(x.service.list().grants).toHaveLength(1);
  expect(x.bot().state.snapshot().fatalStop).toBeUndefined();
  await x.restart(); await x.ready();
});

it.each(['slack', 'discord'] as const)('%s replaces a starting durable anchor with a same-token temporary anchor', async provider => {
  const x = await fixture(provider);
  await x.privateGrant(); await x.restart(false);
  const entered = x.pauseIdentity();
  const starting = x.service.start(); await entered;
  const begun = await x.begin(); await starting; await x.ready();
  x.sendStart(begun.deepLink, false);
  await vi.waitFor(() => expect(x.service.setupStatus(begun.setupId).status).toBe('candidate'));
}, 10000);

it('does not persist a deliberate shutdown as fatal while setup settlement is pending', async () => {
  const x = await fixture('discord'); await x.privateGrant();
  const entered = barrier(), release = barrier();
  const setup = internals(x.service).setup, settled = setup.settled.bind(setup);
  vi.spyOn(setup, 'settled').mockImplementation(async () => { await settled(); entered.resolve(); await release.promise; });
  x.bot().lease.assertOwner();
  x.sockets.at(-1)!.emit('message', JSON.stringify({ op: 1 }));
  const disposing = x.service.dispose();
  try {
    await entered.promise;
    // Artificial settlement window, as in d869584d's reproduction.
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(x.bot().state.snapshot().fatalStop).toBeUndefined();
  } finally { release.resolve(); await disposing; }
  await x.restart(); await x.ready();
});

it('retains a real authentication failure across disposal and restart', async () => {
  const x = await fixture('discord'); await x.privateGrant();
  x.sockets.at(-1)!.emit('close', 4004);
  await vi.waitFor(() => expect(x.bot().state.snapshot().fatalStop).toBe('credentials-unavailable'));
  await x.restart();
  expect(x.service.list().bots[0]?.health.state).toBe('credentials-unavailable');
});

it('retains an operational ownership guard failure', async () => {
  const x = await fixture('discord'); await x.privateGrant();
  // Preserve the store's ownership checks: only the transport's synchronous fence is lost.
  vi.spyOn(x.bot().lease, 'assertOwner').mockImplementationOnce(() => { throw new Error('lost ownership'); });
  x.sockets.at(-1)!.emit('message', JSON.stringify({ op: 1 }));
  await vi.waitFor(() => expect(x.bot().state.snapshot().fatalStop).toBe('blocked'));
  vi.restoreAllMocks();
  await x.restart();
  expect(x.service.list().bots[0]?.health.state).toBe('blocked');
});

it('does not construct a replacement or retain its lease when disposal overtakes anchor switching', async () => {
  const x = await fixture('discord'); await x.privateGrant();
  const runtime = x.bot().runtime, stop = runtime.stop.bind(runtime), entered = barrier(), release = barrier();
  vi.spyOn(runtime, 'stop').mockImplementation(async () => {
    const stopped = await stop(); entered.resolve(); await release.promise; return stopped;
  });
  const before = x.sockets.length;
  const replacing = x.begin().then(() => 'started', () => 'closed');
  await entered.promise;
  const disposing = x.service.dispose();
  release.resolve();
  expect(await replacing).toBe('closed');
  await disposing;
  expect(x.sockets).toHaveLength(before);
  expect(x.bot().runtime).toBe(runtime);
  expect(x.bot().state.snapshot().fatalStop).toBeUndefined();
  // A new service can acquire the same lease and resume the existing grant.
  await x.restart(); await x.ready();
});

// Real endpoint persistence/test/activation and real adapters, with only platform I/O replaced.
it.each([
  ['slack', false], ['slack', true], ['discord', false], ['discord', true],
] as const)('%s activates through the API with a status subscriber (group=%s)', async (provider, group) => {
  const x = await fixture(provider, true);
  const response = await x.api('setup', { token: x.token, dedicatedBot: true });
  expect(response.status).toBe(201);
  const begun = chatSetupBegunSchema.parse(await response.json());
  await x.ready(); x.sendStart(begun.deepLink, group);
  await vi.waitFor(() => expect(x.service.setupStatus(begun.setupId).status).toBe('candidate'));
  x.observe();
  const activated = await x.api(`setup/${begun.setupId}/activate`, { activate: true, taskControl: !group,
    ...(group ? { groupVisibilityAccepted: true } : { permissions: ['respond'] }),
    expectedRevision: x.service.setupStatus(begun.setupId).inboundRevision, candidateUserId: x.userId });
  expect(await activated.clone().json()).not.toHaveProperty('error');
  expect(activated.status).toBe(200);
  expect(x.service.list().receivers).toHaveLength(1);
  expect(x.service.list().grants).toHaveLength(group ? 0 : 1);
  expect(x.bot().state.snapshot().fatalStop).toBeUndefined();
  if (group) {
    const receiver = x.service.list().receivers[0]!;
    const approvalResponse = await x.api('setup', { receiverId: receiver.receiverId, dedicatedBot: true,
      groupVisibilityAccepted: true, expectedRevision: receiver.inboundRevision });
    expect(approvalResponse.status).toBe(201);
    const approval = chatSetupBegunSchema.parse(await approvalResponse.json());
    await x.ready(); x.sendStart(approval.deepLink, false);
    await vi.waitFor(() => expect(x.service.setupStatus(approval.setupId).candidate?.comparisonCode).toBeTruthy());
    const approved = await x.api(`setup/${approval.setupId}/activate`, { activate: true, permissions: ['respond'],
      comparisonVerified: true, groupVisibilityAccepted: true,
      expectedRevision: x.service.setupStatus(approval.setupId).inboundRevision, candidateUserId: x.userId });
    expect(approved.status).toBe(200);
    expect(x.service.list().grants).toHaveLength(1);
    expect(x.bot().state.snapshot().fatalStop).toBeUndefined();
  }
});

it.each([
  ['slack', 'edit', false], ['slack', 'revoke', true], ['discord', 'edit', false], ['discord', 'revoke', true],
  ['slack', 'edit', true], ['discord', 'edit', true], ['slack', 'none', true], ['discord', 'none', true],
] as const)('%s fences %s during anchor handoff (existing grant: %s)', async (provider, mutation, existingGrant) => {
  const x = await fixture(provider, true);
  const candidate = async () => {
    const response = await x.api('setup', { token: x.token, dedicatedBot: true });
    expect(response.status).toBe(201);
    const begun = chatSetupBegunSchema.parse(await response.json());
    await x.ready(); x.sendStart(begun.deepLink, false);
    await vi.waitFor(() => expect(x.service.setupStatus(begun.setupId).status).toBe('candidate'));
    return begun;
  };
  const activate = (id: string) => x.api(`setup/${id}/activate`, { activate: true, taskControl: existingGrant, permissions: ['respond'],
    expectedRevision: x.service.setupStatus(id).inboundRevision, candidateUserId: x.userId });
  if (existingGrant) {
    const first = await candidate();
    expect((await activate(first.setupId)).status).toBe(200);
  }
  const begun = await candidate(); x.observe();
  const runtime = x.bot().runtime, stop = runtime.stop.bind(runtime), entered = barrier(), release = barrier();
  vi.spyOn(runtime, 'stop').mockImplementation(async () => {
    const stopped = await stop(); entered.resolve(); await release.promise; return stopped;
  });
  const pending = activate(begun.setupId);
  await entered.promise;
  try {
    if (mutation === 'revoke') {
      const current = x.service.list();
      await x.service.revoke(current.grants[0]!.id, current.bots[0]!.inboundRevision!);
    } else if (mutation === 'edit') {
      const receiver = x.webhooks!.list().receivers[0]!;
      await x.webhooks!.update(receiver.id, { expectedRevision: receiver.revision, format: `${provider}.v1`, name: 'Concurrent rename' });
    }
  } finally { release.resolve(); }
  const response = await pending;
  expect(response.status).toBe(mutation === 'none' ? 200 : 409);
  if (mutation !== 'none') expect(await response.json()).toEqual({ error: 'revision_conflict', code: 'revision_conflict' });
  expect(x.service.list().grants).toHaveLength(existingGrant && mutation !== 'revoke' ? 1 : 0);
  if (mutation === 'none') expect(x.service.list().grants[0]!.permissions).toEqual(['respond']);
});


it.each(['cleanup', 'disconnect'] as const)('retains unused bot ownership after a real stop timeout, then retries via %s', async retry => {
  const x = await fixture('discord'), begun = await x.begin(); await x.ready();
  const bot = x.bot(), binding = bot.state.snapshot().binding;
  const connection = (bot.runtime as unknown as { connection: { stop(): Promise<void> } }).connection;
  const stop = connection.stop.bind(connection), entered = barrier(), release = barrier();
  const held = vi.spyOn(connection, 'stop').mockImplementation(async () => {
    entered.resolve(); await release.promise; await stop();
  });
  const drain = vi.spyOn(bot.state, 'drain');
  const disconnect = vi.spyOn(bot.lease, 'disconnect'), relinquish = vi.spyOn(bot.lease, 'release');
  try {
    const cancelling = x.service.cancelSetup(begun.setupId);
    await entered.promise;
    await expect(cancelling).resolves.toEqual({ cancelled: true });
    expect(x.bot()).toBe(bot);
    expect(drain).not.toHaveBeenCalled();
    expect(disconnect).not.toHaveBeenCalled(); expect(relinquish).not.toHaveBeenCalled();
    bot.lease.assertOwner();
    expect(await bot.lease.binding()).toEqual(binding);
    expect(await readInboundState(binding.root, '12345')).toEqual(bot.state.snapshot());
    await expect(BotLease.acquire('12345', false, 'discord')).rejects.toMatchObject({ code: 'owner_conflict' });
    const listed = x.service.list().bots[0]!;
    expect(listed.botId).toBe('12345');
    release.resolve();
    if (retry === 'disconnect') await x.service.disconnect(listed.botId, listed.inboundRevision!);
    else await (x.service as unknown as { releaseUnusedBot(id: string): Promise<void> }).releaseUnusedBot('12345');
    expect(x.bot()).toBeUndefined();
    expect(await readInboundState(binding.root, '12345')).toBeUndefined();
    const nextOwner = await BotLease.acquire('12345', false, 'discord');
    try { expect(await nextOwner.binding()).toBeUndefined(); } finally { await nextOwner.release(); }
  } finally {
    release.resolve(); await bot.runtime.stop(); held.mockRestore();
    drain.mockRestore(); disconnect.mockRestore(); relinquish.mockRestore();
  }
}, 15000);

it('isolates a rejected cleanup stop and permits Disconnect to release the empty bot', async () => {
  const x = await fixture('discord'), begun = await x.begin(); await x.ready();
  const bot = x.bot(), stop = vi.spyOn(bot.runtime, 'stop').mockRejectedValueOnce(new Error('stop failed'));
  try {
    await expect(x.service.cancelSetup(begun.setupId)).resolves.toEqual({ cancelled: true });
    expect(x.bot()).toBe(bot); bot.lease.assertOwner();
    const listed = x.service.list().bots[0]!;
    await x.service.disconnect(listed.botId, listed.inboundRevision!);
    expect(x.service.list().bots).toEqual([]);
    const next = await BotLease.acquire('12345', false, 'discord');
    try { expect(await next.binding()).toBeUndefined(); } finally { await next.release(); }
  } finally { stop.mockRestore(); }
});

it('isolates an unbind failure after a safe stop and releases the lease', async () => {
  const x = await fixture('discord'), begun = await x.begin(); await x.ready();
  const bot = x.bot(), disconnect = vi.spyOn(bot.lease, 'disconnect').mockRejectedValueOnce(new Error('disk failed'));
  try {
    await expect(x.service.cancelSetup(begun.setupId)).resolves.toEqual({ cancelled: true });
    expect(x.bot()).toBeUndefined();
    const next = await BotLease.acquire('12345', false, 'discord');
    try { expect(await next.binding()).toEqual(bot.state.snapshot().binding); } finally { await next.release(); }
  } finally { disconnect.mockRestore(); }
});
