import { TelegramApiError, type TelegramCall } from './client.ts';
interface Reply {
  chatId: string; text: string; valid(): boolean; sent?(result: unknown): Promise<void>;
  expiresAt: number; nextAt: number; attempts: number;
}
/** Bounded ephemeral replies, independent of update processing and durable task effects. */
export class TelegramReplies {
  private queue: Reply[] = [];
  private chatNext = new Map<string, number>();
  private botNext = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private active?: Promise<void>;
  private controller = new AbortController();
  dropped = 0;
  constructor(private readonly call: TelegramCall, private readonly now: () => number = Date.now) {}
  enqueue(chatId: string, text: string, valid: () => boolean, sent?: Reply['sent']): boolean {
    this.prune();
    if (this.controller.signal.aborted || text.length > 4096 || this.queue.length >= 100 || this.queue.filter(reply => reply.chatId === chatId).length >= 10) {
      this.dropped++; return false;
    }
    this.queue.push({ chatId, text, valid, ...(sent ? { sent } : {}), expiresAt: this.now() + 120_000, nextAt: this.now(), attempts: 0 });
    this.schedule(); return true;
  }
  prune(): void {
    const now = this.now();
    this.queue = this.queue.filter(reply => reply.expiresAt > now && reply.valid());
    for (const [chat, next] of this.chatNext) if (next <= now) this.chatNext.delete(chat);
  }
  private schedule(): void {
    if (this.timer || this.active || this.controller.signal.aborted) return;
    this.prune(); if (!this.queue.length) return;
    const at = Math.min(...this.queue.map(reply => Math.max(reply.nextAt, this.botNext, this.chatNext.get(reply.chatId) ?? 0)));
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.active = this.send().finally(() => { this.active = undefined; this.schedule(); });
    }, Math.max(0, Math.min(60_000, at - this.now())));
    this.timer.unref();
  }
  private async send(): Promise<void> {
    this.prune(); const now = this.now();
    const index = this.queue.findIndex(reply => reply.nextAt <= now && this.botNext <= now && (this.chatNext.get(reply.chatId) ?? 0) <= now);
    if (index < 0) return;
    const reply = this.queue.splice(index, 1)[0]!;
    if (!reply.valid() || this.controller.signal.aborted) return;
    this.botNext = now + 100; this.chatNext.set(reply.chatId, now + 1000); reply.attempts++;
    try {
      const result = await this.call('sendMessage', { chat_id: reply.chatId, text: reply.text, parse_mode: 'HTML', link_preview_options: { is_disabled: true } }, this.controller.signal);
      // A failed correlation write must never retry the delivered response.
      if (reply.valid()) await reply.sent?.(result).catch(() => undefined);
    } catch (error) {
      const retryable = error instanceof TelegramApiError && (error.code === 'network' || error.status === 429 || (error.status ?? 0) >= 500);
      if (!retryable || reply.attempts >= 3 || this.controller.signal.aborted || !reply.valid()) return;
      reply.nextAt = this.now() + (error.status === 429 ? (error.retryAfter ?? 5) * 1000 : 1000 * reply.attempts);
      if (error.status === 429) this.botNext = Math.max(this.botNext, reply.nextAt);
      if (reply.nextAt < reply.expiresAt && this.queue.length < 100 && this.queue.filter(item => item.chatId === reply.chatId).length < 10) this.queue.push(reply);
      else this.dropped++;
    }
  }
  async stop(): Promise<void> {
    this.controller.abort(); if (this.timer) clearTimeout(this.timer); this.timer = undefined; this.queue = [];
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
