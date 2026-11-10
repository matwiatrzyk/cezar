import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { TelegramInbound } from '../server/telegram-service.ts';
import { DiscordInbound } from '../server/discord-service.ts';
import { freshState, readInboundState } from './state.ts';
import { BotLease } from './ownership.ts';
import { ChatBindings, readBinding } from './bindings.ts';
import { acquireOwnership } from '../webhooks/ownership.ts';
import type { PrivateReceiver } from '../webhooks/endpoints.ts';
import type { TelegramCall } from './providers/telegram/client.ts';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.unstubAllEnvs(); });
async function fixture(dryRun = false) {
  const home = await mkdtemp(join(tmpdir(), 'chat-old-layout-'));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  vi.stubEnv('CEZ_HOME', home); vi.stubEnv('CEZ_WEBHOOKS', '1'); vi.stubEnv('CEZ_CHAT_INBOUND', '1');
  const directory = join(home, 'state'); await mkdir(directory);
  const binding = { projectId: 'project', installationId: 'instance', root: home, generation: randomUUID() };
  const state = freshState('123', binding);
  const receiver = { id: 'receiver', format: 'telegram.v1', state: 'active', lastTest: 'success', profile: 'standard',
    events: ['task.attention_required'], chatId: '456', deliveryRevision: 1, chatSecret: { sha256: 'a'.repeat(64) } } as PrivateReceiver;
  const generation = randomUUID();
  state.receivers.push({ receiverId: receiver.id, chatId: '456', enabled: true, generation, acceptAfter: 1000, deliveryRevision: 1, credentialFingerprint: 'a'.repeat(64) });
  state.grants.push({ id: randomUUID(), receiverId: receiver.id, chatId: '456', userId: '456', label: 'Person', permissions: ['respond'], capability: 'task_control', generation: randomUUID(), enableGeneration: generation, approvedAt: 2000 });
  state.phase = 'active'; state.nextOffset = 73; state.extensionCursor = 71; state.lastUpdateAt = Date.now();
  const legacy = join(home, 'chat', 'telegram', ...(dryRun ? ['dry-run'] : []), 'bots', '123');
  await mkdir(legacy, { recursive: true }); await writeFile(join(legacy, 'binding.json'), JSON.stringify(binding));
  await writeFile(join(directory, '123.json'), JSON.stringify(state));
  let polls = 0;
  const call = vi.fn<TelegramCall>(async (method, _body, signal) => {
    if (method === 'getMe') return { id: 123, username: 'test_bot', first_name: 'Test' };
    if (method === 'getUpdates') { polls++; return new Promise(resolve => signal?.addEventListener('abort', () => resolve([]), { once: true })); }
    return {};
  });
  const options = { projectId: 'project', root: home, installationId: 'instance', directory, dryRun, mode: 'local' as const,
    receivers: () => [receiver], call: () => call, context: vi.fn(), deliver: vi.fn(), episode: () => undefined, changed() {} };
  const service = new TelegramInbound(options); cleanups.push(() => service.dispose());
  return { home, directory, legacy, binding, state, service, options, polls: () => polls };
}

it.each([false, true])('starts the old provider layout without re-pairing (dry run %s)', async dryRun => {
  const x = await fixture(dryRun);
  const files = await readdir(x.legacy);
  await x.service.load();
  expect(x.service.list().grants).toEqual(x.state.grants);
  expect(await readdir(x.legacy)).toEqual(files); // Discovery is read-only.
  await x.service.start();
  await vi.waitFor(() => expect(x.polls()).toBe(1));
  await x.service.start(); expect(x.polls()).toBe(1);
  const saved = await readInboundState(x.directory, '123');
  expect(saved).toMatchObject({ binding: x.binding, configGeneration: x.state.configGeneration, epoch: x.state.epoch,
    grants: x.state.grants, receivers: x.state.receivers, nextOffset: 73, extensionCursor: 71 });
});

it('discovers an old binding while leaving a live old-process owner untouched', async () => {
  const x = await fixture(); const owner = await acquireOwnership(x.legacy);
  expect(owner).toBeDefined(); cleanups.push(() => owner!.release());
  const before = await readFile(join(x.legacy, 'owner.lock'), 'utf8');
  await x.service.load(); expect(x.service.list().grants).toEqual(x.state.grants);
  await x.service.start(); expect(x.polls()).toBe(0);
  expect(await readFile(join(x.legacy, 'owner.lock'), 'utf8')).toBe(before);
  expect(owner!.valid()).toBe(true);
});

it('does not expose, reset or disconnect another provider’s inactive binding with missing local state', async () => {
  const x = await fixture();
  // Exercise new writes too, not only old-layout discovery.
  const lease = await BotLease.acquire('123', false, 'telegram'); await lease.bind(x.binding); await lease.release();
  const before = await readBinding('123', false, 'telegram');
  const discord = new DiscordInbound({ ...x.options, directory: join(x.home, 'discord-state'), receivers: () => [], discord: () => ({ token: 'dummy' }) });
  cleanups.push(() => discord.dispose());
  await discord.load(); expect(discord.list().bots).toEqual([]);
  const scanner = new ChatBindings({ provider: 'discord', mode: () => 'local', projects: async () => [] });
  expect((await scanner.scan()).bindings).toEqual([]);
  await expect(discord.reset('123', 'a'.repeat(64))).rejects.toThrow();
  await expect(discord.disconnect('123', 'a'.repeat(64))).rejects.toThrow();
  expect(await readBinding('123', false, 'telegram')).toEqual(before);
  expect(await readInboundState(x.directory, '123')).toEqual(x.state);
});

it('keeps same-number bots on different platforms independent and checks damaged-state revisions', async () => {
  const x = await fixture();
  const discordLease = await BotLease.acquire('123', false, 'discord');
  await discordLease.bind(x.binding); await discordLease.release();
  const telegramLease = await BotLease.acquire('123', false, 'telegram');
  cleanups.push(() => telegramLease.release());
  const discord = new DiscordInbound({ ...x.options, directory: join(x.home, 'discord-state'), receivers: () => [], discord: () => ({ token: 'dummy' }) });
  cleanups.push(() => discord.dispose()); await discord.load();
  const bot = discord.list().bots[0]!; expect(bot).toBeDefined();
  await expect(discord.disconnect('123', 'a'.repeat(64))).rejects.toMatchObject({ code: 'revision_conflict' });
  expect(bot.inboundRevision).toBeDefined();
  await discord.disconnect('123', bot.inboundRevision!);
  expect(await readBinding('123', false, 'discord')).toBeUndefined();
  expect(await telegramLease.binding()).toEqual(x.binding);
  expect(await readInboundState(x.directory, '123')).toEqual(x.state);
});
it('does not release a rightful binding when an empty state names another provider', async () => {
  const x = await fixture();
  await writeFile(join(x.directory, '123.json'), JSON.stringify(freshState('123', x.binding, 'discord')));
  await x.service.load();
  expect(await readBinding('123', false, 'telegram')).toEqual(x.binding);
  expect(x.service.list().bots[0]?.health.state).toBe('blocked');
  await x.service.start(); expect(x.polls()).toBe(0);
});
