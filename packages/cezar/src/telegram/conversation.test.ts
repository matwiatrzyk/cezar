import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { TelegramConversation } from './conversation.ts';
import { freshState, InboundStateStore } from './state.ts';
import type { PrivateReceiver } from '../webhooks/endpoints.ts';
import type { ProjectContext } from '../server/project-context.ts';
import type { RunRecord } from '../runs/store.ts';
import type { TelegramUpdate } from './protocol.ts';

function fixture() {
  const state = freshState('123', { projectId: 'project', installationId: 'instance', root: '/repo', generation: randomUUID() });
  const generation = randomUUID();
  state.receivers.push({ receiverId: 'receiver', chatId: '456', enabled: true, generation, acceptAfter: 0, deliveryRevision: 1, credentialFingerprint: 'a'.repeat(64) });
  state.grants.push({ id: randomUUID(), receiverId: 'receiver', chatId: '456', userId: '456', label: 'Person', permissions: ['respond'], generation: randomUUID(), enableGeneration: generation, approvedAt: 0 });
  let disk = structuredClone(state);
  const store = new InboundStateStore(state, { assertOwner() {}, async write(next) { disk = structuredClone(next); }, now: () => 10_000 });
  const receiver = { id: 'receiver', format: 'telegram.v1', state: 'active', lastTest: 'success', profile: 'standard', events: ['task.attention_required'],
    telegramChatId: '456', deliveryRevision: 1, telegramSecret: { sha256: 'a'.repeat(64) } } as PrivateReceiver;
  const run = { id: '12345678-abcd-4000-8000-123456789abc', title: '<b>Private @all</b>', status: 'waiting', archived: false, steps: [] } as unknown as RunRecord;
  const project = { store: { listRuns: () => [run], getRun: (id: string) => id === run.id ? run : undefined, redactRunText: (_id: string, text: string) => text } } as unknown as ProjectContext;
  const responses: string[] = []; const delivered: string[] = [];
  const context = vi.fn(async () => project);
  const deliver = vi.fn(async (_project: ProjectContext, _run: RunRecord, text: string, check: () => string | undefined) => {
    expect(disk.journal.at(-1)?.state).toBe('claimed');
    const error = check(); if (error) return { status: 409 as const, body: { error } };
    delivered.push(text); return { status: 200 as const, body: { delivered: true as const } };
  });
  const conversation = new TelegramConversation({ botId: '123', username: 'test_bot', state: store, receiver: () => receiver, context, deliver,
    episode: () => 'task-5', reply: (_chat, text, valid) => { if (valid()) responses.push(text); }, now: () => 10_000 });
  const update = (text = '/reply 12345678 hello', update_id = 1, userId = 456): TelegramUpdate => ({ update_id, message: { message_id: 1, date: 10,
    chat: { id: userId, type: 'private' }, from: { id: userId, is_bot: false }, text, entities: text.startsWith('/') ? [{ type: 'bot_command', offset: 0, length: text.split(' ')[0]!.length }] : [] } });
  return { state: store, disk: () => disk, receiver, run, project, context, deliver, delivered, responses, conversation, update };
}
describe('Telegram conversation to task delivery', () => {
  it('durably claims before effect, prefixes text, stores result before acknowledging and deduplicates', async () => {
    const x = fixture(), update = x.update(), epoch = x.state.snapshot().epoch;
    await x.conversation.process(update, epoch); await x.conversation.process(update, epoch);
    expect(x.delivered).toEqual(['[via Telegram] hello']);
    expect(x.disk().journal.at(-1)).toMatchObject({ state: 'accepted', runId: x.run.id });
    expect(x.disk().nextOffset).toBe(2);
    expect(x.responses).toEqual(['Przekazano.']);
    expect(JSON.stringify(x.disk())).not.toContain('hello');
  });
  it('does not open a project for an ungranted person', async () => {
    const x = fixture(); await x.conversation.process(x.update('/tasks', 1, 789), x.state.snapshot().epoch);
    expect(x.context).not.toHaveBeenCalled(); expect(x.delivered).toEqual([]);
    expect(x.responses.join(' ')).not.toContain('Private');
  });
  it('rechecks grant after asynchronous project recovery', async () => {
    const x = fixture(); x.context.mockImplementationOnce(async () => { await x.state.change(state => { state.grants = []; }); return x.project; });
    await x.conversation.process(x.update(), x.state.snapshot().epoch);
    expect(x.delivered).toEqual([]); expect(x.disk().journal.at(-1)?.state).toBe('rejected');
  });
  it('does not revive finished runs and rejects unknown commands instead of passing to agent', async () => {
    const x = fixture(); x.run.status = 'done';
    await x.conversation.process(x.update(), x.state.snapshot().epoch);
    await x.conversation.process(x.update('/shell rm', 2), x.state.snapshot().epoch);
    expect(x.delivered).toEqual([]); expect(x.disk().journal.map(entry => entry.state)).toEqual(['rejected', 'rejected']);
  });
  it('marks an ambiguous delivery exception uncertain and never retries the action', async () => {
    const x = fixture(); x.deliver.mockRejectedValueOnce(new Error('possibly delivered secret'));
    const update = x.update(), epoch = x.state.snapshot().epoch;
    await x.conversation.process(update, epoch); await x.conversation.process(update, epoch);
    expect(x.deliver).toHaveBeenCalledTimes(1); expect(x.disk().journal.at(-1)?.state).toBe('uncertain');
    expect(JSON.stringify(x.disk())).not.toContain('possibly delivered secret');
  });
  it('requires current Reply correlation; never falls back to an arbitrary waiting task', async () => {
    const x = fixture(), message = x.update('yes'); message.message!.reply_to_message = { message_id: 5 };
    await x.conversation.process(message, x.state.snapshot().epoch); expect(x.delivered).toEqual([]);
    await x.state.change(state => { state.correlations.push({ receiverId: 'receiver', chatId: '456', messageId: 5, deliveryRevision: 1,
      bindingGeneration: state.binding.generation, enableGeneration: state.receivers[0]!.generation, runId: x.run.id,
      type: 'task.attention_required', sequence: 5, episodeId: 'task-5', continuation: 0, createdAt: 10_000 }); });
    await x.conversation.process({ ...message, update_id: 2 }, x.state.snapshot().epoch);
    expect(x.delivered).toEqual(['[via Telegram] yes']);
  });
  it('renders task status as escaped redacted text with prose-question limitation', async () => {
    const x = fixture(); await x.conversation.process(x.update('/status 12345678'), x.state.snapshot().epoch);
    expect(x.responses.join(' ')).toContain('&lt;b&gt;'); expect(x.responses.join(' ')).not.toContain('<b>Private');
    expect(x.responses.join(' ')).toContain('cockpicie'); expect(x.delivered).toEqual([]);
  });
  it('ignores messages addressed to another bot without opening context', async () => {
    const x = fixture(); await x.conversation.process(x.update('/reply@other 12345678 hello'), x.state.snapshot().epoch);
    expect(x.context).not.toHaveBeenCalled(); expect(x.responses).toEqual([]); expect(x.disk().nextOffset).toBe(2);
  });
  it('rejects stale and oversized input without truncating it into an agent command', async () => {
    const x = fixture(), stale = x.update(); stale.message!.date = 1000;
    await x.conversation.process(stale, x.state.snapshot().epoch);
    await x.conversation.process(x.update('/reply 12345678 ' + 'x'.repeat(4001), 2), x.state.snapshot().epoch);
    expect(x.delivered).toEqual([]); expect(x.context).not.toHaveBeenCalled();
  });
});
it('accepts 4000 UTF-16 units of /reply content without counting the command and task reference', async () => {
  const x = fixture(), text = 'a'.repeat(4000);
  await x.conversation.process(x.update(`/reply ${x.run.id} ${text}`), x.state.snapshot().epoch);
  expect(x.delivered).toEqual([`[via Telegram] ${text}`]);
});
it('budgets /tasks by whole escaped lines so a task ID is never cut at the output limit', async () => {
  const x = fixture();
  const runs = Array.from({ length: 10 }, (_, i) => ({ ...x.run, id: `12345678-abcd-4000-8000-${String(i).padStart(12, '0')}`, title: '&'.repeat(180) }));
  vi.spyOn(x.project.store, 'listRuns').mockReturnValue(runs);
  await x.conversation.process(x.update('/tasks'), x.state.snapshot().epoch);
  expect(x.responses[0]!.split('\n')).toHaveLength(4);
  for (const line of x.responses[0]!.split('\n')) expect(line).toMatch(/^12345678-abcd-4000-8000-\d{12} · waiting · (&amp;){180}$/);
});
it('group grants accept explicitly addressed commands but not ambient messages, other bots or private commands', async () => {
  const x = fixture(); x.receiver.telegramChatId = '-123';
  await x.state.change(state => { state.receivers[0]!.chatId = '-123'; state.grants[0]!.chatId = '-123'; });
  for (const [index, text] of ['/tasks', 'ambient discussion', '/tasks@other_bot'].entries()) {
    const update = x.update(text, index + 1); update.message!.chat = { id: -123, type: 'group' };
    await x.conversation.process(update, x.state.snapshot().epoch);
  }
  expect(x.context).not.toHaveBeenCalled(); expect(x.responses).toEqual([]);
  await x.conversation.process(x.update('/tasks', 4), x.state.snapshot().epoch);
  expect(x.context).not.toHaveBeenCalled();
  const addressed = x.update('/reply@test_bot 12345678 yes', 5); addressed.message!.chat = { id: -123, type: 'group' };
  await x.conversation.process(addressed, x.state.snapshot().epoch);
  expect(x.delivered).toEqual(['[via Telegram] yes']);
});
