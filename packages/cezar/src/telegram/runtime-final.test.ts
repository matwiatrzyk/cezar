import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomInt, randomUUID } from 'node:crypto';
import { TelegramBotRuntime } from './runtime.ts';
import { BotLease } from './ownership.ts';
import { freshState, InboundStateStore } from './state.ts';
import { Pairings } from './pairing.ts';
import type { TelegramCall } from './client.ts';
import type { PrivateReceiver } from '../webhooks/endpoints.ts';
import type { ProjectContext } from '../server/project-context.ts';
import type { RunRecord } from '../runs/store.ts';
import type { TelegramSourceRecord } from '@open-mercato/cezar-contract';

vi.setConfig({ testTimeout: 20_000 });
const wait = { timeout: 8000 };
const SLACK = 'https://hooks.slack.com/services/T0000/B0000/abcdefghijklmnopqrstuvwx';
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

/** A runtime (re)starting over a Telegram-started task whose source is already durable. */
async function harness(options: { status: RunRecord['status']; webhookFinal?: string; reply?: string }) {
  const botId = String(randomInt(100000, 99999999)), lease = await BotLease.acquire(botId);
  const binding = await lease.bind({ projectId: 'project', installationId: 'installation', root: '/project' });
  const dataDir = await mkdtemp(join(tmpdir(), 'telegram-runtime-final-'));
  const state0 = freshState(botId, binding), enableGeneration = randomUUID(), grantId = randomUUID(), grantGeneration = randomUUID(), runId = `run-${randomInt(1e6)}`;
  state0.receivers.push({ receiverId: 'receiver', chatId: '456', enabled: true, generation: enableGeneration, acceptAfter: 0, deliveryRevision: 1, credentialFingerprint: 'a'.repeat(64) });
  state0.grants.push({ id: grantId, receiverId: 'receiver', chatId: '456', userId: '456', label: 'Person', permissions: ['respond'],
    capability: 'task_control', generation: grantGeneration, enableGeneration, approvedAt: 0 });
  const source: TelegramSourceRecord = { id: randomUUID(), botId, epoch: state0.epoch, projectId: 'project', receiverId: 'receiver', grantId, grantGeneration,
    enableGeneration, chatId: '456', userId: '456', sourceMessageId: 1, updateId: 1, episodeId: `${runId}-1`, requestId: randomUUID(), runId,
    state: 'finished', createdAt: Date.now(), updatedAt: Date.now() };
  state0.sources.push(source);
  // What telegram/service.ts recordDelivery stores when the outbound webhook sent the final first.
  if (options.webhookFinal) state0.correlations.push({ receiverId: 'receiver', chatId: '456', messageId: 7, deliveryRevision: 1, bindingGeneration: binding.generation,
    enableGeneration, runId, type: options.webhookFinal, sequence: 3, episodeId: `${runId}-1`, continuation: 0, createdAt: Date.now() });
  const state = new InboundStateStore(state0, { assertOwner: () => lease.assertOwner(), async write() {} });
  const receiver = { id: 'receiver', format: 'telegram.v1', state: 'active', lastTest: 'success', profile: 'standard', events: ['task.attention_required', 'task.finished'],
    url: `https://api.telegram.org/bot${botId}:${'A'.repeat(35)}/sendMessage`, telegramChatId: '456', deliveryRevision: 1, telegramSecret: { sha256: 'a'.repeat(64) } } as PrivateReceiver;
  const slack = { id: 'slack', format: 'slack.v1', state: 'active', url: SLACK } as PrivateReceiver;
  if (options.reply) {
    await mkdir(join(dataDir, 'runs'), { recursive: true });
    await writeFile(join(dataDir, 'runs', `${runId}.ndjson`), JSON.stringify({ type: 'text', text: options.reply, ts: new Date(Date.now() - 1000).toISOString() }) + '\n');
  }
  const run = { id: runId, title: 'Ship it', status: options.status, archived: false, steps: [], telegramSource: source,
    ...(options.status === 'done' ? { completionReason: 'completed' } : {}) } as unknown as RunRecord;
  const runs = new Map([[runId, run]]), events = new EventEmitter();
  const store = { on: events.on.bind(events), off: events.off.bind(events), listRuns: () => [...runs.values()], getRun: (id: string) => runs.get(id),
    redactRunText: (_id: string, text: string) => text };
  const project = { root: '/project', dataDir, store } as unknown as ProjectContext;
  const sent: string[] = [];
  let hold: Promise<void> | undefined;
  const call: TelegramCall = async (method, body, signal) => {
    if (method === 'getMe') return { id: Number(botId), username: 'test_bot' };
    if (method === 'sendMessage') { await hold; sent.push((body as { text: string }).text); return { message_id: 100 + sent.length, chat: { id: 456 } }; }
    if (method === 'getUpdates') return new Promise(resolve => { const timer = setTimeout(() => resolve([]), 10); signal?.addEventListener('abort', () => { clearTimeout(timer); resolve([]); }, { once: true }); });
    return true;
  };
  const runtime = new TelegramBotRuntime({ botId, projectRoot: '/project', state, lease, pairings: new Pairings(), call, receiver: () => receiver,
    receivers: () => [receiver, slack], assertCredentials: async () => {}, context: async () => project, deliver: vi.fn(), createTask: vi.fn(),
    episode: () => undefined, changed() {} } as unknown as ConstructorParameters<typeof TelegramBotRuntime>[0]);
  cleanups.push(async () => { await runtime.stop(); await lease.release(); await rm(dataDir, { recursive: true, force: true }); });
  const update = (next: Partial<RunRecord>) => { const latest = { ...runs.get(runId)!, ...next } as RunRecord; runs.set(runId, latest); events.emit('run', latest); };
  return { runtime, state, sent, update, hold: (gate: Promise<void> | undefined) => { hold = gate; } };
}
const finals = (sent: string[]) => sent.filter(text => /Task completed|Task ready for review|Task failed|Task cancelled/.test(text));

