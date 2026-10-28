import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, randomInt } from 'node:crypto';
import { TelegramInbound } from './service.ts';
import type { PrivateReceiver } from '../webhooks/endpoints.ts';
import type { TelegramCall } from './client.ts';
const cleanups: (() => Promise<void>)[] = [];
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
  const result = await service.confirm(pairing.pairingId, { expectedRevision: candidate.inboundRevision, candidateUserId: '456' });
  expect(result.grant.permissions).toEqual(['respond']);
  expect(service.list().receivers[0]!.state).toBe('active');
  const revoked = await service.revoke(result.grant.id, result.inboundRevision);
  expect(revoked.revoked).toBe(true); expect(service.list().grants).toEqual([]);
  expect(service.list().receivers[0]!.state).toBe('disabled');
});
it('rejects stale configuration and disabled flag before network or grant mutation', async () => {
  const { service, receiver, call } = await fixture(); const revision = service.list().receivers[0]!.inboundRevision;
  receiver.revision++;
  await expect(service.pair({ receiverId: receiver.id, expectedRevision: revision, dedicatedBot: true })).rejects.toMatchObject({ code: 'revision_conflict' });
  vi.stubEnv('CEZ_CHAT_INBOUND', '0');
  await expect(service.pair({ receiverId: receiver.id, expectedRevision: service.list().receivers[0]!.inboundRevision, dedicatedBot: true })).rejects.toMatchObject({ code: 'flag_off' });
  expect(call).not.toHaveBeenCalled(); expect(service.list().available).toBe(false);
});
it('does not approve a candidate after the receiver changed or untrusted permissions were requested', async () => {
  const { service, receiver, installationId } = await fixture();
  const pairing = await service.pair({ receiverId: receiver.id, expectedRevision: service.list().receivers[0]!.inboundRevision, dedicatedBot: true });
  const revision = service.pairing(pairing.pairingId).inboundRevision;
  receiver.telegramChatId = '789'; receiver.revision++;
  await expect(service.confirm(pairing.pairingId, { expectedRevision: revision, candidateUserId: '456' })).rejects.toThrow();
  expect(service.list().grants).toEqual([]);
});
it('disabling preserves grants but re-enable advances the boundary; reset removes all access', async () => {
  const { service, receiver, installationId } = await fixture();
  const pairing = await service.pair({ receiverId: receiver.id, expectedRevision: service.list().receivers[0]!.inboundRevision, dedicatedBot: true });
  const bot = service.list().bots[0]!, code = new URL(pairing.deepLink).searchParams.get('start');
  service.pairings.accept(bot.botId, 'test_bot', { message_id: 1, date: 10, chat: { id: 456, type: 'private' }, from: { id: 456, is_bot: false }, text: `/start ${code}`, entities: [{ type: 'bot_command', offset: 0, length: 6 }] });
  const confirmed = await service.confirm(pairing.pairingId, { expectedRevision: service.pairing(pairing.pairingId).inboundRevision, candidateUserId: '456' });
  const disabled = await service.setEnabled(receiver.id, { enabled: false, expectedRevision: confirmed.inboundRevision });
  expect(service.list().grants).toHaveLength(1); expect(service.list().receivers[0]!.state).toBe('disabled');
  const enabled = await service.setEnabled(receiver.id, { enabled: true, expectedRevision: disabled.inboundRevision });
  expect(service.list().grants[0]!.enableGeneration).not.toBe(confirmed.grant.enableGeneration);
  await service.reset(bot.botId, enabled.inboundRevision);
  expect(service.list().grants).toEqual([]); expect(service.list().receivers).toEqual([expect.objectContaining({ state: 'disabled' })]);
});
it('permission edits move the freshness boundary', async () => {
  const { service, receiver, botId, setNow } = await fixture();
  const first = await service.pair({ receiverId: receiver.id, expectedRevision: service.list().receivers[0]!.inboundRevision, dedicatedBot: true });
  const start = new URL(first.deepLink).searchParams.get('start');
  service.pairings.accept(botId, 'test_bot', { message_id: 1, date: 10, chat: { id: 456, type: 'private' }, from: { id: 456, is_bot: false }, text: `/start ${start}`, entities: [{ type: 'bot_command', offset: 0, length: 6 }] });
  const approved = await service.confirm(first.pairingId, { expectedRevision: service.pairing(first.pairingId).inboundRevision, candidateUserId: '456' });
  setNow(20_000);
  const changed = await service.permissions(approved.grant.id, { expectedRevision: approved.inboundRevision, permissions: ['respond', 'continue'] });
  expect(service.list().grants[0]!.generation).not.toBe(approved.grant.generation);
  const stateBefore = (service as unknown as { bots: Map<string, { state: import('./state.ts').InboundStateStore }> }).bots.get(botId)!.state.snapshot();
  expect(stateBefore.receivers[0]!.acceptAfter).toBe(20_000);
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
  await service.confirm(pairing.pairingId, { expectedRevision: service.pairing(pairing.pairingId).inboundRevision, candidateUserId: '456' });
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
  await service.confirm(paired.pairingId, { expectedRevision: service.pairing(paired.pairingId).inboundRevision, candidateUserId: '456' }); await service.dispose();
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
  await service.confirm(first.pairingId, { expectedRevision: service.pairing(first.pairingId).inboundRevision, candidateUserId: '456' });
  receiver.telegramChatId = '789'; receiver.revision++; receiver.deliveryRevision++;
  await service.pair({ receiverId: receiver.id, expectedRevision: service.list().receivers[0]!.inboundRevision, dedicatedBot: true, replaceExisting: true });
  expect(service.list().grants).toEqual([]); expect(service.list().receivers[0]!.state).toBe('pairing');
});
it.each([false, true])('changed bot never inherits authorization, including target-write failure=%s', async failTargetWrite => {
  const { service, receiver, call, botId } = await fixture();
  const first = await service.pair({ receiverId: receiver.id, expectedRevision: service.list().receivers[0]!.inboundRevision, dedicatedBot: true });
  const code = new URL(first.deepLink).searchParams.get('start');
  service.pairings.accept(botId, 'test_bot', { message_id: 1, date: 10, chat: { id: 456, type: 'private' }, from: { id: 456, is_bot: false }, text: `/start ${code}`, entities: [{ type: 'bot_command', offset: 0, length: 6 }] });
  await service.confirm(first.pairingId, { expectedRevision: service.pairing(first.pairingId).inboundRevision, candidateUserId: '456' });
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
  await service.confirm(pairing.pairingId, { expectedRevision: service.pairing(pairing.pairingId).inboundRevision, candidateUserId: '456' });
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
  await expect(service.confirm(first.pairingId, { expectedRevision: candidate.inboundRevision, candidateUserId: '456' })).rejects.toMatchObject({ code: 'comparison_required' });
  candidateMember = false;
  await expect(service.confirm(first.pairingId, { expectedRevision: candidate.inboundRevision, candidateUserId: '456', comparisonVerified: true })).rejects.toMatchObject({ code: 'candidate_not_group_member' });
  candidateMember = true;
  const approved = await service.confirm(first.pairingId, { expectedRevision: candidate.inboundRevision, candidateUserId: '456', comparisonVerified: true });
  expect(approved.grant.chatId).toBe('-123');
  const second = await pair(789);
  await service.confirm(second.pairingId, { expectedRevision: service.pairing(second.pairingId).inboundRevision, candidateUserId: '789', comparisonVerified: true, permissions: ['respond', 'cancel'] });
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
