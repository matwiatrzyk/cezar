import { webhookStoredSettingsSchema } from '@open-mercato/cezar-contract';
import { readInboundState } from '../chat/state.ts';
import type { TopicPublisher } from './ws.ts';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type WebSocket from 'ws';
import { hc, type InferRequestType, type InferResponseType } from 'hono/client';
import { z } from 'zod';
import { expect, it, vi } from 'vitest';
import { slackSchemas, discordSchemas } from '@open-mercato/cezar-contract';
import { WebhookCoordinator } from '../webhooks/coordinator.ts';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { registerProject } from '../workspace/projects.ts';
import { createApp } from './server.ts';
import type { AppType } from './app-type.ts';
import { apiRequest } from './loopback-request.testkit.ts';
const client = hc<AppType>('http://127.0.0.1');
const slack = client.api.v1.p[':projectId'].slack, discord = client.api.v1.p[':projectId'].discord;
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
type Checks = [
 Assert<Equal<z.input<typeof slackSchemas.telegramSetupBeginSchema>, InferRequestType<typeof slack.setup.$post>['json']>>,
 Assert<Equal<z.input<typeof discordSchemas.telegramSetupBeginSchema>, InferRequestType<typeof discord.setup.$post>['json']>>,
 Assert<Equal<z.infer<typeof slackSchemas.telegramInboundStateResponseSchema>, InferResponseType<typeof slack.$get, 200>>>,
 Assert<Equal<z.infer<typeof discordSchemas.telegramSetupActivatedSchema>, InferResponseType<typeof discord.setup[':id']['activate']['$post'], 200>>>,
 Assert<Equal<z.infer<typeof slackSchemas.telegramOrphanBindingsSchema>, InferResponseType<typeof client.api.v1.slack['bot-bindings']['$get'], 200>>>,
 Assert<Equal<z.infer<typeof discordSchemas.telegramOrphanReleasedSchema>, InferResponseType<typeof client.api.v1.discord['bot-bindings'][':botId']['$delete'], 200>>>,
];
const checked: Checks | undefined = undefined; void checked;
class Socket extends EventEmitter {
 readyState = 1;
 constructor(private readonly provider: 'slack' | 'discord') { super(); setTimeout(() => { this.emit('open'); if (provider === 'discord') this.frame({ op: 10, d: { heartbeat_interval: 10000 } }); }, 1); }
 frame(data: unknown) { this.emit('message', Buffer.from(JSON.stringify(data))); }
 send(raw: string) { const frame = JSON.parse(raw); if (this.provider === 'discord' && frame.op === 2) this.frame({ op: 0, s: 1, t: 'READY', d: { session_id: 'fixture', resume_gateway_url: 'wss://gateway.discord.gg', user: { id: '456', username: 'fixture', bot: true } } }); if (frame.op === 1) this.frame({ op: 11 }); }
 ping() { this.emit('pong'); }
 terminate() { this.readyState = 3; this.emit('close', 1000); }
}
it.each(['slack', 'discord'].flatMap(provider => ['normal', 'retry', 'edited'].map(mode => [provider, mode] as const)))('registers %s real transport and same-receiver activation (%s)', async (providerName, mode) => {
 const provider = providerName as 'slack' | 'discord';
 let failDelivery = false;
 const root = await mkdtemp(join(tmpdir(), 'chat-provider-parity-')); execFileSync('git', ['init', '-q'], { cwd: root });
 vi.stubEnv('CEZ_HOME', join(root, 'home')); vi.stubEnv('CEZ_WEBHOOKS', '1'); vi.stubEnv('CEZ_CHAT_INBOUND', '1');
 vi.stubEnv('CEZ_DRY_RUN', '0'); vi.stubEnv('CEZ_SINGLE_PROJECT', '0'); vi.stubEnv('CEZ_REMOTE', '0'); vi.stubEnv('CEZ_AUTOMATIONS', '0'); vi.stubEnv('CEZ_NO_BANNER', '1');
 const project = await registerProject(root), store = RunStore.open(join(root, '.ai/cezar'));
 const sockets: Socket[] = [], sent: unknown[] = [];
 const socket = () => { const value = new Socket(provider); sockets.push(value); return value as unknown as WebSocket; };
 let message = 100;
 const coordinatorOptions: ConstructorParameters<typeof WebhookCoordinator>[0] = { dryRun: false, mode: () => 'local', ports: () => [], projects: async () => [{ ...project, status: 'ready' }],
  slackWire: resolve => ({ socket, async call(method, body, _signal, valid) { await resolve(); if (valid?.() === false) throw new Error('stale');
   if (method === 'auth.test') return { ok: true, team_id: 'TTEAM', user_id: 'UBOT' };
   if (method === 'apps.connections.open') return { ok: true, url: 'wss://fixture.slack.com' };
   if (method === 'conversations.info') return { ok: true, channel: { id: 'DCHAN', is_im: true, is_member: true, user: 'UACTOR' } };
   if (method === 'conversations.members') return { ok: true, members: ['UBOT', 'UACTOR'] };
   if (failDelivery) throw new Error('injected delivery failure');
   sent.push(body); return { ok: true, channel: 'DCHAN', ts: `1700000000.${String(++message).padStart(6, '0')}` };
  } }),
  discordOptions: resolve => ({ token: resolve, socket, request: async (method, path, body) => {
   if (path === '/users/@me') return { id: '456', username: 'fixture', bot: true };
   if (path === '/gateway/bot') return { url: 'wss://gateway.discord.gg', shards: 1, session_start_limit: { remaining: 100, reset_after: 100000, max_concurrency: 1, total: 100 } };
   if (path === '/channels/123' && method === 'GET') return { id: '123', type: 1, recipients: [{ id: '789' }] };
   if (path === '/channels/123/messages') { if (failDelivery) throw new Error('injected delivery failure'); sent.push(body); return { id: String(++message), channel_id: '123' }; }
   return {};
  } }),
 };
 const coordinator = new WebhookCoordinator(coordinatorOptions);
 const cleanups: (() => void)[] = [];
 const topics = new Map<string, TopicPublisher>();
 const subscribe = vi.spyOn(coordinator, 'onChatChange');
 const app = createApp({ repoRoot: root, bootProjectId: project.id, store, manager: { isActive: () => false } as unknown as RunManager, version: 'test', webhooks: coordinator, socketHub: { registerTopic(name, publisher) { topics.set(name, publisher); return () => { topics.delete(name); }; }, attach() {}, close() {} }, onDispose: fn => cleanups.push(fn) });
 const schemas = provider === 'slack' ? slackSchemas : discordSchemas;
 const prefix = `/api/v1/p/${project.id}/${provider}`;
 const request = async (suffix: string, method = 'GET', body?: unknown, status = 200) => {
  const response = await apiRequest(app, prefix + suffix, { method, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  const result = await response.json(); expect(response.status, JSON.stringify(result)).toBe(status); return result;
 };
 try {
  const service = await coordinator.get(project.id, root, true);
  const url = provider === 'slack' ? 'https://hooks.slack.com/services/TA/BB/old' : `https://discord.com/api/webhooks/123456789012345678/${'x'.repeat(60)}`;
  const original = (await service.create({ name: 'Existing', format: `${provider}.v1`, url, graceSeconds: 0, preset: 'all' })).receiver;
  expect(subscribe).not.toHaveBeenCalled();
  const topic = topics.get(`${provider}-inbound`)!; expect(await topic.snapshot()).toEqual({ changed: true });
  const publish = vi.fn(), stop = topic.start(publish);
  expect(subscribe).toHaveBeenCalledWith(provider, expect.any(Function));
  service.emit(`${provider}-change`); expect(publish).toHaveBeenCalledWith({ changed: true });
  stop(); const published = publish.mock.calls.length; service.emit(`${provider}-change`); expect(publish).toHaveBeenCalledTimes(published);
  const state = schemas.telegramInboundStateResponseSchema.parse(await request(''));
  const credential = provider === 'slack' ? JSON.stringify({ appToken: `xapp-${'a'.repeat(30)}`, botToken: `xoxb-${'b'.repeat(30)}` }) : `${'a'.repeat(30)}.${'b'.repeat(8)}.${'c'.repeat(30)}`;
  vi.stubEnv('CEZ_CHAT_INBOUND', '0');
  expect(await request('')).toMatchObject({ available: false, reason: 'flag_off', notifications: { available: true } });
  vi.stubEnv('CEZ_WEBHOOKS', '0');
  expect(await request('')).toMatchObject({ notifications: { available: false }, receivers: [], bots: [], grants: [] });
  await request('/setup', 'POST', { token: credential, dedicatedBot: true }, 503);
  vi.stubEnv('CEZ_WEBHOOKS', '1'); vi.stubEnv('CEZ_CHAT_INBOUND', '1');
  const begun = schemas.telegramSetupBegunSchema.parse(await request('/setup', 'POST', { token: credential, receiverId: original.id, expectedRevision: state.receivers[0]!.inboundRevision, dedicatedBot: true }, 201));
  await vi.waitFor(() => expect(sockets.length).toBeGreaterThan(0));
  const link = new URL(begun.deepLink), code = provider === 'slack' ? link.searchParams.get('cezar_start')! : new URLSearchParams(link.hash.slice(1)).get('cezar-start')!;
  const current = sockets.at(-1)!;
  if (provider === 'slack') current.frame({ type: 'events_api', envelope_id: 'discovery', payload: { team_id: 'TTEAM', event_id: 'discovery-event', authorizations: [{ user_id: 'UBOT', is_bot: true }], event: { type: 'message', channel: 'DCHAN', user: 'UACTOR', text: `cezar start ${code}`, ts: `${Math.ceil(Date.now() / 1000)}.000001` } } });
  else current.frame({ op: 0, s: 2, t: 'MESSAGE_CREATE', d: { id: '1000', channel_id: '123', author: { id: '789', username: 'actor', bot: false }, content: `/start ${code}`, timestamp: new Date().toISOString() } });
  await vi.waitFor(async () => expect(schemas.telegramSetupStatusSchema.parse(await request(`/setup/${begun.setupId}`)).status).toBe('candidate'));
  const candidate = schemas.telegramSetupStatusSchema.parse(await request(`/setup/${begun.setupId}`));
  if (mode !== 'normal') {
   failDelivery = true;
   const activation = { activate: true, expectedRevision: candidate.inboundRevision, candidateUserId: provider === 'slack' ? 'UACTOR' : '789', permissions: ['respond'] };
   await request(`/setup/${begun.setupId}/activate`, 'POST', activation, 503);
   expect(service.list().receivers).toHaveLength(1);
   expect(service.list().receivers[0]?.state).toBe('inactive');
   expect(schemas.telegramInboundStateResponseSchema.parse(await request('')).grants).toEqual([]);
   failDelivery = false;
   if (mode === 'edited') {
    const receiver = service.endpoints.privateReceiver(original.id)!;
    await service.update(receiver.id, { ...webhookStoredSettingsSchema.strip().parse(receiver), name: 'User renamed', expectedRevision: receiver.revision });
    const before = service.endpoints.privateReceiver(original.id);
    await request(`/setup/${begun.setupId}/activate`, 'POST', activation, 409);
    expect(service.endpoints.privateReceiver(original.id)).toEqual(before);
    return;
   }
  }
  const activated = schemas.telegramSetupActivatedSchema.parse(await request(`/setup/${begun.setupId}/activate`, 'POST', { activate: true, expectedRevision: candidate.inboundRevision, candidateUserId: provider === 'slack' ? 'UACTOR' : '789', permissions: ['respond'] }));
  expect(activated.grant?.receiverId).toBe(original.id); expect(service.list().receivers).toHaveLength(1);
  expect(service.list().receivers[0]).toMatchObject({ id: original.id, state: 'active', lastTest: 'success' }); expect(sent.length).toBeGreaterThan(0);
  if (mode === 'retry') return;
  const privateReceiver = service.endpoints.privateReceiver(original.id)!;
  expect(privateReceiver.chatBotId).toBe(provider === 'slack' ? 'TTEAM:UBOT' : '456');
  service.attach(store, { isActive: () => false }, true);
  const run = store.createRun({ title: 'Outbound provider receipt', task: 'fixture', workflow: 'w', steps: [] }); store.updateRun(run.id, { status: 'done', completionReason: 'completed' });
  await vi.waitFor(async () => { await service.tick(); expect(service.deliveries(original.id).some(row => row.eventType === 'task.finished' && row.status === 'delivered')).toBe(true); }, { timeout: 5000 });
  const inboundState = await readInboundState(join(root, '.ai/cezar/webhooks/chat', provider), privateReceiver.chatBotId!);
  expect(inboundState?.correlations.find(row => row.runId === run.id)).toMatchObject({ receiverId: original.id, chatId: privateReceiver.chatId, privateChat: true });
  const disk = await readFile(join(root, '.ai/cezar/webhooks/endpoints.json'), 'utf8'); expect(disk).not.toContain(credential);
  expect(JSON.stringify(service.list())).not.toContain('chatSecret');
  const alias = await apiRequest(app, `/api/v1/${provider}`); expect(await alias.json()).toEqual(await request(''));
  const bindings = await apiRequest(app, `/api/v1/${provider}/bot-bindings`); expect(bindings.status).toBe(200); schemas.telegramOrphanBindingsSchema.parse(await bindings.json());
  await request('/setup', 'POST', { token: 'invalid', dedicatedBot: true }, 400);
  await request('/bots/invalid/reset', 'POST', { expectedRevision: 'a'.repeat(64), confirmReset: true }, 400);
  for (const cleanup of cleanups.splice(0)) cleanup(); await coordinator.dispose();
  const restarted = new WebhookCoordinator(coordinatorOptions);
  try {
    const restored = await restarted.get(project.id, root, true); await restored.startTelegram();
    expect(restored.endpoints.privateReceiver(original.id)).toMatchObject({ chatBotId: privateReceiver.chatBotId, chatId: privateReceiver.chatId });
    expect(restored.chats.get(provider)!.list().grants[0]?.receiverId).toBe(original.id);
    await vi.waitFor(() => expect(restored.chats.get(provider)!.list().bots[0]?.username).toBe(privateReceiver.chatBotId), { timeout: 5000 });
  } finally { await restarted.dispose(); }
 } finally { for (const cleanup of cleanups) cleanup(); await coordinator.dispose(); store.flush(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
}, 20000);
