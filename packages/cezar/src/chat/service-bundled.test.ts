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
