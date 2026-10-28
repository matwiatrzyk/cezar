import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { TelegramApiError, type TelegramCall } from './client.ts';
import type { TelegramSendBudget } from './send-budget.ts';
import type { TelegramUpdate } from './protocol.ts';
import type { InboundStateStore, JournalEntry } from './state.ts';

export interface ActionPreview {
  kind: 'cancel' | 'continue'; receiverId: string; chatId: string; userId: string; runId: string;
  /** Captures the grant generations and task/configuration fingerprint at preview time. */
  valid(): boolean;
  responseValid?(): boolean;
  execute(check: () => string | undefined): Promise<boolean>;
}
interface Pending extends ActionPreview { id: string; expiresAt: number; messageId?: number }
const receipt = z.object({ message_id: z.number().int().positive().safe(), chat: z.object({ id: z.number().int().safe() }) });

/** Ephemeral capabilities; durable intent lives in the inbound journal, never in callback_data. */
export class TelegramActions {
  private readonly pending = new Map<string, Pending>();
  constructor(private readonly deps: {
    budget?: TelegramSendBudget; botId: string; state: InboundStateStore; call: TelegramCall; now?: () => number;
    reply(chatId: string, text: string, valid: () => boolean): void;
  }) {}
  private now(): number { return this.deps.now?.() ?? Date.now(); }
  private valid(action: Pending): boolean {
    try { return action.expiresAt > this.now() && action.valid(); } catch { return false; }
  }
  prune(): void { for (const [id, action] of this.pending) if (!this.valid(action)) this.pending.delete(id); }
  clear(): void { this.pending.clear(); }
  create(preview: ActionPreview): { data: string; valid(): boolean; sent(raw: unknown): Promise<void> } | undefined {
    this.prune();
    if (!preview.valid() || this.pending.size >= 100 || [...this.pending.values()].filter(row => row.userId === preview.userId).length >= 5) return;
    const action: Pending = { ...preview, id: randomBytes(24).toString('base64url'), expiresAt: this.now() + 120_000 };
    this.pending.set(action.id, action);
    return { data: action.id, valid: () => this.pending.get(action.id) === action && this.valid(action), sent: async raw => {
      const result = receipt.safeParse(raw);
      if (!result.success || String(result.data.chat.id) !== action.chatId || !this.valid(action)) { this.pending.delete(action.id); return; }
      // A retried send can produce a second message; only the acknowledged receipt authorizes clicks.
      action.messageId = result.data.message_id;
    } };
  }
  private async call(method: 'answerCallbackQuery' | 'editMessageReplyMarkup', body: object): Promise<void> {
    if (this.deps.budget?.methodReady(method) === false) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([this.deps.call(method, body, controller.signal), new Promise<void>(resolve => {
        timer = setTimeout(() => { controller.abort(); resolve(); }, 1500);
      })]);
    } catch (error) {
      if (error instanceof TelegramApiError && error.status === 429) this.deps.budget?.cooldownMethod(method, this.now() + (error.retryAfter ?? 5) * 1000);
      // Telegram UI cleanup cannot authorize or undo a task action.
    }
    finally { if (timer) clearTimeout(timer); }
  }
  async process(update: TelegramUpdate, epoch: string): Promise<void> {
    const callback = update.callback_query;
    if (!callback) return;
    const action = callback.data ? this.pending.get(callback.data) : undefined;
    const matches = action && !callback.from.is_bot && callback.message && !callback.message.chat.is_forum
      && String(callback.from.id) === action.userId && String(callback.message.chat.id) === action.chatId
      && callback.message.message_id === action.messageId && this.valid(action);
    // Consume synchronously, before acknowledging or writing: different update IDs must not race.
    if (matches) this.pending.delete(action.id);
    const acknowledgment = this.call('answerCallbackQuery', { callback_query_id: callback.id,
      text: matches ? 'Sprawdzam potwierdzenie.' : 'Potwierdzenie jest niedostępne. Wyślij polecenie ponownie.' });
    try {
      const { state } = this.deps;
      if (state.duplicate(epoch, update.update_id)) return;
      if (!matches) {
        await state.finish(epoch, update.update_id, { id: randomUUID(), epoch, updateId: update.update_id, at: this.now(), botId: this.deps.botId,
          kind: 'rejection_summary', state: 'rejected', reason: 'unauthorized', count: 1 }); return;
      }
      const entry: JournalEntry = { id: randomUUID(), actionId: action.id, epoch, updateId: update.update_id, at: this.now(),
        botId: this.deps.botId, receiverId: action.receiverId, chatId: action.chatId, userId: action.userId,
        runId: action.runId, kind: action.kind, state: 'claimed', reason: 'pending' };
      if (!await state.claim(entry)) return;
      let outcome: JournalEntry['state'] = 'rejected', reason = 'action_changed';
      try {
        if (this.valid(action)) {
          const accepted = await action.execute(() => this.valid(action) ? undefined : 'action_changed');
          outcome = accepted ? 'accepted' : 'rejected'; reason = accepted ? 'executed' : 'action_refused';
        }
      } catch { outcome = 'uncertain'; reason = 'action_uncertain'; }
      await state.finish(epoch, update.update_id, { ...entry, state: outcome, reason });
      this.deps.reply(action.chatId, outcome === 'accepted' ? 'Wykonano.' : outcome === 'uncertain'
        ? 'Wynik jest niepewny. Sprawdź stan zadania w cockpicie przed ponowieniem.' : 'Nie wykonano. Sprawdź stan i uprawnienia w cockpicie.', () => {
          try { return (action.responseValid ?? action.valid)(); } catch { return false; }
        });
    } finally {
      await acknowledgment;
      if (matches) await this.call('editMessageReplyMarkup', { chat_id: action.chatId, message_id: action.messageId, reply_markup: { inline_keyboard: [] } });
    }
  }
}
