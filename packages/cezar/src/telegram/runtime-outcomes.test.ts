import { afterEach, describe, expect, it, vi } from 'vitest';

// Replies are paced per chat, so a waitFor spans several send slots.
vi.setConfig({ testTimeout: 20_000 });
const wait = { timeout: 8000 };
import { EventEmitter } from 'node:events';
import { randomInt, randomUUID } from 'node:crypto';
import { TelegramBotRuntime } from './runtime.ts';
import { BotLease } from './ownership.ts';
import { freshState, InboundStateStore, type InboundState } from './state.ts';
import { Pairings } from './pairing.ts';
import { TelegramApiError, type TelegramCall } from './client.ts';
import type { PrivateReceiver } from '../webhooks/endpoints.ts';
import type { ProjectContext } from '../server/project-context.ts';
import type { RunRecord } from '../runs/store.ts';
import type { TelegramSourceRecord, TelegramTaskCreateResult } from '@open-mercato/cezar-contract';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

type Created = (source: TelegramSourceRecord) => TelegramTaskCreateResult;
async function harness(options: { create?: Created; seed?(state: InboundState): void; runs?: RunRecord[]; episode?(runId: string): string | undefined } = {}) {
  const botId = String(randomInt(100000, 99999999)), lease = await BotLease.acquire(botId);
  const binding = await lease.bind({ projectId: 'project', installationId: 'installation', root: '/project' });
  const initial = freshState(botId, binding), generation = randomUUID();
  initial.receivers.push({ receiverId: 'receiver', chatId: '456', enabled: true, generation, acceptAfter: 0, deliveryRevision: 1, credentialFingerprint: 'a'.repeat(64) });
  initial.grants.push({ id: randomUUID(), receiverId: 'receiver', chatId: '456', userId: '456', label: 'Person', permissions: ['respond'],
    capability: 'task_control', generation: randomUUID(), enableGeneration: generation, approvedAt: 0 });
  options.seed?.(initial);
  const state = new InboundStateStore(initial, { assertOwner: () => lease.assertOwner(), async write() {} });
  const receiver = { id: 'receiver', format: 'telegram.v1', state: 'active', lastTest: 'success', profile: 'standard', events: ['task.attention_required'],
    telegramChatId: '456', deliveryRevision: 1, telegramSecret: { sha256: 'a'.repeat(64) } } as PrivateReceiver;
  const runs = new Map((options.runs ?? []).map(run => [run.id, run]));
  const events = new EventEmitter();
  const store = { on: events.on.bind(events), off: events.off.bind(events), listRuns: () => [...runs.values()], getRun: (id: string) => runs.get(id),
    redactRunText: (_id: string, text: string) => text };
  const project = { store } as unknown as ProjectContext;
  const pending: object[] = [], sent: { text: string; messageId: number }[] = [];
  let hold: ((text: string) => Promise<void> | undefined) | undefined, messageId = 100, updateId = 0;
  const call: TelegramCall = async (method, body, signal) => {
    if (method === 'getMe') return { id: Number(botId), username: 'test_bot' };
    if (method === 'sendMessage') {
      const text = String((body as { text: string }).text), id = ++messageId;
      await hold?.(text);
      sent.push({ text, messageId: id }); return { message_id: id, chat: { id: 456 } };
    }
    if (method === 'getUpdates') {
      if (pending.length) return pending.splice(0);
      return new Promise(resolve => { const timer = setTimeout(() => resolve([]), 10); signal?.addEventListener('abort', () => { clearTimeout(timer); resolve([]); }, { once: true }); });
    }
    return true;
  };
  const deliver = vi.fn(async () => ({ status: 200 as const, body: { delivered: true as const } }));
  const createTask = vi.fn(async (_project: ProjectContext, text: string, source: TelegramSourceRecord): Promise<TelegramTaskCreateResult> => {
    const result = options.create?.(source) ?? { created: true as const, runId: source.runId! };
    if (result.created) runs.set(result.runId, { id: result.runId, title: text, status: 'running', archived: false, steps: [], telegramSource: source } as unknown as RunRecord);
    return result;
  });
  const runtime = new TelegramBotRuntime({ botId, projectRoot: '/project', state, lease, pairings: new Pairings(), call, receiver: () => receiver,
    assertCredentials: async () => {}, context: async () => project, deliver, episode: options.episode ?? (() => undefined), changed() {},
    ...{ createTask } } as ConstructorParameters<typeof TelegramBotRuntime>[0]);
  cleanups.push(async () => { await runtime.stop(); await lease.release(); });
  const message = (text: string, replyTo?: number) => ({ update_id: ++updateId, message: { message_id: updateId, date: Math.floor(Date.now() / 1000),
    chat: { id: 456, type: 'private' }, from: { id: 456, is_bot: false }, text, ...(replyTo ? { reply_to_message: { message_id: replyTo, date: 1, chat: { id: 456, type: 'private' } } } : {}) } });
  const update = (run: RunRecord) => { runs.set(run.id, run); events.emit('run', run); };
  return { runtime, state, runs, sent, deliver, createTask, update, push: (text: string, replyTo?: number) => pending.push(message(text, replyTo)),
    hold: (fn: typeof hold) => { hold = fn; } };
}

