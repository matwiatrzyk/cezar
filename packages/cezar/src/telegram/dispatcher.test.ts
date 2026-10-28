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
it('sends confirmation markup only while valid and retains the successful message receipt', async () => {
  vi.useFakeTimers();
  const receipt = { message_id: 77, chat: { id: 123 } }, call = vi.fn().mockResolvedValue(receipt), sent = vi.fn(async () => {});
  const replies = new TelegramReplies(call);
  replies.enqueue('123', 'Preview', () => true, sent, { text: 'Confirm', callback_data: 'a'.repeat(32) });
  await vi.runAllTimersAsync();
  expect(call).toHaveBeenCalledWith('sendMessage', expect.objectContaining({ reply_markup: { inline_keyboard: [[{ text: 'Confirm', callback_data: 'a'.repeat(32) }]] } }), expect.any(AbortSignal));
  expect(sent).toHaveBeenCalledWith(receipt); await replies.stop();
});
it('uses the controller budget shared with webhook deliveries', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const { TelegramSendBudget } = await import('./send-budget.ts');
  const budget = new TelegramSendBudget();
  budget.offer({ id: 'webhook', chat: '123', readyAt: 0, expiresAt: 10_000, valid: () => true });
  expect(budget.take('webhook')).toBe(true);
  const call = vi.fn().mockResolvedValue({}), replies = new TelegramReplies(call, Date.now, budget);
  replies.enqueue('123', 'answer', () => true);
  await vi.advanceTimersByTimeAsync(999); expect(call).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1); expect(call).toHaveBeenCalledTimes(1);
  await replies.stop();
});
it('publishes a reply 429 into the shared budget even when the response expires', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const { TelegramSendBudget } = await import('./send-budget.ts');
  const budget = new TelegramSendBudget(), call = vi.fn().mockRejectedValue(new TelegramApiError('http', 429, 3600));
  const replies = new TelegramReplies(call, Date.now, budget);
  replies.enqueue('123', 'answer', () => true); await vi.advanceTimersByTimeAsync(0);
  budget.offer({ id: 'webhook', chat: '456', readyAt: 0, expiresAt: 7200_000, valid: () => true });
  await vi.advanceTimersByTimeAsync(1000); expect(budget.take('webhook')).toBe(false);
  await replies.stop();
  vi.setSystemTime(3600_000); expect(budget.take('webhook')).toBe(true);
});
it('keeps a retry ahead of later messages in the same chat', async () => {
  vi.useFakeTimers();
  const call = vi.fn().mockRejectedValueOnce(new TelegramApiError('http', 500)).mockResolvedValue({});
  const replies = new TelegramReplies(call);
  replies.enqueue('123', 'first', () => true); replies.enqueue('123', 'second', () => true);
  await vi.runAllTimersAsync();
  expect(call.mock.calls.map(args => args[1].text)).toEqual(['first', 'first', 'second']); await replies.stop();
});
it('does not reserve another transport until an outstanding response has published its cooldown', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const { TelegramSendBudget } = await import('./send-budget.ts');
  const budget = new TelegramSendBudget(); let reject!: (error: Error) => void;
  const call = vi.fn(() => new Promise((_resolve, fail) => { reject = fail; }));
  const replies = new TelegramReplies(call, Date.now, budget);
  replies.enqueue('123', 'first', () => true); await vi.advanceTimersByTimeAsync(0);
  budget.offer({ id: 'webhook', chat: '456', readyAt: 0, expiresAt: 120_000, valid: () => true });
  await vi.advanceTimersByTimeAsync(1000); expect(budget.reserve('webhook')).toBeUndefined();
  reject(new TelegramApiError('http', 429, 60)); await vi.advanceTimersByTimeAsync(0);
  expect(budget.reserve('webhook')).toBeUndefined(); await replies.stop();
});
