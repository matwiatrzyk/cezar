import { expect, it, vi } from 'vitest';
import { randomInt } from 'node:crypto';
import { TelegramBotRuntime } from './runtime.ts';
import { BotLease } from './ownership.ts';
import { freshState, InboundStateStore } from './state.ts';
import { Pairings } from './pairing.ts';
import type { TelegramCall } from './client.ts';

it.each([false, true])('pairs before grants exist, with wrong-chat attempts=%s, persists progress and releases ownership', async wrongChat => {
  const botId = String(randomInt(100000, 99999999)), lease = await BotLease.acquire(botId);
  const binding = await lease.bind({ projectId: 'project', installationId: 'installation', root: '/project' });
  const state = new InboundStateStore(freshState(botId, binding), { assertOwner: () => lease.assertOwner(), async write() {} });
  const pairings = new Pairings(() => 10_000);
  const session = pairings.create({ receiverId: 'receiver', botId, chatId: '456', deliveryRevision: 1 }, 'test_bot');
  const code = new URL(session.deepLink).searchParams.get('start');
  let polls = 0; const responses: string[] = [];
  const call: TelegramCall = async (method, _body, signal) => {
    if (method === 'getMe') return { id: Number(botId), username: 'test_bot', first_name: 'Test' };
    if (method !== 'getUpdates') { responses.push(String('text' in _body ? _body.text : '')); return {}; }
    if (++polls === 1) return (wrongChat ? [789, 789, 456] : [456]).map((person, index) => ({ update_id: index + 1, message: { message_id: index + 1, date: 10, chat: { id: person, type: 'private' }, from: { id: person, is_bot: false }, text: `/start ${code}`, entities: [{ type: 'bot_command', offset: 0, length: 6 }] } }));
    return new Promise(resolve => signal?.addEventListener('abort', () => resolve([]), { once: true }));
  };
  const context = vi.fn(), deliver = vi.fn();
  const runtime = new TelegramBotRuntime({ botId, projectRoot: '/project', state, lease, pairings, call, receiver: () => undefined,
    assertCredentials: async () => {}, context, deliver, episode: () => undefined, changed() {}, now: () => 10_000 });
  try {
    await runtime.start();
    await vi.waitFor(() => expect(state.snapshot().nextOffset).toBe(wrongChat ? 4 : 2));
    expect(pairings.get(session.session.id)?.candidate?.userId).toBe('456');
    expect(context).not.toHaveBeenCalled(); expect(deliver).not.toHaveBeenCalled();
    if (wrongChat) { await vi.waitFor(() => expect(responses).toHaveLength(1)); expect(responses[0]).toContain('innego czatu'); expect(responses[0]).not.toContain('/project'); }
  } finally { await runtime.stop(); await lease.release(); }
  const replacement = await BotLease.acquire(botId); await replacement.release();
});

it('aborts startup and waits for it before declaring shutdown safe', async () => {
  const botId = String(randomInt(100000, 99999999)), lease = await BotLease.acquire(botId);
  const binding = await lease.bind({ projectId: 'project', installationId: 'installation', root: '/project' });
  const state = new InboundStateStore(freshState(botId, binding), { assertOwner: () => lease.assertOwner(), async write() {} });
  let started = false, aborted = false;
  let settle!: () => void;
  const call: TelegramCall = async (_method, _body, signal) => {
    started = true;
    return new Promise(resolve => {
      settle = () => resolve({ id: Number(botId), username: 'test_bot' });
      signal?.addEventListener('abort', () => { aborted = true; settle(); }, { once: true });
    });
  };
  const runtime = new TelegramBotRuntime({ botId, projectRoot: '/project', state, lease, pairings: new Pairings(), call,
    receiver: () => undefined, assertCredentials: async () => {}, context: vi.fn(), deliver: vi.fn(), episode: () => undefined, changed() {} });
  const startup = runtime.start();
  try {
    await vi.waitFor(() => expect(started).toBe(true));
    expect(await runtime.stop()).toBe(true);
    expect(aborted).toBe(true);
    expect(runtime.health().state).toBe('stopped');
  } finally { settle?.(); await startup; await runtime.stop(); await lease.release(); }
});
