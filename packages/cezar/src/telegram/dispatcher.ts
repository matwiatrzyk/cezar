import { randomUUID } from 'node:crypto';
import { TelegramSendBudget } from './send-budget.ts';
import { TelegramApiError, type TelegramCall } from './client.ts';
export { renderTelegramSourceOutcome, renderTelegramTaskReply } from '../webhooks/telegram.ts';
export type { TelegramTaskReply } from '../webhooks/telegram.ts';
export interface ConfirmationButton { text: string; callback_data: string }
interface Reply {
  id: string; button?: ConfirmationButton;
  chatId: string; text: string; valid(): boolean; sent?(result: unknown): Promise<void>;
  expiresAt: number; nextAt: number; attempts: number;
}
/** Bounded ephemeral replies, independent of update processing and durable task effects. */
export class TelegramReplies {
  private queue: Reply[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private active?: Promise<void>;
  private controller = new AbortController();
  dropped = 0;
  constructor(private readonly call: TelegramCall, private readonly now: () => number = Date.now, private readonly budget = new TelegramSendBudget(now)) {}
  enqueue(chatId: string, text: string, valid: () => boolean, sent?: Reply['sent'], button?: ConfirmationButton): boolean {
    this.prune();
    if (this.controller.signal.aborted || text.length > 4096 || this.queue.length >= 100 || this.queue.filter(reply => reply.chatId === chatId).length >= 10) {
      this.dropped++; return false;
    }
    const reply: Reply = { id: `reply:${randomUUID()}`, chatId, text, valid, ...(button ? { button } : {}), ...(sent ? { sent } : {}), expiresAt: this.now() + 120_000, nextAt: this.now(), attempts: 0 };
    if (!this.offer(reply)) { this.dropped++; return false; }
    this.queue.push(reply);
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    this.schedule(); return true;
  }
  private offer(reply: Reply, firstInChat = false): boolean {
    return this.budget.offer({ id: reply.id, chat: reply.chatId, readyAt: reply.nextAt, expiresAt: reply.expiresAt, valid: reply.valid }, firstInChat);
  }
  prune(): void {
    const now = this.now();
    this.queue = this.queue.filter(reply => {
      if (reply.expiresAt > now && reply.valid()) return true;
      this.budget.cancel(reply.id); return false;
    });
  }
  private schedule(): void {
    if (this.timer || this.active || this.controller.signal.aborted) return;
    this.prune(); if (!this.queue.length) return;
    const winner = this.budget.winner();
    const at = this.queue.some(reply => reply.id === winner) ? this.now() : this.budget.nextCheck();
    // Keep a short cap so a manually advanced/test clock or wall-clock
    // correction cannot strand a reply behind a stale deadline.
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.active = this.send().finally(() => { this.active = undefined; this.schedule(); });
    }, Math.max(0, Math.min(100, at - this.now())));
    this.timer.unref();
  }
  private async send(): Promise<void> {
    this.prune();
    const winner = this.budget.winner(), index = this.queue.findIndex(reply => reply.id === winner);
    if (index < 0) return;
    const reservation = this.budget.reserve(this.queue[index]!.id); if (!reservation) return;
    const reply = this.queue.splice(index, 1)[0]!;
    if (!reply.valid() || this.controller.signal.aborted) {
      // The ticket was removed from the local queue before this final check.
      // Cancel it too, or a shared budget retains an orphan until its TTL.
      this.budget.cancel(reply.id); reservation.release(); return;
    }
    reply.attempts++; reservation.sent();
    try {
      const result = await this.call('sendMessage', { chat_id: reply.chatId, text: reply.text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...(reply.button ? { reply_markup: { inline_keyboard: [[reply.button]] } } : {}) }, this.controller.signal);
      // A failed correlation write must never retry the delivered response.
      if (reply.valid()) await reply.sent?.(result).catch(() => undefined);
    } catch (error) {
      if (error instanceof TelegramApiError && error.status === 429) this.budget.cooldown(this.now() + (error.retryAfter ?? 5) * 1000);
      const retryable = error instanceof TelegramApiError && (error.code === 'network' || error.status === 429 || (error.status ?? 0) >= 500);
      if (!retryable || reply.attempts >= 3 || this.controller.signal.aborted || !reply.valid()) return;
      reply.nextAt = this.now() + (error.status === 429 ? (error.retryAfter ?? 5) * 1000 : 1000 * reply.attempts);
      if (reply.nextAt < reply.expiresAt && this.queue.length < 100 && this.queue.filter(item => item.chatId === reply.chatId).length < 10 && this.offer(reply, true)) this.queue.push(reply);
      else this.dropped++;
    } finally { reservation.release(); }
  }
  async stop(): Promise<void> {
    this.controller.abort(); if (this.timer) clearTimeout(this.timer); this.timer = undefined;
    for (const reply of this.queue) this.budget.cancel(reply.id);
    this.queue = [];
    await this.active;
  }
}

/** Bounded minute buckets; saturation refuses new keys rather than evicting active limits. */
export class CommandLimiter {
  private users = new Map<string, { until: number; count: number; seen: number }>();
  private bot = { until: 0, count: 0 };
  constructor(private readonly now: () => number = Date.now) {}
  accept(userId: string): boolean {
    const now = this.now();
    for (const [key, value] of this.users) if (value.seen < now - 600_000) this.users.delete(key);
    if (this.bot.until <= now) this.bot = { until: now + 60_000, count: 0 };
    let user = this.users.get(userId);
    if (!user && this.users.size >= 1000) return false;
    if (!user || user.until <= now) { user = { until: now + 60_000, count: 0, seen: now }; this.users.set(userId, user); }
    user.seen = now;
    if (this.bot.count >= 100 || user.count >= 20) return false;
    this.bot.count++; user.count++; return true;
  }
}
