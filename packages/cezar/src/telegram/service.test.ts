import { afterEach, expect, it, vi } from 'vitest';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, randomInt } from 'node:crypto';
import { TelegramInbound, TelegramInboundFailure } from './service.ts';
import type { PrivateReceiver } from '../webhooks/endpoints.ts';
import { TelegramApiError, type TelegramCall } from './client.ts';
import { ZodError } from 'zod';
import { grantFresh } from './authorization.ts';
import { BotLease, botDirectory } from './ownership.ts';
import type { InboundStateStore } from './state.ts';
import type { TelegramSetupBegun } from '@open-mercato/cezar-contract';
const cleanups: (() => Promise<void>)[] = [];
const session = (begun: TelegramSetupBegun) => { if (begun.mode !== 'task_control') throw new Error('expected a pairing session'); return begun; };
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.unstubAllEnvs(); });
async function fixture() {
  vi.stubEnv('CEZ_WEBHOOKS', '1'); vi.stubEnv('CEZ_CHAT_INBOUND', '1');
  const directory = await mkdtemp(join(tmpdir(), 'telegram-controller-'));
  const botId = String(randomInt(100000, 99999999));
  let now = 10_000;
  const receiver = { id: randomUUID(), revision: 1, deliveryRevision: 1, format: 'telegram.v1', telegramChatId: '456', state: 'active', lastTest: 'success', profile: 'standard', events: ['task.attention_required'], telegramSecret: { sha256: 'a'.repeat(64) } } as PrivateReceiver;
  const call = vi.fn<TelegramCall>(async (method, _body, signal) => {
    if (method === 'getMe') return { id: Number(botId), username: 'test_bot', first_name: 'Test' };
    if (method === 'getUpdates') return new Promise(resolve => signal?.addEventListener('abort', () => resolve([]), { once: true }));
    return {};
  });
  const installationId = randomUUID();
  const options = { projectId: 'project', root: directory, installationId, directory, mode: 'local' as const,
    receivers: () => [receiver], call: () => call, context: vi.fn(), deliver: vi.fn(), episode: () => undefined, changed() {}, now: () => now };
  const service = new TelegramInbound(options);
  cleanups.push(async () => { await service.dispose(); await rm(directory, { recursive: true, force: true }); });
  return { service, receiver, call, botId, installationId, options, directory, setNow: (value: number) => { now = value; } };
}
it('GET is read-only; explicit pairing discovers bot, confirmation grants only the configured private person', async () => {
  const { service, receiver, call } = await fixture();
  const before = service.list(); expect(call).not.toHaveBeenCalled();
  const pairing = await service.pair({ receiverId: receiver.id, expectedRevision: before.receivers[0]!.inboundRevision, dedicatedBot: true });
  expect(pairing.deepLink).toContain('https://t.me/test_bot?start=');
  expect(service.pairing(pairing.pairingId).status).toBe('waiting');
  const code = new URL(pairing.deepLink).searchParams.get('start');
  const bot = service.list().bots[0]!;
  service.pairings.accept(bot.botId, 'test_bot', { message_id: 1, date: 10, chat: { id: 456, type: 'private' }, from: { id: 456, is_bot: false }, text: `/start ${code}`, entities: [{ type: 'bot_command', offset: 0, length: 6 }] });
  const candidate = service.pairing(pairing.pairingId);
  const result = await service.confirm(pairing.pairingId, { expectedRevision: candidate.inboundRevision, candidateUserId: '456', capability: 'task_control' });
  expect(result.grant.permissions).toEqual(['respond']);
  expect(service.list().receivers[0]!.state).toBe('active');
  const revoked = await service.revoke(result.grant.id, result.inboundRevision);
  expect(revoked.revoked).toBe(true); expect(service.list().grants).toEqual([]);
  expect(service.list().receivers[0]!.state).toBe('disabled');
});
it('orchestrates private-chat setup without exposing credentials', async () => {
  const { service, receiver, botId } = await fixture();
  const begun = session(await service.beginSetup({ receiverId: receiver.id, expectedRevision: service.list().receivers[0]!.inboundRevision,
    dedicatedBot: true, mode: 'task_control' }));
  expect(begun).toMatchObject({ receiverId: receiver.id, mode: 'task_control', bot: { id: botId, username: 'test_bot' } });
  expect(JSON.stringify(begun)).not.toContain('a'.repeat(32));
  const code = new URL(begun.deepLink).searchParams.get('start');
  service.pairings.accept(botId, 'test_bot', { message_id: 1, date: 10, chat: { id: 456, type: 'private' }, from: { id: 456, is_bot: false, first_name: 'Person' },
    text: `/start ${code}`, entities: [{ type: 'bot_command', offset: 0, length: 6 }] });
  const status = service.setupStatus(begun.setupId);
  expect(status).toMatchObject({ status: 'candidate', candidate: { chatId: '456', userId: '456' }, permissions: ['respond'] });
  const active = await service.activateSetup(begun.setupId, { activate: true, mode: 'task_control', expectedRevision: status.inboundRevision,
    candidateUserId: '456', permissions: ['respond', 'continue'] });
  expect(active).toMatchObject({ active: true, mode: 'task_control', grant: { permissions: ['respond', 'continue'] } });
});
it('reports activation success when post-commit setup cleanup exhausts its bounded retries', async () => {
  const x = await fixture();
  const begun = session(await x.service.beginSetup({ receiverId: x.receiver.id, expectedRevision: x.service.list().receivers[0]!.inboundRevision,
    dedicatedBot: true, mode: 'task_control' }));
  x.service.pairings.accept(x.botId, 'test_bot', { message_id: 1, date: 10, chat: { id: 456, type: 'private' }, from: { id: 456, is_bot: false },
    text: `/start ${new URL(begun.deepLink).searchParams.get('start')}`, entities: [{ type: 'bot_command', offset: 0, length: 6 }] });
  const status = x.service.setupStatus(begun.setupId);
  const persistence = vi.spyOn(x.service as unknown as { persistSetups(): void }, 'persistSetups').mockImplementation(() => { throw new Error('cleanup unavailable'); });

  const active = await x.service.activateSetup(begun.setupId, { activate: true, mode: 'task_control', expectedRevision: status.inboundRevision,
    candidateUserId: '456', permissions: ['respond', 'continue'] });

  expect(active).toMatchObject({ active: true, grant: { capability: 'task_control', permissions: ['respond', 'continue'] } });
  expect(persistence).toHaveBeenCalledTimes(3);
  expect(x.service.list()).toMatchObject({ receivers: [{ state: 'active' }], grants: [{ id: active.grant.id, capability: 'task_control' }] });
  expect(() => x.service.setupStatus(begun.setupId)).toThrow(expect.objectContaining({ code: 'pairing_expired' }));
});
it('reconciles stale setup metadata with a durable grant after cleanup exhaustion and recreation', async () => {
  const x = await fixture();
  const begun = session(await x.service.beginSetup({ receiverId: x.receiver.id, expectedRevision: x.service.list().receivers[0]!.inboundRevision,
    dedicatedBot: true, mode: 'task_control' }));
  x.service.pairings.accept(x.botId, 'test_bot', { message_id: 1, date: 10, chat: { id: 456, type: 'private' }, from: { id: 456, is_bot: false },
    text: `/start ${new URL(begun.deepLink).searchParams.get('start')}`, entities: [{ type: 'bot_command', offset: 0, length: 6 }] });
  const status = x.service.setupStatus(begun.setupId);
  const persistence = vi.spyOn(x.service as unknown as { persistSetups(): void }, 'persistSetups').mockImplementation(() => { throw new Error('cleanup unavailable'); });
  const active = await x.service.activateSetup(begun.setupId, { activate: true, mode: 'task_control', expectedRevision: status.inboundRevision,
    candidateUserId: '456', permissions: ['respond', 'continue'] });
  expect(persistence).toHaveBeenCalledTimes(3);
  persistence.mockRestore();

  const reopened = new TelegramInbound(x.options); cleanups.push(() => reopened.dispose());
  expect(() => reopened.setupStatus(begun.setupId)).toThrow(expect.objectContaining({ code: 'pairing_expired' }));
  await expect(reopened.activateSetup(begun.setupId, { activate: true, mode: 'task_control', expectedRevision: active.inboundRevision,
    candidateUserId: '456', permissions: ['respond', 'continue'] })).rejects.toMatchObject({ code: 'pairing_expired' });
  await expect(access(join(x.directory, 'setups.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  await reopened.load();
  expect(reopened.list().grants).toEqual([expect.objectContaining({ id: active.grant.id, capability: 'task_control' })]);
});
it('maps invalid setup credentials and stale setup choices to actionable errors', async () => {
  const x = await fixture();
  x.call.mockRejectedValueOnce(new TelegramApiError('http', 401));
  await expect(x.service.beginSetup({ receiverId: x.receiver.id, expectedRevision: x.service.list().receivers[0]!.inboundRevision,
    mode: 'notifications' })).rejects.toMatchObject({ code: 'invalid_token' });
  expect(() => x.service.setupStatus(randomUUID())).toThrow(expect.objectContaining({ code: 'pairing_expired' }));
});
it('maps blocked, conflicted, vault-unavailable and damaged setup states distinctly', async () => {
  for (const [failure, expected] of [
    [new TelegramApiError('http', 403), 'blocked'],
    [new TelegramInboundFailure(409, 'revision_conflict'), 'conflict'],
    [new TelegramInboundFailure(503, 'credentials_unavailable'), 'vault_unavailable'],
    [new TelegramInboundFailure(409, 'reset_required'), 'damaged_state'],
  ] as const) {
    const x = await fixture();
    vi.spyOn(x.service, 'pair').mockRejectedValueOnce(failure);
    await expect(x.service.beginSetup({ receiverId: x.receiver.id, expectedRevision: x.service.list().receivers[0]!.inboundRevision,
      dedicatedBot: true, mode: 'task_control' })).rejects.toMatchObject({ code: expected });
  }
});
it('recovers a pending setup after service recreation and durably records task-control capability', async () => {
  const x = await fixture();
  const begun = session(await x.service.beginSetup({ receiverId: x.receiver.id, expectedRevision: x.service.list().receivers[0]!.inboundRevision,
    dedicatedBot: true, mode: 'task_control' }));
  x.service.pairings.accept(x.botId, 'test_bot', { message_id: 1, date: 10, chat: { id: 456, type: 'private' }, from: { id: 456, is_bot: false },
    text: `/start ${new URL(begun.deepLink).searchParams.get('start')}`, entities: [{ type: 'bot_command', offset: 0, length: 6 }] });
  await x.service.dispose();
  const reopened = new TelegramInbound(x.options); cleanups.push(() => reopened.dispose());
  const status = reopened.setupStatus(begun.setupId);
  expect(status).toMatchObject({ status: 'candidate', mode: 'task_control', candidate: { userId: '456' } });
  const active = await reopened.activateSetup(begun.setupId, { activate: true, mode: 'task_control', expectedRevision: status.inboundRevision,
    candidateUserId: '456', permissions: ['respond', 'continue'] });
  expect(active.grant.capability).toBe('task_control');
  await expect(access(join(x.directory, 'setups.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  await reopened.dispose();
  const restarted = new TelegramInbound(x.options); cleanups.push(() => restarted.dispose());
  await restarted.load();
  expect(restarted.list().grants).toEqual([expect.objectContaining({ capability: 'task_control' })]);
});
it('notifications-only setup checks the saved token and creates no grant, binding, session or poller', async () => {
  const x = await fixture();
  const begun = await x.service.beginSetup({ receiverId: x.receiver.id, expectedRevision: x.service.list().receivers[0]!.inboundRevision, mode: 'notifications' });
  expect(begun).toEqual({ mode: 'notifications', receiverId: x.receiver.id, bot: { id: x.botId, username: 'test_bot' } });
  expect(x.call.mock.calls.map(([method]) => method)).toEqual(['getMe']);
  expect(x.service.list()).toMatchObject({ receivers: [{ state: 'disabled' }], bots: [], grants: [] });
  expect(x.service.pairings.hasReceiver(x.receiver.id)).toBe(false);
  await expect(access(join(x.directory, 'setups.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(access(join(x.directory, `${x.botId}.json`))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('upgrades a legacy notifications-only or capability-less grant to task control through setup', async () => {
  for (const legacy of ['notifications', undefined] as const) {
    const x = await fixture();
    const first = await paired(x);
    await internals(x.service).bots.get(x.botId)!.state.change(state => {
      if (legacy) state.grants[0]!.capability = legacy; else delete state.grants[0]!.capability;
    });
    const begun = session(await x.service.beginSetup({ receiverId: x.receiver.id, expectedRevision: x.service.list().receivers[0]!.inboundRevision,
      dedicatedBot: true, mode: 'task_control' }));
    x.service.pairings.accept(x.botId, 'test_bot', { message_id: 2, date: 10, chat: { id: 456, type: 'private' }, from: { id: 456, is_bot: false },
      text: `/start ${new URL(begun.deepLink).searchParams.get('start')}`, entities: [{ type: 'bot_command', offset: 0, length: 6 }] });
    const status = x.service.setupStatus(begun.setupId);
    const active = await x.service.activateSetup(begun.setupId, { activate: true, mode: 'task_control', expectedRevision: status.inboundRevision,
      candidateUserId: '456', permissions: ['respond', 'cancel'] });
    expect(active.grant).toMatchObject({ id: first.grant.id, capability: 'task_control', permissions: ['respond', 'cancel'] });
    expect(active.grant.generation).not.toBe(first.grant.generation);
    expect(x.service.list().grants).toEqual([expect.objectContaining({ id: first.grant.id, capability: 'task_control' })]);
  }
});
it('still refuses a duplicate task-control approval', async () => {
  const x = await fixture();
  await paired(x);
  const pairing = await x.service.pair({ receiverId: x.receiver.id, expectedRevision: x.service.list().receivers[0]!.inboundRevision, dedicatedBot: true });
  x.service.pairings.accept(x.botId, 'test_bot', { message_id: 2, date: 10, chat: { id: 456, type: 'private' }, from: { id: 456, is_bot: false }, text: `/start ${new URL(pairing.deepLink).searchParams.get('start')}`, entities: [{ type: 'bot_command', offset: 0, length: 6 }] });
  await expect(x.service.confirm(pairing.pairingId, { expectedRevision: x.service.pairing(pairing.pairingId).inboundRevision, candidateUserId: '456', capability: 'task_control' }))
    .rejects.toMatchObject({ code: 'already_paired' });
});
it('legacy pairing approval requires an explicit task-control capability', async () => {
  const x = await fixture();
  const pairing = await x.service.pair({ receiverId: x.receiver.id, expectedRevision: x.service.list().receivers[0]!.inboundRevision, dedicatedBot: true });
  x.service.pairings.accept(x.botId, 'test_bot', { message_id: 1, date: 10, chat: { id: 456, type: 'private' }, from: { id: 456, is_bot: false }, text: `/start ${new URL(pairing.deepLink).searchParams.get('start')}`, entities: [{ type: 'bot_command', offset: 0, length: 6 }] });
  const revision = x.service.pairing(pairing.pairingId).inboundRevision;
  for (const capability of [undefined, 'notifications']) {
    await expect(x.service.confirm(pairing.pairingId, { expectedRevision: revision, candidateUserId: '456', ...(capability ? { capability } : {}) } as never)).rejects.toBeInstanceOf(ZodError);
  }
  expect(x.service.list().grants).toEqual([]);
});
it('enforces least privilege, cancellation and expiry cleanup of task-control setup', async () => {
  const x = await fixture();
  const setup = async () => session(await x.service.beginSetup({ receiverId: x.receiver.id, expectedRevision: x.service.list().receivers[0]!.inboundRevision,
    dedicatedBot: true, mode: 'task_control' }));
  const begun = await setup();
  x.service.pairings.accept(x.botId, 'test_bot', { message_id: 1, date: 10, chat: { id: 456, type: 'private' }, from: { id: 456, is_bot: false },
    text: `/start ${new URL(begun.deepLink).searchParams.get('start')}`, entities: [{ type: 'bot_command', offset: 0, length: 6 }] });
  const status = x.service.setupStatus(begun.setupId);
  await expect(x.service.activateSetup(begun.setupId, { activate: true, mode: 'task_control', expectedRevision: status.inboundRevision,
    candidateUserId: '456' })).rejects.toMatchObject({ code: 'insufficient_permission' });
  await expect(x.service.activateSetup(begun.setupId, { activate: true, mode: 'notifications', expectedRevision: status.inboundRevision,
    candidateUserId: '456', permissions: ['respond'] } as never)).rejects.toBeInstanceOf(ZodError);
  x.service.cancelPairing(begun.setupId);
  expect(() => x.service.setupStatus(begun.setupId)).toThrow(expect.objectContaining({ code: 'pairing_expired' }));
  await expect(access(join(x.directory, 'setups.json'))).rejects.toMatchObject({ code: 'ENOENT' });

  // Cancelled sessions free their slot: abandoning setup repeatedly never reaches pairing_limit.
  for (let attempt = 0; attempt < 4; attempt++) x.service.cancelPairing((await setup()).setupId);

  const expiring = await setup();
  x.setNow(expiring.expiresAt + 1);
  expect(x.service.setupStatus(expiring.setupId).status).toBe('expired');
  expect(() => x.service.setupStatus(expiring.setupId)).toThrow(expect.objectContaining({ code: 'pairing_expired' }));
  await expect(access(join(x.directory, 'setups.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('rejects stale configuration and disabled flag before network or grant mutation', async () => {
  const { service, receiver, call } = await fixture(); const revision = service.list().receivers[0]!.inboundRevision;
  receiver.revision++;
  await expect(service.pair({ receiverId: receiver.id, expectedRevision: revision, dedicatedBot: true })).rejects.toMatchObject({ code: 'revision_conflict' });
  vi.stubEnv('CEZ_CHAT_INBOUND', '0');
  await expect(service.pair({ receiverId: receiver.id, expectedRevision: service.list().receivers[0]!.inboundRevision, dedicatedBot: true })).rejects.toMatchObject({ code: 'flag_off' });
  expect(call).not.toHaveBeenCalled(); expect(service.list().available).toBe(false);
});
async function paired(x: Awaited<ReturnType<typeof fixture>>) {
  const pairing = await x.service.pair({ receiverId: x.receiver.id, expectedRevision: x.service.list().receivers[0]!.inboundRevision, dedicatedBot: true });
  x.service.pairings.accept(x.botId, 'test_bot', { message_id: 1, date: 10, chat: { id: 456, type: 'private' }, from: { id: 456, is_bot: false }, text: `/start ${new URL(pairing.deepLink).searchParams.get('start')}`, entities: [{ type: 'bot_command', offset: 0, length: 6 }] });
  return x.service.confirm(pairing.pairingId, { expectedRevision: x.service.pairing(pairing.pairingId).inboundRevision, candidateUserId: '456', capability: 'task_control' });
}
const internals = (service: TelegramInbound) => service as unknown as { bots: Map<string, { state: InboundStateStore; runtime?: { health(): { state: string } } }>; discovered: Map<string, string>; confirmed: Map<string, unknown> };
it('does not approve a candidate after the receiver changed or untrusted permissions were requested', async () => {
  const { service, receiver, botId } = await fixture();
  const pairing = await service.pair({ receiverId: receiver.id, expectedRevision: service.list().receivers[0]!.inboundRevision, dedicatedBot: true });
  service.pairings.accept(botId, 'test_bot', { message_id: 1, date: 10, chat: { id: 456, type: 'private' }, from: { id: 456, is_bot: false }, text: `/start ${new URL(pairing.deepLink).searchParams.get('start')}`, entities: [{ type: 'bot_command', offset: 0, length: 6 }] });
  const revision = service.pairing(pairing.pairingId).inboundRevision;
  for (const permissions of [['cancel'], ['respond', 'respond'], ['respond', 'admin']]) {
    await expect(service.confirm(pairing.pairingId, { expectedRevision: revision, candidateUserId: '456', capability: 'task_control', permissions: permissions as never })).rejects.toBeInstanceOf(ZodError);
  }
  await expect(service.confirm(pairing.pairingId, { expectedRevision: revision, candidateUserId: '789', capability: 'task_control' })).rejects.toMatchObject({ code: 'pairing_changed' });
  receiver.telegramChatId = '789'; receiver.revision++;
  await expect(service.confirm(pairing.pairingId, { expectedRevision: revision, candidateUserId: '456', capability: 'task_control' })).rejects.toMatchObject({ code: 'pairing_changed' });
  expect(service.list().grants).toEqual([]);
});
it('disabling preserves grants but re-enable advances the boundary; reset removes all access', async () => {
  const { service, receiver, installationId } = await fixture();
  const pairing = await service.pair({ receiverId: receiver.id, expectedRevision: service.list().receivers[0]!.inboundRevision, dedicatedBot: true });
  const bot = service.list().bots[0]!, code = new URL(pairing.deepLink).searchParams.get('start');
  service.pairings.accept(bot.botId, 'test_bot', { message_id: 1, date: 10, chat: { id: 456, type: 'private' }, from: { id: 456, is_bot: false }, text: `/start ${code}`, entities: [{ type: 'bot_command', offset: 0, length: 6 }] });
  const confirmed = await service.confirm(pairing.pairingId, { expectedRevision: service.pairing(pairing.pairingId).inboundRevision, candidateUserId: '456', capability: 'task_control' });
  const disabled = await service.setEnabled(receiver.id, { enabled: false, expectedRevision: confirmed.inboundRevision });
  expect(service.list().grants).toHaveLength(1); expect(service.list().receivers[0]!.state).toBe('disabled');
  const enabled = await service.setEnabled(receiver.id, { enabled: true, expectedRevision: disabled.inboundRevision });
  expect(service.list().grants[0]!.enableGeneration).not.toBe(confirmed.grant.enableGeneration);
  await service.reset(bot.botId, enabled.inboundRevision);
  expect(service.list().grants).toEqual([]); expect(service.list().receivers).toEqual([expect.objectContaining({ state: 'disabled' })]);
});
it('permission edits move the freshness boundary of that grant only', async () => {
  const { service, receiver, botId, setNow } = await fixture();
  const first = await service.pair({ receiverId: receiver.id, expectedRevision: service.list().receivers[0]!.inboundRevision, dedicatedBot: true });
  const start = new URL(first.deepLink).searchParams.get('start');
  service.pairings.accept(botId, 'test_bot', { message_id: 1, date: 10, chat: { id: 456, type: 'private' }, from: { id: 456, is_bot: false }, text: `/start ${start}`, entities: [{ type: 'bot_command', offset: 0, length: 6 }] });
  const approved = await service.confirm(first.pairingId, { expectedRevision: service.pairing(first.pairingId).inboundRevision, candidateUserId: '456', capability: 'task_control' });
  setNow(20_000);
  const changed = await service.permissions(approved.grant.id, { expectedRevision: approved.inboundRevision, permissions: ['respond', 'continue'] });
  expect(service.list().grants[0]!.generation).not.toBe(approved.grant.generation);
  const stateBefore = internals(service).bots.get(botId)!.state.snapshot();
  expect(stateBefore.receivers[0]!.acceptAfter).toBe(10_000); expect(stateBefore.grants[0]!.approvedAt).toBe(20_000);
  expect(grantFresh(stateBefore, stateBefore.grants[0]!, 15, 20_000)).toBe(false);
});
it('can pair again after explicit disconnect without restoring any old grants', async () => {
  const { service, receiver } = await fixture();
  await service.pair({ receiverId: receiver.id, expectedRevision: service.list().receivers[0]!.inboundRevision, dedicatedBot: true });
  const bot = service.list().bots[0]!;
  await service.disconnect(bot.botId, bot.inboundRevision!);
  expect(service.list().bots).toEqual([]);
  const next = await service.pair({ receiverId: receiver.id, expectedRevision: service.list().receivers[0]!.inboundRevision, dedicatedBot: true });
  expect(next.deepLink).toContain('https://t.me/');
  expect(service.list().grants).toEqual([]);
});
it('keeps outbound message correlation only for a matching enabled receiver generation', async () => {
  const { service, receiver, installationId } = await fixture();
  const pairing = await service.pair({ receiverId: receiver.id, expectedRevision: service.list().receivers[0]!.inboundRevision, dedicatedBot: true });
  const bot = service.list().bots[0]!, code = new URL(pairing.deepLink).searchParams.get('start');
  service.pairings.accept(bot.botId, 'test_bot', { message_id: 1, date: 10, chat: { id: 456, type: 'private' }, from: { id: 456, is_bot: false }, text: `/start ${code}`, entities: [{ type: 'bot_command', offset: 0, length: 6 }] });
  await service.confirm(pairing.pairingId, { expectedRevision: service.pairing(pairing.pairingId).inboundRevision, candidateUserId: '456', capability: 'task_control' });
  const source = { projectId: 'project', installationId, type: 'task.attention_required', sequence: 1, episodeId: 'task-1', snapshot: { id: 'task', status: 'waiting', continuation: 0 } } as import('../webhooks/source.ts').WebhookSource;
  expect(await service.recordDelivery(source, receiver.id, receiver.deliveryRevision, { messageId: 5, chatId: '789' })).toBe(false);
  expect(await service.recordDelivery(source, receiver.id, receiver.deliveryRevision + 1, { messageId: 5, chatId: '456' })).toBe(false);
  expect(await service.recordDelivery(source, receiver.id, receiver.deliveryRevision, { messageId: 5, chatId: '456' })).toBe(true);
  receiver.revision++; receiver.deliveryRevision++;
  expect(await service.recordDelivery(source, receiver.id, receiver.deliveryRevision - 1, { messageId: 6, chatId: '456' })).toBe(false);
});

it.each(['missing', 'corrupt', 'oversized'] as const)('shows %s state as blocked and resets only after explicit revision confirmation', async fault => {
  const { writeFile, readFile } = await import('node:fs/promises');
  const { service, receiver, botId, options, directory, call } = await fixture();
  await service.pair({ receiverId: receiver.id, expectedRevision: service.list().receivers[0]!.inboundRevision, dedicatedBot: true });
  await service.dispose();
  const path = join(directory, `${botId}.json`);
  if (fault === 'missing') await rm(path);
  else await writeFile(path, fault === 'corrupt' ? '{broken' : Buffer.alloc(3 * 1024 * 1024, 1));
  const reopened = new TelegramInbound(options);
  cleanups.unshift(() => reopened.dispose());
  call.mockClear(); await reopened.load(); await reopened.start();
  expect(call).not.toHaveBeenCalled(); expect(reopened.list().grants).toEqual([]);
  const row = reopened.list().bots.find(row => row.botId === botId)!;
  expect(row.health.state).toBe('blocked'); expect(row.inboundRevision).toMatch(/^[a-f0-9]{64}$/);
  await expect(reopened.reset(botId, '0'.repeat(64))).rejects.toMatchObject({ code: 'revision_conflict' });
  await reopened.reset(botId, row.inboundRevision!);
  expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ grants: [], receivers: [], nextOffset: null, phase: 'probing' });
  expect(call).not.toHaveBeenCalled(); expect(reopened.list().bots[0]!.health.state).toBe('stopped');
});
it('refuses damaged-state reset if the bytes change after the displayed revision', async () => {
  const { writeFile, readFile } = await import('node:fs/promises');
  const { service, receiver, botId, options, directory } = await fixture();
  await service.pair({ receiverId: receiver.id, expectedRevision: service.list().receivers[0]!.inboundRevision, dedicatedBot: true }); await service.dispose();
  const path = join(directory, `${botId}.json`); await writeFile(path, '{broken');
  const reopened = new TelegramInbound(options); cleanups.unshift(() => reopened.dispose()); await reopened.load();
  const revision = reopened.list().bots[0]!.inboundRevision!;
  await writeFile(path, '{changed');
  await expect(reopened.reset(botId, revision)).rejects.toMatchObject({ code: 'revision_conflict' });
  expect(await readFile(path, 'utf8')).toBe('{changed');
  await reopened.refreshDiagnostics();
  const refreshed = reopened.list().bots[0]!.inboundRevision!; expect(refreshed).not.toBe(revision);
  await reopened.reset(botId, refreshed);
});
it('can explicitly reset a live store blocked by a failed write without releasing ownership early', async () => {
  const { service, receiver, botId } = await fixture();
  await service.pair({ receiverId: receiver.id, expectedRevision: service.list().receivers[0]!.inboundRevision, dedicatedBot: true });
  const state = (service as unknown as { bots: Map<string, { state: import('./state.ts').InboundStateStore }> }).bots.get(botId)!.state;
  const dependencies = (state as unknown as { dependencies: { write(value: unknown): Promise<void> } }).dependencies;
  const write = vi.spyOn(dependencies, 'write').mockRejectedValueOnce(new Error('disk unavailable'));
  await expect(state.change(() => {})).rejects.toThrow('disk unavailable'); write.mockRestore();
  await service.refreshDiagnostics();
  const bot = service.list().bots[0]!; expect(bot.health.state).toBe('blocked');
  await service.reset(botId, bot.inboundRevision!);
  expect(service.list().bots[0]!.health.state).toBe('stopped'); expect(service.list().grants).toEqual([]);
});
it('coalesces overlapping lifecycle starts into one bot identity check and poller', async () => {
  const { service, receiver, botId, options, call } = await fixture();
  const paired = await service.pair({ receiverId: receiver.id, expectedRevision: service.list().receivers[0]!.inboundRevision, dedicatedBot: true });
  const code = new URL(paired.deepLink).searchParams.get('start');
  service.pairings.accept(botId, 'test_bot', { message_id: 1, date: 10, chat: { id: 456, type: 'private' }, from: { id: 456, is_bot: false }, text: `/start ${code}`, entities: [{ type: 'bot_command', offset: 0, length: 6 }] });
  await service.confirm(paired.pairingId, { expectedRevision: service.pairing(paired.pairingId).inboundRevision, candidateUserId: '456', capability: 'task_control' }); await service.dispose();
  const reopened = new TelegramInbound(options); cleanups.unshift(() => reopened.dispose()); await reopened.load(); call.mockClear();
  let finish!: (value: unknown) => void;
  call.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const first = reopened.start(), second = reopened.start();
  await vi.waitFor(() => expect(finish).toBeDefined());
  expect(call.mock.calls.filter(([method]) => method === 'getMe')).toHaveLength(1);
  finish({ id: Number(botId), username: 'test_bot' });
  await Promise.all([first, second]);
  expect(call.mock.calls.filter(([method]) => method === 'getMe')).toHaveLength(1);
});
it('replaces a changed chat only through fresh pairing and removes the old grant', async () => {
  const { service, receiver, botId } = await fixture();
  const first = await service.pair({ receiverId: receiver.id, expectedRevision: service.list().receivers[0]!.inboundRevision, dedicatedBot: true });
  const code = new URL(first.deepLink).searchParams.get('start');
  service.pairings.accept(botId, 'test_bot', { message_id: 1, date: 10, chat: { id: 456, type: 'private' }, from: { id: 456, is_bot: false }, text: `/start ${code}`, entities: [{ type: 'bot_command', offset: 0, length: 6 }] });
  await service.confirm(first.pairingId, { expectedRevision: service.pairing(first.pairingId).inboundRevision, candidateUserId: '456', capability: 'task_control' });
  receiver.telegramChatId = '789'; receiver.revision++; receiver.deliveryRevision++;
  await service.pair({ receiverId: receiver.id, expectedRevision: service.list().receivers[0]!.inboundRevision, dedicatedBot: true, replaceExisting: true });
  expect(service.list().grants).toEqual([]); expect(service.list().receivers[0]!.state).toBe('pairing');
});
it.each([false, true])('changed bot never inherits authorization, including target-write failure=%s', async failTargetWrite => {
  const { service, receiver, call, botId } = await fixture();
  const first = await service.pair({ receiverId: receiver.id, expectedRevision: service.list().receivers[0]!.inboundRevision, dedicatedBot: true });
  const code = new URL(first.deepLink).searchParams.get('start');
  service.pairings.accept(botId, 'test_bot', { message_id: 1, date: 10, chat: { id: 456, type: 'private' }, from: { id: 456, is_bot: false }, text: `/start ${code}`, entities: [{ type: 'bot_command', offset: 0, length: 6 }] });
  await service.confirm(first.pairingId, { expectedRevision: service.pairing(first.pairingId).inboundRevision, candidateUserId: '456', capability: 'task_control' });
  receiver.revision++; receiver.deliveryRevision++; receiver.telegramSecret!.sha256 = 'b'.repeat(64);
  const replacementId = Number(botId) + 100000000;
  call.mockImplementation(async (method, _body, signal) => method === 'getMe' ? { id: replacementId, username: 'replacement_bot' }
    : method === 'getUpdates' ? new Promise(resolve => signal?.addEventListener('abort', () => resolve([]), { once: true })) : {});
  await expect(service.pair({ receiverId: receiver.id, expectedRevision: service.list().receivers[0]!.inboundRevision, dedicatedBot: true, replaceExisting: true })).rejects.toMatchObject({ code: 'revision_required' });
  const current = service.list().receivers[0]!;
  expect(current.botId).toBe(botId); expect(service.list().grants).toHaveLength(1);
  if (failTargetWrite) {
    const target = (service as unknown as { bots: Map<string, { state: import('./state.ts').InboundStateStore }> }).bots.get(String(replacementId))!;
    const dependencies = (target.state as unknown as { dependencies: { write(value: unknown): Promise<void> } }).dependencies;
    const write = vi.spyOn(dependencies, 'write').mockRejectedValueOnce(new Error('target disk failure'));
    await expect(service.pair({ receiverId: receiver.id, expectedRevision: current.inboundRevision, dedicatedBot: true, replaceExisting: true })).rejects.toThrow('target disk failure');
    write.mockRestore();
    expect(service.list().grants).toEqual([]);
    await service.refreshDiagnostics();
    expect(service.list().bots.find(bot => bot.botId === String(replacementId))!.health.state).toBe('blocked');
    return;
  }
  const paired = await service.pair({ receiverId: receiver.id, expectedRevision: current.inboundRevision, dedicatedBot: true, replaceExisting: true });
  expect(service.list().receivers[0]!.botId).toBe(String(replacementId)); expect(service.list().grants).toEqual([]);
  expect(paired.deepLink).toContain('replacement_bot');
});
it('turning off inbound aborts the pending poll while preserving approved people', async () => {
  const { service, receiver, botId, call, options } = await fixture();
  let aborted = false;
  call.mockImplementation(async (method, _body, signal) => {
    if (method === 'getMe') return { id: Number(botId), username: 'test_bot' };
    if (method === 'getUpdates') return new Promise(resolve => signal?.addEventListener('abort', () => { aborted = true; resolve([]); }, { once: true }));
    return {};
  });
  const pairing = await service.pair({ receiverId: receiver.id, expectedRevision: service.list().receivers[0]!.inboundRevision, dedicatedBot: true });
  service.pairings.accept(botId, 'test_bot', { message_id: 1, date: 10, chat: { id: 456, type: 'private' }, from: { id: 456, is_bot: false }, text: `/start ${new URL(pairing.deepLink).searchParams.get('start')}`, entities: [{ type: 'bot_command', offset: 0, length: 6 }] });
  await service.confirm(pairing.pairingId, { expectedRevision: service.pairing(pairing.pairingId).inboundRevision, candidateUserId: '456', capability: 'task_control' });
  await vi.waitFor(() => expect(call.mock.calls.some(([method]) => method === 'getUpdates')).toBe(true));
  vi.stubEnv('CEZ_CHAT_INBOUND', '0');
  await vi.waitFor(() => expect(aborted).toBe(true), { timeout: 2500 });
  expect(service.list().grants).toHaveLength(1); expect(service.list().available).toBe(false);
  expect(options.context).not.toHaveBeenCalled(); expect(options.deliver).not.toHaveBeenCalled();
});
it('requires group disclosure and comparison, preserves the first person when adding another, and changes permissions per person', async () => {
  const { service, receiver, call, botId } = await fixture(); receiver.telegramChatId = '-123';
  const original = call.getMockImplementation()!;
  let candidateMember = true;
  call.mockImplementation((method, body, signal) => method === 'getChat' ? Promise.resolve({ id: -123, type: 'group' })
    : method === 'getChatMember' ? Promise.resolve({ user: { id: Number((body as { user_id?: number }).user_id) }, status: Number((body as { user_id?: number }).user_id) === 456 && !candidateMember ? 'left' : 'member' }) : original(method, body, signal));
  const input = () => ({ receiverId: receiver.id, expectedRevision: service.list().receivers[0]!.inboundRevision, dedicatedBot: true as const });
  await expect(service.pair(input())).rejects.toMatchObject({ code: 'group_visibility_required' });
  const pair = async (userId: number) => {
    const pairing = await service.pair({ ...input(), groupVisibilityAccepted: true });
    service.pairings.accept(botId, 'test_bot', { message_id: userId, date: 10, chat: { id: userId, type: 'private' }, from: { id: userId, is_bot: false }, text: `/start ${new URL(pairing.deepLink).searchParams.get('start')}`, entities: [{ type: 'bot_command', offset: 0, length: 6 }] });
    return pairing;
  };
  const first = await pair(456), candidate = service.pairing(first.pairingId);
  expect(candidate.candidate?.comparisonCode).toMatch(/^[0-9]{6}$/);
  await expect(service.confirm(first.pairingId, { expectedRevision: candidate.inboundRevision, candidateUserId: '456', capability: 'task_control' })).rejects.toMatchObject({ code: 'comparison_required' });
  candidateMember = false;
  await expect(service.confirm(first.pairingId, { expectedRevision: candidate.inboundRevision, candidateUserId: '456', capability: 'task_control', comparisonVerified: true })).rejects.toMatchObject({ code: 'candidate_not_group_member' });
  candidateMember = true;
  const approved = await service.confirm(first.pairingId, { expectedRevision: candidate.inboundRevision, candidateUserId: '456', capability: 'task_control', comparisonVerified: true });
  expect(approved.grant.chatId).toBe('-123');
  const second = await pair(789);
  await service.confirm(second.pairingId, { expectedRevision: service.pairing(second.pairingId).inboundRevision, candidateUserId: '789', capability: 'task_control', comparisonVerified: true, permissions: ['respond', 'cancel'] });
  expect(service.list().grants).toHaveLength(2);
  expect(service.list().grants[0]!.enableGeneration).toBe(service.list().grants[1]!.enableGeneration);
  const modified = await service.permissions(approved.grant.id, { expectedRevision: service.list().receivers[0]!.inboundRevision, permissions: ['respond', 'continue'] });
  expect(modified.grant.generation).not.toBe(approved.grant.generation);
  expect(service.list().grants.find(grant => grant.userId === '789')!.permissions).toEqual(['respond', 'cancel']);
  await service.revoke(approved.grant.id, modified.inboundRevision);
  expect(service.list().receivers[0]!.state).toBe('active'); expect(service.list().grants).toHaveLength(1);
});
it('shares only a verified bot budget and retains its cooldown through runtime restart', async () => {
  const { service, receiver } = await fixture();
  expect(service.sendBudget(receiver)).toBeUndefined();
  const pairing = await service.pair({ receiverId: receiver.id, expectedRevision: service.list().receivers[0]!.inboundRevision, dedicatedBot: true });
  const budget = service.sendBudget(receiver)!;
  expect(budget).toBeDefined();
  expect(service.sendBudget({ ...receiver, id: randomUUID(), telegramChatId: '789' })).toBe(budget);
  expect(service.sendBudget({ ...receiver, telegramSecret: { ...receiver.telegramSecret!, sha256: 'b'.repeat(64) } })).toBeUndefined();
  budget.cooldown(100_000);
  await service.cancelPairing(pairing.pairingId);
  await service.pair({ receiverId: receiver.id, expectedRevision: service.list().receivers[0]!.inboundRevision, dedicatedBot: true });
  expect(service.sendBudget(receiver)).toBe(budget);
  budget.offer({ id: 'waiting', chat: '456', readyAt: 0, expiresAt: 200_000, valid: () => true });
  expect(budget.take('waiting')).toBe(false);
});
it('disconnect removes state before the binding; a failed binding removal stays resettable and a retry finishes', async () => {
  const { existsSync } = await import('node:fs');
  const x = await fixture(); await paired(x);
  const bot = x.service.list().bots[0]!, path = join(x.directory, `${x.botId}.json`), binding = join(botDirectory(x.botId), 'binding.json');
  const disconnect = vi.spyOn(BotLease.prototype, 'disconnect').mockRejectedValueOnce(Object.assign(new Error('EIO'), { code: 'EIO' }));
  await expect(x.service.disconnect(bot.botId, bot.inboundRevision!)).rejects.toMatchObject({ code: 'EIO' });
  disconnect.mockRestore();
  expect(existsSync(path)).toBe(false); expect(existsSync(binding)).toBe(true);
  const damaged = x.service.list().bots.find(row => row.botId === x.botId)!;
  expect(damaged.health.state).toBe('blocked'); expect(damaged.inboundRevision).toMatch(/^[a-f0-9]{64}$/);
  await x.service.disconnect(x.botId, damaged.inboundRevision!);
  expect(existsSync(binding)).toBe(false); expect(x.service.list().bots).toEqual([]);
  await x.service.pair({ receiverId: x.receiver.id, expectedRevision: x.service.list().receivers[0]!.inboundRevision, dedicatedBot: true });
  expect(x.service.list().grants).toEqual([]);
});
it('pairing replaces a state file stranded without its binding instead of refusing forever', async () => {
  const x = await fixture(); await paired(x); await x.service.dispose();
  await rm(join(botDirectory(x.botId), 'binding.json'));
  const reopened = new TelegramInbound(x.options); cleanups.unshift(() => reopened.dispose()); await reopened.load();
  const pairing = await reopened.pair({ receiverId: x.receiver.id, expectedRevision: reopened.list().receivers[0]!.inboundRevision, dedicatedBot: true });
  expect(pairing.deepLink).toContain('https://t.me/test_bot'); expect(reopened.list().grants).toEqual([]);
});
it('a provider conflict is never restarted by the lifecycle tick, only by an explicit enable', async () => {
  const x = await fixture(), original = x.call.getMockImplementation()!;
  let conflict = false;
  x.call.mockImplementation((method, body, signal) => conflict && method === 'getUpdates' ? Promise.reject(new TelegramApiError('http', 409)) : original(method, body, signal));
  const approved = await paired(x);
  await vi.waitFor(() => expect(x.call.mock.calls.some(([method]) => method === 'getUpdates')).toBe(true));
  // Force the live poll to fail with 409 on its next round.
  conflict = true; const bot = internals(x.service).bots.get(x.botId)!;
  await x.service.setEnabled(x.receiver.id, { enabled: false, expectedRevision: approved.inboundRevision });
  const disabled = x.service.list().receivers[0]!.inboundRevision;
  const enabled = await x.service.setEnabled(x.receiver.id, { enabled: true, expectedRevision: disabled });
  await vi.waitFor(() => expect(bot.runtime!.health().state).toBe('conflict'));
  expect(x.service.list().receivers[0]!.state).toBe('conflict');
  const identities = () => x.call.mock.calls.filter(([method]) => method === 'getMe').length, before = identities();
  await x.service.start(); await x.service.start();
  expect(identities()).toBe(before); expect(bot.runtime!.health().state).toBe('conflict');
  conflict = false;
  const off = await x.service.setEnabled(x.receiver.id, { enabled: false, expectedRevision: enabled.inboundRevision });
  await x.service.setEnabled(x.receiver.id, { enabled: true, expectedRevision: off.inboundRevision });
  expect(identities()).toBeGreaterThan(before);
  await vi.waitFor(() => expect(x.service.list().receivers[0]!.state).toBe('active'));
});
it('persists a fatal conflict across reload until explicit recovery', async () => {
  const x = await fixture(), original = x.call.getMockImplementation()!;
  let conflict = false;
  x.call.mockImplementation((method, body, signal) => conflict && method === 'getUpdates' ? Promise.reject(new TelegramApiError('http', 409)) : original(method, body, signal));
  const approved = await paired(x);
  const disabled = await x.service.setEnabled(x.receiver.id, { enabled: false, expectedRevision: approved.inboundRevision });
  conflict = true;
  await x.service.setEnabled(x.receiver.id, { enabled: true, expectedRevision: disabled.inboundRevision });
  await vi.waitFor(() => expect(x.service.list().receivers[0]!.state).toBe('conflict'));
  await internals(x.service).bots.get(x.botId)!.state.drain();
  await x.service.dispose();
  const reopened = new TelegramInbound(x.options); cleanups.unshift(() => reopened.dispose()); await reopened.load();
  expect(reopened.list().receivers[0]!.state).toBe('conflict');
  const before = x.call.mock.calls.filter(([method]) => method === 'getMe').length;
  await reopened.start();
  expect(x.call.mock.calls.filter(([method]) => method === 'getMe')).toHaveLength(before);
  conflict = false;
  const off = await reopened.setEnabled(x.receiver.id, { enabled: false, expectedRevision: reopened.list().receivers[0]!.inboundRevision });
  await reopened.setEnabled(x.receiver.id, { enabled: true, expectedRevision: off.inboundRevision });
  await vi.waitFor(() => expect(reopened.list().receivers[0]!.state).toBe('active'));
  void approved;
});
it('classifies a startup credential failure and does not retry it automatically', async () => {
  const x = await fixture(), original = x.call.getMockImplementation()!;
  const approved = await paired(x);
  const off = await x.service.setEnabled(x.receiver.id, { enabled: false, expectedRevision: approved.inboundRevision });
  let getMeCalls = 0;
  x.call.mockImplementation((method, body, signal) => method === 'getMe'
    ? (getMeCalls++ === 0 ? original(method, body, signal) : Promise.reject(new TelegramApiError('http', 401)))
    : original(method, body, signal));
  await x.service.setEnabled(x.receiver.id, { enabled: true, expectedRevision: off.inboundRevision });
  await vi.waitFor(() => expect(x.service.list().receivers[0]!.state).toBe('credentials-unavailable'));
  const attempts = x.call.mock.calls.filter(([method]) => method === 'getMe').length;
  await x.service.start(); await x.service.start();
  expect(x.call.mock.calls.filter(([method]) => method === 'getMe')).toHaveLength(attempts);
});
it('reports an approved receiver without a running consumer as stopped', async () => {
  const x = await fixture(); await paired(x); await x.service.dispose();
  const reopened = new TelegramInbound(x.options); cleanups.unshift(() => reopened.dispose()); await reopened.load();
  expect(reopened.list().receivers[0]!.state).toBe('stopped');
});
it('hosted mode answers empty at the service level and never touches Telegram', async () => {
  const x = await fixture(), hosted = new TelegramInbound({ ...x.options, mode: 'hosted' }); cleanups.unshift(() => hosted.dispose());
  await hosted.load(); await hosted.start();
  expect(hosted.list()).toMatchObject({ available: false, reason: 'hosted' });
  await expect(hosted.pair({ receiverId: x.receiver.id, expectedRevision: hosted.list().receivers[0]!.inboundRevision, dedicatedBot: true })).rejects.toMatchObject({ status: 503, code: 'hosted' });
  expect(hosted.activity({ limit: 50 })).toEqual({ entries: [] });
  expect(() => hosted.pairing(randomUUID())).toThrow(expect.objectContaining({ status: 404, code: 'pairing_expired' }));
  expect(hosted.sendBudget(x.receiver)).toBeUndefined(); expect(x.call).not.toHaveBeenCalled();
});
it('flag-off hides stored activity and pairing status', async () => {
  const x = await fixture();
  const pairing = await x.service.pair({ receiverId: x.receiver.id, expectedRevision: x.service.list().receivers[0]!.inboundRevision, dedicatedBot: true });
  await internals(x.service).bots.get(x.botId)!.state.finish(internals(x.service).bots.get(x.botId)!.state.snapshot().epoch, 1,
    { id: randomUUID(), epoch: internals(x.service).bots.get(x.botId)!.state.snapshot().epoch, updateId: 1, at: 10_000, botId: x.botId, kind: 'reply', state: 'accepted', reason: 'delivered', chatId: '456', userId: '456', runId: 'run' });
  expect(x.service.activity({ limit: 50 }).entries).toHaveLength(1);
  vi.stubEnv('CEZ_CHAT_INBOUND', '0');
  expect(x.service.activity({ limit: 50 })).toEqual({ entries: [] });
  expect(() => x.service.pairing(pairing.pairingId)).toThrow(expect.objectContaining({ code: 'pairing_expired' }));
});
it('a read-only home degrades pairing to a refusal without breaking status or start', async () => {
  const { chmod, mkdir } = await import('node:fs/promises');
  const x = await fixture(), home = join(x.directory, 'readonly-home');
  await mkdir(home); await chmod(home, 0o500); vi.stubEnv('CEZ_HOME', home);
  try {
    await x.service.load(); await x.service.start();
    await expect(x.service.pair({ receiverId: x.receiver.id, expectedRevision: x.service.list().receivers[0]!.inboundRevision, dedicatedBot: true })).rejects.toMatchObject({ code: 'EACCES' });
    expect(x.service.list()).toMatchObject({ available: true, receivers: [expect.objectContaining({ state: 'disabled' })], grants: [] });
  } finally { await chmod(home, 0o700); }
});
it('refuses a state file copied from another project root as foreign', async () => {
  const { copyFile, mkdtemp: temp } = await import('node:fs/promises');
  const x = await fixture(); await paired(x); await x.service.dispose();
  const other = await temp(join(tmpdir(), 'telegram-copy-')); cleanups.push(() => rm(other, { recursive: true, force: true }));
  await copyFile(join(x.directory, `${x.botId}.json`), join(other, `${x.botId}.json`));
  const copied = new TelegramInbound({ ...x.options, root: other, directory: other }); cleanups.unshift(() => copied.dispose());
  await copied.load();
  expect(copied.list().grants).toEqual([]);
  await expect(copied.pair({ receiverId: x.receiver.id, expectedRevision: copied.list().receivers[0]!.inboundRevision, dedicatedBot: true })).rejects.toMatchObject({ code: 'foreign_state' });
});
it('a same-bot token rotation suspends access until re-enabled, which keeps the approved people', async () => {
  const x = await fixture(), approved = await paired(x);
  x.receiver.telegramSecret = { ...x.receiver.telegramSecret!, sha256: 'b'.repeat(64) }; x.receiver.revision++;
  expect(x.service.sendBudget(x.receiver)).toBeUndefined();
  const off = await x.service.setEnabled(x.receiver.id, { enabled: false, expectedRevision: x.service.list().receivers[0]!.inboundRevision });
  await x.service.setEnabled(x.receiver.id, { enabled: true, expectedRevision: off.inboundRevision });
  expect(x.service.list().grants).toEqual([expect.objectContaining({ id: approved.grant.id, userId: '456' })]);
  expect(internals(x.service).bots.get(x.botId)!.state.snapshot().receivers[0]!.credentialFingerprint).toBe('b'.repeat(64));
  expect(x.service.sendBudget(x.receiver)).toBeDefined();
});
it('a Minimal profile suspends inbound in the status list; outbound-only suspension does not', async () => {
  const x = await fixture(); await paired(x);
  await vi.waitFor(() => expect(x.service.list().receivers[0]!.state).toBe('active'));
  x.receiver.state = 'suspended';
  expect(x.service.list().receivers[0]!.state).toBe('active');
  x.receiver.state = 'active'; x.receiver.profile = 'minimal';
  expect(x.service.list().receivers[0]!.state).toBe('suspended');
});
it('marks as pairing only the receiver actually being paired', async () => {
  const x = await fixture(), second = { ...x.receiver, id: randomUUID(), telegramChatId: '789' } as PrivateReceiver;
  x.options.receivers = () => [x.receiver, second];
  const first = await x.service.pair({ receiverId: x.receiver.id, expectedRevision: x.service.list().receivers[0]!.inboundRevision, dedicatedBot: true });
  const revision = () => x.service.list().receivers.find(row => row.receiverId === second.id)!.inboundRevision;
  await expect(x.service.pair({ receiverId: second.id, expectedRevision: revision(), dedicatedBot: true })).rejects.toMatchObject({ code: 'revision_required' });
  await x.service.pair({ receiverId: second.id, expectedRevision: revision(), dedicatedBot: true });
  x.service.cancelPairing(first.pairingId);
  const states = Object.fromEntries(x.service.list().receivers.map(row => [row.receiverId, row.state]));
  expect(states).toEqual({ [x.receiver.id]: 'disabled', [second.id]: 'pairing' });
});
it('reset holds maintenance, so no send budget is lent mid-reset', async () => {
  const x = await fixture(); await paired(x);
  const bot = x.service.list().bots[0]!, state = internals(x.service).bots.get(x.botId)!.state, change = state.change.bind(state);
  let lent: unknown = 'unobserved';
  vi.spyOn(state, 'change').mockImplementation(mutation => { lent = x.service.sendBudget(x.receiver); return change(mutation); });
  await x.service.reset(bot.botId, bot.inboundRevision!);
  expect(lent).toBeUndefined(); expect(x.service.sendBudget(x.receiver)).toBeDefined();
});
it('forgets discovery and confirmation bookkeeping for a deleted receiver', async () => {
  const x = await fixture(); await paired(x);
  expect(internals(x.service).discovered.size).toBe(1); expect(internals(x.service).confirmed.size).toBe(1);
  x.options.receivers = () => [];
  x.service.list();
  expect(internals(x.service).discovered.size).toBe(0); expect(internals(x.service).confirmed.size).toBe(0);
});
