import { describe, expect, it } from 'vitest';
import { Pairings } from './pairing.ts';
import type { TelegramMessage } from './protocol.ts';
const input = { receiverId: 'receiver', botId: '123', chatId: '456', deliveryRevision: 1 };
function start(link: string, userId = 456): TelegramMessage {
  return { message_id: 1, date: 10, chat: { id: userId, type: 'private' }, from: { id: userId, is_bot: false, first_name: 'Person' },
    text: `/start ${new URL(link).searchParams.get('start')}`, entities: [{ type: 'bot_command', offset: 0, length: 6 }] };
}
describe('Telegram private pairing', () => {
  it('keeps only a hash, accepts the configured private user, never replaces them', () => {
    const pairings = new Pairings(() => 10_000), { session, deepLink } = pairings.create(input, 'test_bot');
    expect(JSON.stringify(pairings.get(session.id))).not.toContain(new URL(deepLink).searchParams.get('start'));
    expect(pairings.accept('123', 'test_bot', start(deepLink, 789))).toBe('wrong_chat');
    expect(pairings.get(session.id)?.candidate).toBeUndefined();
    expect(pairings.accept('123', 'test_bot', start(deepLink))).toBe('candidate');
    expect(pairings.get(session.id)?.candidate?.userId).toBe('456');
    expect(pairings.accept('123', 'test_bot', start(deepLink, 789))).toBe('wrong_chat');
    expect(pairings.get(session.id)?.candidate?.userId).toBe('456');
  });
  it('expires, bounds sessions and invalidates on cancellation', () => {
    let now = 10_000; const pairings = new Pairings(() => now);
    const first = pairings.create(input, 'test_bot');
    pairings.create(input, 'test_bot'); pairings.create(input, 'test_bot');
    expect(() => pairings.create(input, 'test_bot')).toThrow('pairing_limit');
    pairings.cancel(first.session.id);
    expect(pairings.accept('123', 'test_bot', start(first.deepLink))).toBe('ignored');
    now += 300_000;
    expect(pairings.hasBot('123')).toBe(false);
    expect(() => pairings.create(input, 'test_bot')).not.toThrow();
  });
});
it('pairs a group through a private candidate with a fixed comparison code and never replaces the first person', () => {
  const pairings = new Pairings(() => 10_000), { session, deepLink } = pairings.create({ ...input, chatId: '-123' }, 'test_bot');
  expect(pairings.accept('123', 'test_bot', start(deepLink))).toBe('candidate');
  const first = pairings.get(session.id)!.candidate!;
  expect(first.userId).toBe('456'); expect(first.comparisonCode).toMatch(/^[0-9]{6}$/);
  expect(pairings.get(session.id)!.chatId).toBe('-123');
  expect(pairings.accept('123', 'test_bot', start(deepLink, 789))).toBe('ignored');
  expect(pairings.get(session.id)!.candidate).toEqual(first);
  expect(pairings.accept('123', 'test_bot', { ...start(deepLink), chat: { id: -123, type: 'group' } })).toBe('ignored');
});
