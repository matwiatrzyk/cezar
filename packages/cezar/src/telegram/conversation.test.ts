import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { NoticeThrottle, TelegramConversation, telegramAccessGrantedText } from './conversation.ts';
import { freshState, InboundStateStore } from './state.ts';
import type { PrivateReceiver } from '../webhooks/endpoints.ts';
import type { ProjectContext } from '../server/project-context.ts';
import type { RunRecord } from '../runs/store.ts';
import type { TelegramUpdate } from './protocol.ts';
import type { TelegramTaskCreateResult } from '@open-mercato/cezar-contract';

function fixture() {
  const state = freshState('123', { projectId: 'project', installationId: 'instance', root: '/repo', generation: randomUUID() });
  const generation = randomUUID();
  state.receivers.push({ receiverId: 'receiver', chatId: '456', enabled: true, generation, acceptAfter: 0, deliveryRevision: 1, credentialFingerprint: 'a'.repeat(64) });
  state.grants.push({ id: randomUUID(), receiverId: 'receiver', chatId: '456', userId: '456', label: 'Person', permissions: ['respond'], capability: 'task_control', generation: randomUUID(), enableGeneration: generation, approvedAt: 0 });
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
  const createTask = vi.fn(async (_project: ProjectContext, text: string, source: import('@open-mercato/cezar-contract').TelegramSourceRecord, check: () => string | undefined): Promise<TelegramTaskCreateResult> =>
    check() ? { created: false as const, reason: 'project_unavailable' as const } : { created: true as const, runId: source.runId ?? `new-${text.length}` });
  const conversation = new TelegramConversation({ botId: '123', username: 'test_bot', state: store, receiver: () => receiver, context, deliver,
    createTask,
    episode: () => 'task-5', reply: (_chat, text, valid) => { if (valid()) responses.push(text); }, now: () => 10_000 });
  const update = (text = '/reply 12345678 hello', update_id = 1, userId = 456): TelegramUpdate => ({ update_id, message: { message_id: 1, date: 10,
    chat: { id: userId, type: 'private' }, from: { id: userId, is_bot: false }, text, entities: text.startsWith('/') ? [{ type: 'bot_command', offset: 0, length: text.split(' ')[0]!.length }] : [] } });
  return { state: store, disk: () => disk, receiver, run, project, context, deliver, createTask, delivered, responses, conversation, update };
}
describe('Telegram conversation to task delivery', () => {
  it('creates one task from private text, persists source attribution, then acknowledges', async () => {
    const x = fixture(), update = x.update('please investigate', 9);
    await x.conversation.process(update, x.state.snapshot().epoch);
    await x.conversation.process(update, x.state.snapshot().epoch);
    expect(x.disk().sources).toHaveLength(1);
    expect(x.disk().sources[0]).toMatchObject({ projectId: 'project', receiverId: 'receiver', chatId: '456', userId: '456',
      sourceMessageId: 1, updateId: 9, state: 'finished' });
    expect(x.disk().sources[0]?.runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(x.responses[0]).toMatch(/^Started task [0-9a-f]{8}\.$/);
    expect(JSON.stringify(x.disk())).not.toContain('please investigate');
  });
  it.each(['account_unavailable', 'provider_unavailable', 'project_unavailable'] as const)(
    'records %s as a terminal policy refusal, not delivery failure', async (reason) => {
      const x = fixture();
      x.createTask.mockResolvedValueOnce({ created: false, reason });
      await x.conversation.process(x.update('please investigate', 10), x.state.snapshot().epoch);
      expect(x.disk().sources[0]).toMatchObject({ state: 'policy_refused', policyReason: reason });
      expect(x.disk().journal[0]).toMatchObject({ state: 'rejected', reason });
      expect(x.disk().nextOffset).toBe(11);
    });
  it('records an expired source outcome durably without invoking task creation', async () => {
    const x = fixture();
    await x.state.change(state => { state.grants[0]!.approvedAt = 20_000; });
    await x.conversation.process(x.update('please investigate', 11), x.state.snapshot().epoch);
    expect(x.createTask).not.toHaveBeenCalled();
    expect(x.disk().sources[0]).toMatchObject({ state: 'expired', updateId: 11 });
    expect(x.disk().journal[0]).toMatchObject({ state: 'rejected', reason: 'expired' });
  });
  it('records an expired source outcome durably without invoking task creation', async () => {
    const x = fixture();
    const update = x.update('please investigate', 11);
    update.message!.date = 1;
    await x.conversation.process(update, x.state.snapshot().epoch);
    expect(x.createTask).not.toHaveBeenCalled();
    expect(x.disk().sources[0]).toMatchObject({ state: 'expired', updateId: 11 });
    expect(x.disk().journal[0]).toMatchObject({ state: 'rejected', reason: 'expired' });
  });
  it('durably claims before effect, prefixes text, stores result before acknowledging and deduplicates', async () => {
    const x = fixture(), update = x.update(), epoch = x.state.snapshot().epoch;
    await x.conversation.process(update, epoch); await x.conversation.process(update, epoch);
    expect(x.delivered).toEqual(['[via Telegram] hello']);
    expect(x.disk().journal.at(-1)).toMatchObject({ state: 'accepted', runId: x.run.id });
    expect(x.disk().nextOffset).toBe(2);
    expect(x.responses).toEqual(['Delivered to task 12345678 · &lt;b&gt;Private @​all&lt;/b&gt;.']);
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
    expect(x.responses.join(' ')).toContain('Reply to this message'); expect(x.delivered).toEqual([]);
  });
  it('ignores messages addressed to another bot without opening context', async () => {
    const x = fixture(); await x.conversation.process(x.update('/reply@other 12345678 hello'), x.state.snapshot().epoch);
    expect(x.context).not.toHaveBeenCalled(); expect(x.responses).toEqual([]); await x.state.flush(); expect(x.disk().nextOffset).toBe(2);
  });
  it('rejects stale and oversized input without truncating it into an agent command', async () => {
    const x = fixture(), stale = x.update(); stale.message!.date = 1000;
    await x.conversation.process(stale, x.state.snapshot().epoch);
    await x.conversation.process(x.update('/reply 12345678 ' + 'x'.repeat(4001), 2), x.state.snapshot().epoch);
    expect(x.delivered).toEqual([]); expect(x.context).not.toHaveBeenCalled();
  });

  it('bounds lazy project recovery at 30 seconds and records no delivery', async () => {
    vi.useFakeTimers();
    try {
      const x = fixture();
      let release!: () => void;
      x.context.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve(x.project); }));
      const processing = x.conversation.process(x.update(), x.state.snapshot().epoch);
      expect(x.context).toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(30_000);
      await processing;
      expect(x.delivered).toEqual([]);
      expect(x.disk().journal.at(-1)).toMatchObject({ state: 'rejected', reason: 'context_unavailable' });
      expect(x.disk().sources.at(-1)).toMatchObject({ state: 'policy_refused', policyReason: 'project_unavailable' });
      release?.();
    } finally {
      vi.useRealTimers();
    }
  });
});
it('does not expose an unknown lifecycle code in task status', async () => {
  const x = fixture(); x.run.status = 'future_state' as RunRecord['status'];
  await x.conversation.process(x.update('/status 12345678'), x.state.snapshot().epoch);
  expect(x.responses.join(' ')).toContain('Status unavailable');
  expect(x.responses.join(' ')).not.toContain('future_state');
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
  expect(x.responses[0]!.split('\n')[0]).toBe('12345678 · Waiting for your answer · ' + '&amp;'.repeat(180));
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

it.each([false, true])('checks real grant revocation (%s) between control preview and click', async revoked => {
  const { TelegramActions } = await import('./actions.ts');
  const { prepareTelegramControl } = await import('./controls.ts');
  const x = fixture(); x.run.status = 'done'; x.run.runner = 'codex'; x.run.agentProfile = 'default';
  x.run.steps = [{ sessionId: 'session', backend: 'codex', profileId: 'default' }] as RunRecord['steps'];
  const resume = vi.fn(() => { x.run.status = 'running'; return { ok: true }; });
  Object.assign(x.project, { root: '/nonexistent', manager: { continueRun: resume } });
  await x.state.change(state => { state.grants[0]!.permissions.push('continue'); });
  const sent: Promise<void>[] = [], buttons: string[] = [], responses: string[] = [];
  const actions = new TelegramActions({ botId: '123', state: x.state, call: async () => true, now: () => 10_000,
    reply: (_chat, text, valid) => { if (valid()) responses.push(text); } });
  const conversation = new TelegramConversation({ botId: '123', username: 'test_bot', state: x.state, receiver: () => x.receiver,
    context: x.context, deliver: x.deliver, episode: () => undefined, now: () => 10_000, actions,
    prepareControl: (project, run, kind, text) => prepareTelegramControl(project, run, kind, text, {
      providerActionError: async () => null, resolveProfile: async () => ({ profile: { id: 'default' } }), resolveAttachments: () => [],
    }),
    reply: (_chat, text, valid, receipt, button) => { if (valid()) {
      responses.push(text); if (button) buttons.push(button.callback_data);
      if (receipt) sent.push(receipt({ message_id: 99, chat: { id: 456 } }));
    } },
  });
  const epoch = x.state.snapshot().epoch;
  await conversation.process(x.update('/continue 12345678 private-followup-text'), epoch); await Promise.all(sent);
  expect(resume).not.toHaveBeenCalled(); expect(buttons).toHaveLength(1);
  expect(responses[0]).toContain('costs');
  await x.state.change(state => {
    // An unrelated configuration edit must not invalidate this person's preview.
    state.configGeneration = randomUUID();
    if (revoked) { state.grants[0]!.permissions = ['respond']; state.grants[0]!.generation = randomUUID(); }
  });
  const click: TelegramUpdate = { update_id: 2, callback_query: { id: 'click', data: buttons[0], from: { id: 456, is_bot: false },
    message: { message_id: 99, chat: { id: 456, type: 'private' } } } };
  await actions.process(click, epoch);
  expect(resume).toHaveBeenCalledTimes(revoked ? 0 : 1);
  if (!revoked) {
    expect(responses.at(-1)).toBe('Done.');
    expect(x.disk().journal.at(-1)).toMatchObject({ kind: 'continue', state: 'accepted' });
  }
  await actions.process({ ...click, update_id: 3 }, epoch); expect(resume).toHaveBeenCalledTimes(revoked ? 0 : 1);
  expect(JSON.stringify(x.disk())).not.toContain('private-followup-text');
});

it.each(['cancel', 'continue'])('requires separate %s permission before preparing a preview', async kind => {
  const { TelegramActions } = await import('./actions.ts');
  const x = fixture(), prepareControl = vi.fn(async () => undefined);
  const actions = new TelegramActions({ botId: '123', state: x.state, call: async () => true, reply: () => {} });
  const conversation = new TelegramConversation({ botId: '123', username: 'test_bot', state: x.state, receiver: () => x.receiver,
    context: x.context, deliver: x.deliver, episode: () => undefined, reply: () => {}, now: () => 10_000, actions, prepareControl });
  await conversation.process(x.update(`/${kind} 12345678`), x.state.snapshot().epoch);
  expect(prepareControl).not.toHaveBeenCalled(); expect(x.deliver).not.toHaveBeenCalled();
  await x.state.flush();
  // A paired person's refusal keeps actor and kind instead of folding into the anonymous summary.
  expect(x.disk().journal.at(-1)).toMatchObject({ state: 'rejected', reason: 'permission_denied', kind, userId: '456' });
  expect(x.disk().journal.some(row => row.kind === 'rejection_summary')).toBe(false);
});

describe('Telegram conversation copy', () => {
  it('lists waiting tasks first and hides dispatch children that need nothing', async () => {
    const x = fixture(), run = (n: number, status: string, extra = {}) => ({ ...x.run, id: `${n}0000000-abcd-4000-8000-000000000000`, title: `T${n}`, status, ...extra }) as RunRecord;
    vi.spyOn(x.project.store, 'listRuns').mockReturnValue([run(1, 'done'), run(2, 'running', { dispatch: { parentRunId: 'p' } }), run(3, 'waiting'), run(4, 'waiting', { dispatch: { parentRunId: 'p' } })]);
    await x.conversation.process(x.update('/tasks'), x.state.snapshot().epoch);
    expect(x.responses[0]!.split('\n').map(line => line.split(' · ')[2])).toEqual(['T3', 'T4', 'T1']);
  });
  it('caps /tasks at ten lines', async () => {
    const x = fixture();
    vi.spyOn(x.project.store, 'listRuns').mockReturnValue(Array.from({ length: 15 }, (_, i) => ({ ...x.run, id: `${String(i).padStart(8, '0')}-abcd-4000-8000-000000000000`, title: 't' })));
    await x.conversation.process(x.update('/tasks'), x.state.snapshot().epoch);
    expect(x.responses[0]!.split('\n')).toHaveLength(10);
  });
  it('tells a paired person with paused access that replies are off instead of asking to pair', async () => {
    const x = fixture(); await x.state.change(state => { state.receivers[0]!.enabled = false; });
    await x.conversation.process(x.update('/tasks'), x.state.snapshot().epoch);
    expect(x.responses).toEqual(['Replies are currently off for this chat. Check the cezar cockpit.']);
  });
  it('keeps the pairing hint for private strangers but stays silent for strangers in an unbound group', async () => {
    const x = fixture();
    const group = x.update('/tasks@test_bot', 1, 789); group.message!.chat = { id: -999, type: 'group' };
    await x.conversation.process(group, x.state.snapshot().epoch);
    expect(x.responses).toEqual([]);
    await x.conversation.process(x.update('/tasks', 2, 789), x.state.snapshot().epoch);
    expect(x.responses).toEqual(['To control tasks, start pairing in the cezar cockpit.']);
  });
  it('asks for the answer when /reply has only a task ID', async () => {
    const x = fixture(); await x.conversation.process(x.update('/reply 12345678'), x.state.snapshot().epoch);
    expect(x.responses).toEqual(['Add your answer after the task ID.']); expect(x.delivered).toEqual([]);
  });
  it('points a reply to a finished task at /continue', async () => {
    const x = fixture(); x.run.status = 'done';
    await x.conversation.process(x.update(), x.state.snapshot().epoch);
    expect(x.responses[0]).toContain('Task 12345678 is completed and no longer waiting'); expect(x.responses[0]).toContain('/continue 12345678');
  });
  it('uses the @bot suffix in group help and hints', async () => {
    const x = fixture(); x.receiver.telegramChatId = '-123';
    await x.state.change(state => { state.receivers[0]!.chatId = '-123'; state.grants[0]!.chatId = '-123'; });
    const update = x.update('/help@test_bot'); update.message!.chat = { id: -123, type: 'group' };
    await x.conversation.process(update, x.state.snapshot().epoch);
    expect(x.responses[0]).toContain('/tasks@test_bot'); expect(x.responses[0]).toContain('/reply@test_bot');
    expect(telegramAccessGrantedText('-123', 'test_bot')).toContain('/tasks@test_bot');
    expect(telegramAccessGrantedText('456', 'test_bot')).toContain('Try /tasks ');
  });
  it('throttles notices per key inside the window', () => {
    let now = 0; const throttle = new NoticeThrottle(() => now);
    expect(throttle.allow('pairing:1')).toBe(true); expect(throttle.allow('pairing:1')).toBe(false); expect(throttle.allow('pairing:2')).toBe(true);
    now = 60_000; expect(throttle.allow('pairing:1')).toBe(true);
  });
});