describe('Telegram task outcomes', () => {
  it('delivers every later policy refusal, not only the first one (#2)', async () => {
    const x = await harness({ create: () => ({ created: false, reason: 'account_unavailable' }) });
    await x.runtime.start();
    x.push('first task');
    await vi.waitFor(() => expect(x.sent.filter(row => row.text.includes('saved account'))).toHaveLength(1), wait);
    x.push('second task');
    await vi.waitFor(() => expect(x.createTask).toHaveBeenCalledTimes(2), wait);
    await vi.waitFor(() => expect(x.sent.filter(row => row.text.includes('saved account'))).toHaveLength(2), wait);
  });

  it('never queues a second final notice while the first is still being sent (#3)', async () => {
    const x = await harness();
    await x.runtime.start();
    x.push('build it');
    await vi.waitFor(() => expect(x.runs.size).toBe(1), wait);
    const run = [...x.runs.values()][0]!;
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    let inFlight = false;
    x.hold(text => text.includes('Task completed') ? (inFlight = true, gate) : undefined);
    x.update({ ...run, status: 'done' } as RunRecord);
    await vi.waitFor(() => expect(inFlight).toBe(true), wait);
    for (let index = 0; index < 3; index++) { x.update({ ...run, status: 'done', title: run.title } as RunRecord); await new Promise(resolve => setTimeout(resolve, 20)); }
    release();
    await vi.waitFor(() => expect(x.sent.some(row => row.text.includes('Task completed'))).toBe(true), wait);
    await new Promise(resolve => setTimeout(resolve, 2500));
    expect(x.sent.filter(row => row.text.includes('Task completed'))).toHaveLength(1);
  });

  it('routes a Reply to the "needs your input" notice into the run (#4)', async () => {
    const x = await harness({ episode: runId => `${runId}-3` });
    await x.runtime.start();
    x.push('ask me');
    await vi.waitFor(() => expect(x.runs.size).toBe(1), wait);
    const run = [...x.runs.values()][0]!;
    const waiting = { ...run, status: 'waiting', attentionRequest: { requestId: randomUUID(), askedAt: new Date().toISOString(), questions: [{ question: 'Which branch?' }] } } as RunRecord;
    x.update(waiting);
    await vi.waitFor(() => expect(x.sent.some(row => row.text.includes('Task needs your input'))).toBe(true), wait);
    const notice = x.sent.find(row => row.text.includes('Task needs your input'))!;
    expect(notice.text).toContain('reply to this message');
    await vi.waitFor(() => expect(x.state.snapshot().correlations.some(row => row.messageId === notice.messageId)).toBe(true), wait);
    x.push('main please', notice.messageId);
    await vi.waitFor(() => expect(x.deliver).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: run.id }), '[via Telegram] main please', expect.any(Function)), wait);
    expect(x.state.snapshot().sources[0]?.state).toBe('finished');
  });

  it('drops the reply hint when the run has no answerable episode (#4)', async () => {
    const x = await harness();
    await x.runtime.start();
    x.push('ask me');
    await vi.waitFor(() => expect(x.runs.size).toBe(1), wait);
    const run = [...x.runs.values()][0]!;
    x.update({ ...run, status: 'waiting' } as RunRecord);
    await vi.waitFor(() => expect(x.sent.some(row => row.text.includes('Task needs your input'))).toBe(true), wait);
    expect(x.sent.find(row => row.text.includes('Task needs your input'))!.text).not.toMatch(/reply to this message/i);
  });

  it('resolves an interrupted source to its existing run and keeps reporting it (#6)', async () => {
    const runId = randomUUID();
    let source!: TelegramSourceRecord;
    const x = await harness({ seed: state => {
      const grant = state.grants[0]!;
      source = { id: randomUUID(), botId: state.botId, epoch: state.epoch, projectId: 'project', receiverId: 'receiver', grantId: grant.id,
        grantGeneration: grant.generation, enableGeneration: grant.enableGeneration, chatId: '456', userId: '456', sourceMessageId: 1, updateId: 1,
        episodeId: randomUUID(), requestId: randomUUID(), runId, state: 'claimed', createdAt: Date.now(), updatedAt: Date.now() };
      state.sources.push(source);
    } });
    x.runs.set(runId, { id: runId, title: 'interrupted', status: 'running', archived: false, steps: [], telegramSource: source } as unknown as RunRecord);
    await x.state.recover();
    expect(x.state.snapshot().sources[0]?.state).toBe('uncertain');
    await x.runtime.start();
    await vi.waitFor(() => expect(x.sent.some(row => row.text.includes('Task in progress'))).toBe(true), wait);
    expect(x.sent.some(row => row.text.includes('cannot tell'))).toBe(false);
    expect(x.state.snapshot().sources[0]?.state).toBe('finished');
  });
});

