import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ChatInbound } from './service.ts';
import type { ChatServiceDescriptor, ChatTransport } from './provider.ts';
import type { PrivateReceiver } from '../webhooks/endpoints.ts';
import { discordTransport, discordServiceDescriptor } from './providers/discord/index.ts';
import { slackTransport, slackServiceDescriptor } from './providers/slack/transport.ts';
import { telegramTransport, telegramServiceDescriptor } from './providers/telegram/transport.ts';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.unstubAllEnvs(); });

// Keep real provider identity and outbound sessions, replacing only the receive loop
// and membership evidence. Every outbound call terminates at the simulated wire.
function offline(session: ChatTransport): ChatTransport {
  return { ...session, guarded: valid => offline(session.guarded(valid)),
    isMember: async () => true,
    connect: () => ({ start() {}, async stop() {}, health: () => ({ state: 'polling' }) }) };
}
const providers = ['discord', 'slack', 'telegram'] as const;
for (const provider of providers) for (const group of [false, true]) for (const path of ['pair', 'setup', 'token'] as const) {
  it(`${provider} ${group ? 'group' : 'DM'} ${path}: confirmation sends one approval to the verified private destination`, async () => {
    vi.stubEnv('CEZ_WEBHOOKS', '1'); vi.stubEnv('CEZ_CHAT_INBOUND', '1');
    const directory = await mkdtemp(join(tmpdir(), 'approval-delivery-'));
    vi.stubEnv('CEZ_HOME', join(directory, 'home'));
    const posts: { destination: string; text: string }[] = [];
    let descriptor: ChatServiceDescriptor, transport: ChatTransport, token: string;
    const botId = provider === 'slack' ? 'T1:U1' : '123456';
    const userId = provider === 'slack' ? 'U2' : '456';
    const privateId = provider === 'discord' ? 'discord:dm:30' : provider === 'slack' ? 'private:T1:U1:D30' : '456';
    const groupId = provider === 'discord' ? 'discord:guild:10:20' : provider === 'slack' ? 'group:T1:U1:C20' : '-10020';
    const nativePrivate = provider === 'discord' ? '/channels/30/messages' : provider === 'slack' ? 'D30' : '456';
    if (provider === 'discord') {
      descriptor = discordServiceDescriptor; token = `${'a'.repeat(24)}.${'b'.repeat(6)}.${'c'.repeat(27)}`;
      transport = discordTransport({ token, request: async (method, url, body) => {
        if (url === '/users/@me') return { id: botId, username: 'bot', bot: true };
        if (method === 'POST') { posts.push({ destination: url, text: (body as { content: string }).content }); return { id: '100', channel_id: '30' }; }
        return url === '/channels/20' ? { id: '20', type: 0, guild_id: '10' } : { id: '30', type: 1, recipients: [{ id: userId }] };
      } });
    } else if (provider === 'slack') {
      descriptor = slackServiceDescriptor; token = JSON.stringify({ botToken: 'xoxb-1234567890', appToken: 'xapp-1234567890' });
      transport = slackTransport({ socket() { throw new Error('No socket allowed'); }, async call(method, body) {
        if (method === 'auth.test') return { team_id: 'T1', user_id: 'U1' };
        if (method === 'chat.postMessage') { const row = body as { channel: string; text: string }; posts.push({ destination: row.channel, text: row.text }); return { channel: row.channel, ts: '1234567890.000001' }; }
        return { channel: { id: 'C20', is_im: false, is_member: true } };
      } });
    } else {
      descriptor = telegramServiceDescriptor; token = `123456:${'A'.repeat(35)}`;
      transport = telegramTransport(async (method, body) => {
        if (method === 'getMe') return { id: Number(botId), username: 'test_bot' };
        if (method === 'sendMessage') { const row = body as { chat_id: string; text: string }; posts.push({ destination: row.chat_id, text: row.text }); return { message_id: 100, chat: { id: Number(row.chat_id) } }; }
        return { id: Number(groupId), type: 'supergroup' };
      });
    }
    transport = offline(transport);
    const receiver = { id: randomUUID(), revision: 1, deliveryRevision: 1, format: descriptor.format, chatId: group ? groupId : privateId,
      state: 'active', lastTest: 'success', profile: 'standard', events: ['task.attention_required'], chatSecret: { sha256: 'a'.repeat(64) } } as PrivateReceiver;
    const receivers = path === 'token' ? [] : [receiver];
    const service = new ChatInbound({ provider: descriptor, projectId: 'p', root: directory, installationId: randomUUID(), directory, mode: 'local',
      receivers: () => receivers, transport: () => transport, credentialTransport: () => transport,
      createReceiverFromToken: async (_token, _name, chatId) => { expect(chatId).toBe(receiver.chatId); receivers.push(receiver); return receiver; },
      context: vi.fn(), deliver: vi.fn(), episode: () => undefined, changed() {} });
    cleanups.push(async () => { await service.dispose(); await rm(directory, { recursive: true, force: true }); });
    const input = path === 'token' ? { token, dedicatedBot: true as const } : { receiverId: receiver.id,
      expectedRevision: service.list().receivers[0]!.inboundRevision, dedicatedBot: true as const, ...(group ? { groupVisibilityAccepted: true as const } : {}) };
    const begun = path === 'pair' ? await service.pair(input) : await service.beginSetup(input);
    const id = 'pairingId' in begun ? begun.pairingId : begun.setupId;
    const url = new URL(begun.deepLink), code = url.searchParams.get('start') ?? url.searchParams.get('cezar_start') ?? new URLSearchParams(url.hash.slice(1)).get('cezar-start')!;
    const accept = (chatId: string, kind: 'private' | 'group', actor = userId) => service.pairings.accept(botId, botId, {
      id: '1', at: Date.now(), chat: { id: chatId, kind }, user: { id: actor, label: 'Person' }, text: `/start ${code}`,
      addressed: true, command: { kind: 'command', name: 'start', args: code } });
    if (group && path === 'token') {
      expect(accept(groupId, 'group')).toBe('candidate');
      const status = service.setupStatus(id);
      await expect(service.activateSetup(id, { activate: true, taskControl: true, permissions: ['respond'], groupVisibilityAccepted: true,
        comparisonVerified: true, expectedRevision: status.inboundRevision, candidateUserId: userId })).rejects.toMatchObject({ code: 'comparison_required' });
      expect(posts).toEqual([]);
      expect(accept(privateId, 'private', provider === 'slack' ? 'U3' : '789')).toBe('ignored');
    }
    expect(accept(privateId, 'private')).toBe('candidate');
    const status = service.pairing(id);
    expect(status.candidate).toMatchObject({ userId, chatId: privateId, chatType: 'private' });
    const approval = { expectedRevision: status.inboundRevision, candidateUserId: userId, ...(group ? { comparisonVerified: true as const } : {}) };
    const result = path === 'pair' ? await service.confirm(id, approval) : await service.activateSetup(id, {
      ...approval, activate: true, taskControl: true, permissions: ['respond'], ...(group ? { groupVisibilityAccepted: true as const } : {}) });
    expect(result.grant?.chatId).toBe(receiver.chatId);
    await expect.poll(() => posts.length, { timeout: 1500 }).toBe(1);
    expect(posts[0]!.destination).toBe(nativePrivate);
    expect(posts[0]!.text).toContain('Access granted');
    await expect(service.confirm(id, approval)).rejects.toThrow();
    expect(posts).toHaveLength(1);
  });
}
