import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommandLimiter, TelegramReplies } from './dispatcher.ts';
import { TelegramApiError } from './client.ts';
afterEach(() => vi.useRealTimers());
describe('Telegram bounded replies and command limits', () => {
  it('rechecks grant before send and drops revoked queued replies', async () => {
    vi.useFakeTimers(); const call = vi.fn().mockResolvedValue({}); let valid = true;
    const replies = new TelegramReplies(call);
    replies.enqueue('123', 'secret data', () => valid); valid = false;
    await vi.runAllTimersAsync(); expect(call).not.toHaveBeenCalled(); await replies.stop();
  });
  it('bounds the per-chat queue, expires a long 429, and never retries the task action', async () => {
    vi.useFakeTimers();
    const call = vi.fn().mockRejectedValue(new TelegramApiError('http', 429, 3600));
    const replies = new TelegramReplies(call);
    for (let index = 0; index < 10; index++) expect(replies.enqueue('123', 'reply', () => true)).toBe(true);
    expect(replies.enqueue('123', 'overflow', () => true)).toBe(false);
    await vi.advanceTimersByTimeAsync(0); expect(call).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3600_000); expect(call).toHaveBeenCalledTimes(1);
    await replies.stop();
  });
  it('does not retry a successful send because correlation storage failed', async () => {
    vi.useFakeTimers(); const call = vi.fn().mockResolvedValue({}); const replies = new TelegramReplies(call);
    replies.enqueue('123', 'reply', () => true, async () => { throw new Error('storage'); });
    await vi.runAllTimersAsync(); expect(call).toHaveBeenCalledTimes(1); await replies.stop();
  });
  it('keeps no more than three network attempts', async () => {
    vi.useFakeTimers(); const call = vi.fn().mockRejectedValue(new TelegramApiError('network')); const replies = new TelegramReplies(call);
    replies.enqueue('123', 'reply', () => true); await vi.runAllTimersAsync(); expect(call).toHaveBeenCalledTimes(3); await replies.stop();
  });
  it('bounds per-user and bot command rates independently', () => {
    let now = 0; const limiter = new CommandLimiter(() => now);
    for (let i = 0; i < 20; i++) expect(limiter.accept('user')).toBe(true);
    expect(limiter.accept('user')).toBe(false);
    for (let i = 0; i < 80; i++) expect(limiter.accept(`other-${i}`)).toBe(true);
    expect(limiter.accept('fresh')).toBe(false);
    now = 60_000; expect(limiter.accept('user')).toBe(true);
  });
});