describe('Telegram runtime startup', () => {
  it('retries a transient startup failure and never reports live replies without a poller (#1)', async () => {
    const botId = String(randomInt(100000, 99999999)), lease = await BotLease.acquire(botId);
    const binding = await lease.bind({ projectId: 'project', installationId: 'installation', root: '/project' });
    const state = new InboundStateStore(freshState(botId, binding), { assertOwner: () => lease.assertOwner(), async write() {} });
    const pairings = new Pairings(() => 10_000);
    pairings.create({ receiverId: 'receiver', botId, chatId: '456', deliveryRevision: 1 }, 'test_bot');
    let online = false, credentials = false;
    const call: TelegramCall = async (method, _body, signal) => {
      if (!online) throw new TelegramApiError('network');
      if (method === 'getMe') return { id: Number(botId), username: 'test_bot' };
      if (method === 'getUpdates') return new Promise(resolve => signal?.addEventListener('abort', () => resolve([]), { once: true }));
      return true;
    };
    const runtime = new TelegramBotRuntime({ botId, projectRoot: '/project', state, lease, pairings, call, receiver: () => undefined,
      // A vault read failure is not an API error and must not become a persisted fatal stop.
      assertCredentials: async () => { if (!credentials) { credentials = true; throw new Error('vault unavailable'); } },
      context: vi.fn(), deliver: vi.fn(), episode: () => undefined, changed() {}, now: () => 10_000, ...{ startupRetryMs: () => 20 } } as ConstructorParameters<typeof TelegramBotRuntime>[0]);
    cleanups.push(async () => { await runtime.stop(); await lease.release(); });
    await runtime.start();
    expect(['polling', 'backoff']).not.toContain(runtime.health().state);
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(state.snapshot().fatalStop).toBeUndefined();
    expect(['polling', 'backoff']).not.toContain(runtime.health().state);
    online = true;
    await vi.waitFor(() => expect(runtime.health().state).toBe('polling'), wait);
  });
});
