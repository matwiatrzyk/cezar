import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { authorize, correlationCurrent, grantFresh } from './authorization.ts';
import { freshState, type Correlation } from './state.ts';
import type { PrivateReceiver } from '../webhooks/endpoints.ts';
import type { RunRecord } from '../runs/store.ts';

function fixture() {
  const state = freshState('123', { projectId: 'project', installationId: 'instance', root: '/repo', generation: randomUUID() });
  const receiver = { id: 'receiver', format: 'telegram.v1', state: 'active', lastTest: 'success', profile: 'standard', events: ['task.attention_required'],
    telegramChatId: '456', deliveryRevision: 1, telegramSecret: { sha256: 'a'.repeat(64) } } as PrivateReceiver;
  const generation = randomUUID();
  state.receivers.push({ receiverId: receiver.id, chatId: '456', enabled: true, generation, acceptAfter: 1000, deliveryRevision: 1, credentialFingerprint: 'a'.repeat(64) });
  state.grants.push({ id: randomUUID(), receiverId: receiver.id, chatId: '456', userId: '456', label: 'Person', permissions: ['respond'], generation: randomUUID(), enableGeneration: generation, approvedAt: 2000 });
  const run = { id: 'task', status: 'waiting', archived: false, steps: [], attentionRequest: { requestId: 'ask', askedAt: '2026-10-27T00:00:00Z', questions: [{ question: 'Continue?' }] } } as unknown as RunRecord;
  const correlation: Correlation = { receiverId: receiver.id, chatId: '456', messageId: 1, deliveryRevision: 1, bindingGeneration: state.binding.generation,
    enableGeneration: generation, runId: run.id, type: 'task.attention_required', sequence: 5, episodeId: 'task-5', continuation: 0,
    requestId: 'ask', askedAt: run.attentionRequest!.askedAt, createdAt: 2000 };
  return { state, receiver, run, correlation };
}
describe('Telegram authorization and reply freshness', () => {
  it('denies unknown users and revocation, independently of receiver notification filters', () => {
    const { state, receiver } = fixture();
    expect(authorize(state, '456', '456', () => receiver)?.permissions).toEqual(['respond']);
    expect(authorize(state, '456', '789', () => receiver)).toBeUndefined();
    state.grants = [];
    expect(authorize(state, '456', '456', () => receiver)).toBeUndefined();
  });
  it('rejects rotated credentials, changed chat, Minimal, paused receiver and old generations', () => {
    for (const change of [
      (x: ReturnType<typeof fixture>) => { x.receiver.telegramSecret!.sha256 = 'b'.repeat(64); },
      (x: ReturnType<typeof fixture>) => { x.receiver.telegramChatId = '789'; },
      (x: ReturnType<typeof fixture>) => { x.receiver.profile = 'minimal'; },
      (x: ReturnType<typeof fixture>) => { x.receiver.state = 'paused'; },
      (x: ReturnType<typeof fixture>) => { x.state.receivers[0]!.generation = randomUUID(); },
      (x: ReturnType<typeof fixture>) => { x.receiver.deliveryRevision++; },
    ]) {
      const x = fixture(); change(x); expect(authorize(x.state, '456', '456', () => x.receiver)).toBeUndefined();
    }
  });
  it('uses both grant and enable time boundaries', () => {
    const { state } = fixture(), grant = state.grants[0]!;
    expect(grantFresh(state, grant, 1, 3000)).toBe(false);
    expect(grantFresh(state, grant, 3, 3000)).toBe(true);
    state.receivers[0]!.acceptAfter = 4000;
    expect(grantFresh(state, grant, 3, 4000)).toBe(false);
  });
  it('rejects repeated question IDs after Continue, absent episode and changed question time', () => {
    const { state, correlation, run } = fixture();
    expect(correlationCurrent(state, correlation, run, 'task-5')).toBe(true);
    expect(correlationCurrent(state, correlation, run, undefined)).toBe(false);
    run.steps = [{ id: 'continue-1' }] as RunRecord['steps'];
    expect(correlationCurrent(state, correlation, run, 'task-5')).toBe(false);
    run.steps = []; run.attentionRequest!.askedAt = '2026-10-27T01:00:00Z';
    expect(correlationCurrent(state, correlation, run, 'task-5')).toBe(false);
  });
  it('supports prose waiting only with a matching captured episode', () => {
    const { state, correlation, run } = fixture();
    delete run.attentionRequest; delete correlation.requestId; delete correlation.askedAt;
    expect(correlationCurrent(state, correlation, run, 'task-5')).toBe(true);
    expect(correlationCurrent(state, correlation, run, 'task-6')).toBe(false);
    run.status = 'running'; expect(correlationCurrent(state, correlation, run, 'task-5')).toBe(false);
  });
});
it('accepts the shipped attention/all presets even though their custom event arrays are empty', async () => {
  const { receiverEligible } = await import('./authorization.ts');
  const { receiver } = fixture(); receiver.events = [];
  receiver.preset = 'attention'; expect(receiverEligible(receiver)).toBe(true);
  receiver.preset = 'all'; expect(receiverEligible(receiver)).toBe(true);
  receiver.preset = 'custom'; expect(receiverEligible(receiver)).toBe(false);
});
it('keeps inbound eligible through an outbound transient suspension, not through a pause', async () => {
  const { receiverEligible } = await import('./authorization.ts');
  const { receiver } = fixture();
  receiver.state = 'suspended'; expect(receiverEligible(receiver)).toBe(true);
  receiver.state = 'paused'; expect(receiverEligible(receiver)).toBe(false);
});
