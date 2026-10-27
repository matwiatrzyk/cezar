import { expect, it } from 'vitest';
import { ConnectCache } from './connect-cache.ts';
const bot = { username: 'test_bot', name: 'Test' };
it('retains only matching chat metadata for three configuration sessions and expires it', () => {
  let now = 0; const cache = new ConnectCache(bot, () => now);
  expect(cache.read('cezarCode001x').match).toBeUndefined();
  cache.capture({ message_id: 1, date: 0, chat: { id: 456, type: 'private' }, from: { id: 456, is_bot: false, first_name: 'Ada' }, text: '/start cezarCode001x' });
  expect(cache.read('cezarCode001x').match).toEqual({ id: '456', type: 'private', title: 'Ada' });
  expect(cache.read('cezarCode002x').match).toBeUndefined(); cache.read('cezarCode003x');
  expect(() => cache.read('cezarCode004x')).toThrow('connect_limit');
  now = 300_001; expect(cache.read('cezarCode001x').match).toBeUndefined();
});
it('does not match a code forwarded from another user or addressed to another bot', () => {
  const cache = new ConnectCache(bot); cache.read('cezarCode001x');
  const message = { message_id: 1, date: Math.floor(Date.now() / 1000), chat: { id: 456, type: 'private' as const }, from: { id: 456, is_bot: false }, text: '/start@other cezarCode001x' };
  cache.capture(message); expect(cache.read('cezarCode001x').match).toBeUndefined();
  cache.capture({ ...message, text: '/start cezarCode001x', forward_origin: {} });
  expect(cache.read('cezarCode001x').match).toBeUndefined();
});