describe('the Telegram runtime final notice', () => {
  it.each(['task.finished', 'task.review_ready', 'task.failed'])('is not sent again when the webhook already delivered %s to the source chat (P2-1)', async type => {
    const x = await harness({ status: 'done', webhookFinal: type });
    await x.runtime.start();
    await new Promise(resolve => setTimeout(resolve, 1500));
    expect(finals(x.sent)).toEqual([]);
  });

  it('is sent once when nothing delivered it yet (guard)', async () => {
    const x = await harness({ status: 'done' });
    await x.runtime.start();
    await vi.waitFor(() => expect(finals(x.sent)).toHaveLength(1), wait);
    await new Promise(resolve => setTimeout(resolve, 1200));
    expect(finals(x.sent)).toHaveLength(1);
  });

  it('redacts every live receiver secret from the agent answer, not only this bot’s (P2-2)', async () => {
    const x = await harness({ status: 'done', reply: `Deployed. Post updates to ${SLACK} from now on.` });
    await x.runtime.start();
    await vi.waitFor(() => expect(finals(x.sent)).toHaveLength(1), wait);
    expect(finals(x.sent)[0]).toContain('Deployed.');
    expect(finals(x.sent)[0]).not.toContain('hooks.slack.com/services');
    expect(finals(x.sent)[0]).not.toContain('abcdefghijklmnopqrstuvwx');
  });

  it('retries a final the reply queue refused instead of losing it (P3-1)', async () => {
    const x = await harness({ status: 'running' });
    await x.runtime.start();
    let release!: () => void;
    x.hold(new Promise<void>(resolve => { release = resolve; }));
    // Fill the bot's reply queue with other chats' notices so the final is refused.
    const fill = () => { for (let index = 0; index < 110; index++) x.runtime.notify(String(1000 + index), `filler ${index}`); };
    fill(); await new Promise(resolve => setTimeout(resolve, 200)); fill(); // the held send left the queue
    const dropped = x.runtime.health().droppedReplies;
    x.update({ status: 'done', completionReason: 'completed' } as Partial<RunRecord>);
    await vi.waitFor(() => expect(x.runtime.health().droppedReplies).toBe(dropped + 1), wait);
    x.hold(undefined); release();
    await vi.waitFor(() => expect(finals(x.sent)).toHaveLength(1), { timeout: 15_000 });
  });
});
