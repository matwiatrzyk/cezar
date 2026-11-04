import { describe, expect, it } from 'vitest';
import { GroupMembership } from '../../authorization.ts';
import { slackError, type SlackWire } from './client.ts';
import { slackTransport } from './transport.ts';

const group = 'group:T1:U1:G1';
const dm = 'private:T1:U1:D1';
function fixture(info: Record<string, unknown>, members: (body: Record<string, unknown>) => unknown = () => ({ members: ['U1', 'U2'] })) {
 const wire: SlackWire = {
  socket() { throw new Error('No socket allowed'); },
  async call(method, body) {
   if (method === 'auth.test') return { team_id: 'T1', user_id: 'U1' };
   if (method === 'conversations.info') return { channel: { id: body.channel, ...info } };
   if (method === 'conversations.members') return members(body);
   throw new Error('Unexpected API');
  },
 };
 return slackTransport(wire);
}

describe('Slack production membership evidence', () => {
 it.each(['U2', 'T1:U1', 'U1'])('keeps omitted MPIM membership unknown for %s even with members available', async user => {
  const transport = fixture({ is_im: false, is_mpim: true });
  expect(await transport.isMember(group, user)).toBeUndefined();
  expect(await transport.inspect(group)).toMatchObject({ kind: 'group', eligible: false });
 });

 it('does not cache missing evidence as a removal or grant membership', async () => {
  const info: Record<string, unknown> = { is_im: false, is_mpim: true };
  const transport = fixture(info);
  const membership = new GroupMembership((id, user) => transport.isMember(id, user));
  expect(await membership.member(group, 'U2')).toBeUndefined();
  info.is_member = true;
  expect(await membership.member(group, 'U2')).toBe(true);
 });

 it.each(['U2', 'U3'])('keeps a missing DM peer unknown for human %s', async user => {
  expect(await fixture({ is_im: true }).isMember(dm, user)).toBeUndefined();
 });
 it('still recognizes the namespaced bot and an explicit DM peer', async () => {
  expect(await fixture({ is_im: true }).isMember(dm, 'T1:U1')).toBe(true);
  expect(await fixture({ is_im: true, user: 'U2' }).isMember(dm, 'U2')).toBe(true);
  expect(await fixture({ is_im: true, user: 'U2' }).isMember(dm, 'U3')).toBe(false);
 });

 it.each([{ is_member: false }, { is_archived: true }])('retains explicit denial %j despite a positive member list', async denial => {
  const transport = fixture({ is_im: false, is_mpim: true, ...denial });
  for (const user of ['U2', 'T1:U1']) expect(await transport.isMember(group, user)).toBe(false);
  expect(await transport.inspect(group)).toMatchObject({ eligible: false });
 });

 it.each(['channel_not_found', 'not_in_channel', 'is_archived'])('retains gone denial: %s', async code => {
  const transport = fixture({ is_im: false, is_member: true }, () => { throw slackError(code); });
  expect(await transport.isMember(group, 'U2')).toBe(false);
 });

 it.each(['network', 'ratelimited', 'invalid_auth'])('keeps %s unknown on later membership pages', async code => {
  const transport = fixture({ is_im: false, is_member: true }, body => {
   if (!body.cursor) return { members: ['U1'], response_metadata: { next_cursor: 'page2' } };
   throw slackError(code);
  });
  expect(await transport.isMember(group, 'U2')).toBeUndefined();
 });

 it.each(['U2', 'T1:U1', 'U1', 'W2'])('finds %s on a later page with native Slack IDs', async user => {
  const transport = fixture({ is_im: false, is_mpim: true, is_member: true }, body => {
   expect(body.channel).toBe('G1');
   expect(body.limit).toBe(200);
   if (!body.cursor) return { members: ['U9'], response_metadata: { next_cursor: 'page2' } };
   expect(body.cursor).toBe('page2');
   return { members: ['U1', 'U2', 'W2'] };
  });
  expect(await transport.isMember(group, user)).toBe(true);
  expect(await transport.isMember(group, 'U3')).toBe(false);
 });

 it('returns unknown on incomplete or malformed pagination', async () => {
  const info = { is_im: false, is_member: true };
  expect(await fixture(info, () => ({ members: [], response_metadata: { next_cursor: 'more' } })).isMember(group, 'U2')).toBeUndefined();
  expect(await fixture(info, () => ({ members: null })).isMember(group, 'U2')).toBeUndefined();
 });

 it('never guesses privacy from missing is_im or accepts a mismatched namespace', async () => {
  const transport = fixture({ is_member: true });
  expect(await transport.isMember(group, 'U2')).toBeUndefined();
  await expect(transport.inspect(group)).rejects.toThrow();
  expect(await fixture({ is_im: false, is_member: true }).isMember('private:T1:U1:G1', 'U2')).toBe(false);
 });
});
