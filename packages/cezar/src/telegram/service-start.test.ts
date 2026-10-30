import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomInt, randomUUID } from 'node:crypto';
import { TelegramInbound } from './service.ts';
import type { PrivateReceiver } from '../webhooks/endpoints.ts';
import type { TelegramCall } from './client.ts';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.unstubAllEnvs(); });

it('polls a bot whose wizard pairing was restored after a restart, before any grant exists (#7)', async () => {
  vi.stubEnv('CEZ_WEBHOOKS', '1'); vi.stubEnv('CEZ_CHAT_INBOUND', '1');
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'telegram-start-')));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const botId = String(randomInt(100000, 99999999));
  const receiver = { id: randomUUID(), revision: 1, deliveryRevision: 1, format: 'telegram.v1', telegramChatId: '456', state: 'active', lastTest: 'success',
    profile: 'standard', events: ['task.attention_required'], telegramSecret: { sha256: 'a'.repeat(64) } } as PrivateReceiver;
  let polls = 0;
  const call = vi.fn<TelegramCall>(async (method, _body, signal) => {
    if (method === 'getMe') return { id: Number(botId), username: 'test_bot', first_name: 'Test' };
    if (method === 'getUpdates') { polls++; return new Promise(resolve => signal?.addEventListener('abort', () => resolve([]), { once: true })); }
    return {};
  });
  const options = { projectId: 'project', root: directory, installationId: randomUUID(), directory, mode: 'local' as const,
    receivers: () => [receiver], call: () => call, context: vi.fn(), deliver: vi.fn(), episode: () => undefined, changed() {}, now: () => Date.now() };
  const first = new TelegramInbound(options);
  await first.beginSetup({ receiverId: receiver.id, expectedRevision: first.list().receivers[0]!.inboundRevision, dedicatedBot: true, mode: 'task_control' });
  await first.dispose();
  polls = 0;
  const restarted = new TelegramInbound(options);
  cleanups.push(() => restarted.dispose());
  await restarted.load(); await restarted.start();
  await vi.waitFor(() => expect(polls).toBeGreaterThan(0));
});
