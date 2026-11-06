import { expect, it } from 'vitest';
import { discordChannelMember } from './membership.ts';
import type { DiscordRequest } from './rest.ts';
function wire(overwrites: unknown[], roles: unknown[] = [{ id: '20', permissions: '1024' }]): DiscordRequest {
 return async (_method, path) => {
  if (path.endsWith('/members/2')) return { user: { id: '2' }, roles: [] };
  if (path === '/channels/30') return { id: '30', type: 0, guild_id: '20', permission_overwrites: overwrites };
  if (path === '/guilds/20') return { id: '20', owner_id: '9' };
  if (path.endsWith('/roles')) return roles;
  throw Error('unexpected request');
 };
}
it('a guild member denied VIEW_CHANNEL is not authorized, personal allow wins', async () => {
 const deny = { id: '20', type: 0, deny: '1024', allow: '0' };
 expect(await discordChannelMember(wire([deny]), '30', '20', '2')).toBe(false);
 expect(await discordChannelMember(wire([deny, { id: '2', type: 1, deny: '0', allow: '1024' }]), '30', '20', '2')).toBe(true);
});
it('missing everyone role is unknown, never a confident denial or authorization', async () => {
 expect(await discordChannelMember(wire([], []), '30', '20', '2')).toBeUndefined();
});
