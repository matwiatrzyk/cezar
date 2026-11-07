import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { DiscordInbound } from '../server/discord-service.ts';
import type { PrivateReceiver } from '../webhooks/endpoints.ts';
import { ChatTransportError, type ChatTransport } from './provider.ts';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean(); vi.unstubAllEnvs(); });

// #F2: a bundled worker whose runtime never reaches connect (fatal identify) must still be stopped.
it('stops the bundled worker owner with its runtime even when the runtime never connected', async () => {
  vi.stubEnv('CEZ_WEBHOOKS', '1'); vi.stubEnv('CEZ_CHAT_INBOUND', '1');
  const directory = await mkdtemp(join(tmpdir(), 'chat-bundled-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  vi.stubEnv('CEZ_HOME', join(directory, 'home'));
  const token = `${'a'.repeat(24)}.${'b'.repeat(6)}.${'c'.repeat(27)}`;
  const receivers: PrivateReceiver[] = [];
  const discord = { token, request: vi.fn(async (_method: string, path: string) => {
    if (path === '/users/@me') return { id: '12345', username: 'Bot', bot: true };
    if (path === '/channels/456') return { id: '456', type: 1, recipients: [{ id: '456' }] };
    throw new Error(path);
  }) };
  const stopped = new Set<number>();
  let owners = 0;
  const bundledTransport = vi.fn(async (_bot: string, _receiver: string, _valid: () => boolean, compatibility: ChatTransport) => {
    const owner = owners++;
    return { transport: { ...compatibility, identify: async () => { throw new ChatTransportError({ kind: 'auth' }); } } as ChatTransport,
      stop: async () => { stopped.add(owner); } };
  });
  const service = new DiscordInbound({ projectId: 'project', root: directory, directory, installationId: randomUUID(), mode: 'local',
    receivers: () => receivers, context: async () => { throw new Error('none'); }, deliver: async () => { throw new Error('none'); }, episode: () => undefined, changed() {},
    discord: () => discord, discordCredential: () => discord, bundledTransport,
    createReceiverFromToken: async (_token: string, _name: string | undefined, chatId: string) => {
      const receiver = { id: randomUUID(), revision: 1, deliveryRevision: 1, format: 'discord.v1', chatId, state: 'active', lastTest: 'success', profile: 'standard',
        events: ['task.attention_required'], chatSecret: { sha256: createHash('sha256').update(token).digest('hex') } } as PrivateReceiver;
      receivers.push(receiver); return receiver;
    } });
  await service.beginSetup({ token, dedicatedBot: true });
  await vi.waitFor(() => expect(bundledTransport).toHaveBeenCalled());
  await vi.waitFor(() => expect(service.list().bots[0]?.health.state).toBe('credentials-unavailable'));
  await service.dispose();
  // Every worker the service activated is stopped; none outlives its (never-connected) runtime.
  expect(owners).toBeGreaterThan(0);
  expect(stopped.size).toBe(owners);
});

async function serviceWith(bundledTransport: (bot: string, receiver: string, valid: () => boolean, compatibility: ChatTransport) => Promise<{ transport: ChatTransport; stop(): Promise<void> }>) {
  vi.stubEnv('CEZ_WEBHOOKS', '1'); vi.stubEnv('CEZ_CHAT_INBOUND', '1');
  const directory = await mkdtemp(join(tmpdir(), 'chat-bundled-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  vi.stubEnv('CEZ_HOME', join(directory, 'home'));
  const token = `${'a'.repeat(24)}.${'b'.repeat(6)}.${'c'.repeat(27)}`;
  const receivers: PrivateReceiver[] = [];
  const discord = { token, request: vi.fn(async (_method: string, path: string) => {
    if (path === '/users/@me') return { id: '12345', username: 'Bot', bot: true };
    if (path === '/channels/456') return { id: '456', type: 1, recipients: [{ id: '456' }] };
    throw new Error(path);
  }) };
  const service = new DiscordInbound({ projectId: 'project', root: directory, directory, installationId: randomUUID(), mode: 'local',
    receivers: () => receivers, context: async () => { throw new Error('none'); }, deliver: async () => { throw new Error('none'); }, episode: () => undefined, changed() {},
    discord: () => discord, discordCredential: () => discord, bundledTransport: vi.fn(bundledTransport),
    createReceiverFromToken: async (_token: string, _name: string | undefined, chatId: string) => {
      const receiver = { id: randomUUID(), revision: 1, deliveryRevision: 1, format: 'discord.v1', chatId, state: 'active', lastTest: 'success', profile: 'standard',
        events: ['task.attention_required'], chatSecret: { sha256: createHash('sha256').update(token).digest('hex') } } as PrivateReceiver;
      receivers.push(receiver); return receiver;
    } });
  // Not awaited: setup itself waits for the bot (and its worker) to start.
  const setup = service.beginSetup({ token, dedicatedBot: true }).catch(error => error);
  return Object.assign(service, { begun: setup });
}

// N1: the worker owner gets the same wire fence as the in-process adapter, gate included.
it('fences worker wire calls with the notifications gate, not only the anchor', async () => {
  let valid: (() => boolean) | undefined;
  const service = await serviceWith(async (_bot, _receiver, check, compatibility) => { valid = check; return { transport: compatibility, stop: async () => {} }; });
  await vi.waitFor(() => expect(valid).toBeDefined());
  expect(valid!()).toBe(true);
  vi.stubEnv('CEZ_WEBHOOKS', '0');
  expect(valid!()).toBe(false);
  vi.stubEnv('CEZ_WEBHOOKS', '1');
  await service.begun; await service.dispose();
  expect(valid!()).toBe(false);
});

// N2: dispose() while the worker is still activating must stop that worker at once.
it('stops a worker that finishes activating after dispose', async () => {
  let release!: () => void; const gate = new Promise<void>(done => { release = done; });
  let entered = false, stopped = 0;
  const service = await serviceWith(async (_bot, _receiver, _valid, compatibility) => { entered = true; await gate; return { transport: compatibility, stop: async () => { stopped++; } }; });
  await vi.waitFor(() => expect(entered).toBe(true));
  const disposing = service.dispose();
  release();
  await disposing; await service.begun;
  expect(stopped).toBe(1);
});
