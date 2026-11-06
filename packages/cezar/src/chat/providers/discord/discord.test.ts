import { describe, expect, it } from 'vitest';
import { discordTransport, discordServiceDescriptor } from './index.ts';
import { channelIdentity, parseChat } from './identity.ts';
import { discordSession, normalizeDiscordMessage } from './session.ts';
import { discordPresentation } from './presentation.ts';
import { ChatTransportError } from '../../provider.ts';
import { providerConformance } from '../../test-support/conformance.testkit.ts';
import type { DiscordRequest } from './rest.ts';
const token = `${'a'.repeat(24)}.${'b'.repeat(6)}.${'c'.repeat(27)}`;
const channel = (id: string) => id === '10' ? { id, type: 1, recipients: [{ id: '2' }] } : { id, type: 0, guild_id: '20', permission_overwrites: [] };
providerConformance('Discord REST wire', {
 id: 'discord', botId: '1', userId: '2', privateChat: 'discord:dm:10', groupChat: 'discord:guild:20:30', messageId: index => String(index), presentation: discordPresentation,
 session(send) { return discordSession(async (method, path, body) => {
  if (path === '/users/@me') return { id: '1', username: 'Bot', bot: true };
  const id = path.split('/')[2]!;
  if (method === 'GET' && path.startsWith('/channels/')) return channel(id);
  if (path === '/guilds/20') return { id: '20', owner_id: '9' };
  if (path === '/guilds/20/roles') return [{ id: '20', permissions: '1024' }];
  if (method === 'GET' && path.startsWith('/guilds/')) return { user: { id: '2', username: 'Person' }, roles: [] };
  if (method === 'PATCH') return {};
  if (method === 'POST') {
   const wire = body as { content: string; components: Array<{ type: number; components: Array<{ label: string; custom_id: string }> }>; allowed_mentions: unknown };
   expect(wire.allowed_mentions).toEqual({ parse: [], replied_user: false });
   const receipt = await send(channelIdentity(channel(id)).id, { text: wire.content, buttons: wire.components.map(row => row.components.map(button => ({ text: button.label, data: button.custom_id }))) });
   return { id: receipt.messageId, channel_id: id };
  }
  throw new Error('Unexpected simulated wire request');
 }); },
});
describe('Discord boundaries', () => {
 it('classifies identities durably without a cache and refuses raw or conflicting metadata', async () => {
  expect(parseChat('discord:dm:10').kind).toBe('private'); expect(parseChat('discord:guild:20:30').kind).toBe('group');
  expect(() => parseChat('10')).toThrow(); expect(() => channelIdentity({ id: '10', type: 3 })).toThrow();
  const session = discordSession(async () => ({ id: '10', type: 0, guild_id: '20' }));
  await expect(session.send('discord:dm:10', { text: 'secret' })).rejects.toThrow();
 });
 it('normalizes addressed setup and unmentioned replies only to this bot in this channel', async () => {
  const message = { id: '40', channel_id: '30', guild_id: '20', author: { id: '2', username: 'Person' }, timestamp: new Date().toISOString(), content: '<@1> /start abc', message_reference: { channel_id: '30', message_id: '50' }, referenced_message: { id: '50', channel_id: '30', author: { id: '1', username: 'Bot', bot: true } } };
  const request: DiscordRequest = async () => channel('30');
  expect(await normalizeDiscordMessage(message, '1', request)).toMatchObject({ kind: 'start', code: 'abc', chat: { id: 'discord:guild:20:30', kind: 'group' } });
  expect(await normalizeDiscordMessage({ ...message, content: 'answer' }, '1', request)).toMatchObject({ kind: 'message', addressed: false, replyTo: { messageId: '50' } });
  expect(await normalizeDiscordMessage({ ...message, content: 'answer', referenced_message: { ...message.referenced_message, channel_id: '99' } }, '1', request)).not.toHaveProperty('replyTo');
  expect(await normalizeDiscordMessage({ ...message, guild_id: undefined }, '1', request)).toBeUndefined();
 });
 it('checks a rotated credential again after metadata before sending', async () => {
  let valid = true; const effects: string[] = [];
  const transport = discordTransport({ token, request: async (_method, path) => { effects.push(path); valid = false; return channel('10'); } }).guarded(() => valid);
  await expect(transport.send('discord:dm:10', { text: 'secret' })).rejects.toThrow();
  expect(effects).toEqual(['/channels/10']);
 });
 it('returns unknown for transient membership failures and false for definite absence', async () => {
  const unknown = discordSession(async () => { throw new ChatTransportError({ kind: 'transient' }); });
  expect(await unknown.isMember('discord:dm:10', '2')).toBeUndefined();
  const gone = discordSession(async () => { throw new ChatTransportError({ kind: 'gone' }); });
  expect(await gone.isMember('discord:dm:10', '2')).toBe(false);
 });
 it('limits wire content and buttons, suppresses markup and never embeds a token in destination', async () => {
  expect(discordServiceDescriptor.destination(token)).not.toContain(token);
  const session = discordSession(async () => { throw new Error('No wire effect expected'); });
  await expect(session.send('discord:dm:10', { text: 'x'.repeat(2001) })).rejects.toThrow();
  expect(discordPresentation.formatText('@everyone **hi**')).toContain('@\u200b');
  expect(discordPresentation.formatText('🎉'.repeat(3000)).length).toBeLessThanOrEqual(2000);
 });
});
it('resolves vault credentials asynchronously at each effect and fences changed tokens', async () => {
 let current = token, effects = 0;
 const transport = discordTransport({ token: async () => current, request: async () => { effects++; current = token.replace(/^a/, 'z'); return channel('10'); } });
 await expect(transport.send('discord:dm:10', { text: 'secret' })).rejects.toMatchObject({ failure: { kind: 'auth' } });
 expect(effects).toBe(1);
});
it('dry run without an explicit simulated wire never contacts Discord', async () => {
 const transport = discordTransport({ token, dryRun: true });
 await expect(transport.identify()).rejects.toMatchObject({ failure: { kind: 'blocked' } });
});
it('packs shared one-option rows into Discord rows without dropping choices', async () => {
 let body: unknown;
 const session = discordSession(async (method, _path, value) => { if (method === 'GET') return channel('10'); body = value; return { id: '1', channel_id: '10' }; });
 await session.send('discord:dm:10', { text: 'Choose', buttons: Array.from({ length: 10 }, (_, i) => [{ text: `Choice ${i}`, data: `action-${i}` }]) });
 expect((body as { components: unknown[] }).components).toHaveLength(2);
});
it('renders copyable addressed group commands while suppressing other mentions', () => {
 const command = discordPresentation.command('status', '1');
 expect(command).toBe('<@1> /status');
 expect(discordPresentation.formatText(`${command} @everyone`, 2000, '1')).toBe('<@1> /status @\u200beveryone');
});
