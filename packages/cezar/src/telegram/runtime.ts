import type { TelegramSendBudget } from './send-budget.ts';
import { TelegramActions } from './actions.ts';
import { processGroupEvent } from './group-events.ts';
import type { BotLease } from './ownership.ts';
import type { InboundStateStore } from './state.ts';
import type { Pairings } from './pairing.ts';
import type { TelegramCall } from './client.ts';
import { TelegramConversation, type ConversationDependencies } from './conversation.ts';
import { TelegramReplies } from './dispatcher.ts';
import { TelegramPoller, type PollerHealth } from './poller.ts';
import { registerConnectOwner } from './connect-arbiter.ts';
import { ConnectCache } from './connect-cache.ts';
import { authorize } from './authorization.ts';
import { z } from 'zod';
interface RuntimeDependencies extends Pick<ConversationDependencies, 'receiver' | 'context' | 'deliver' | 'prepareControl' | 'episode' | 'now'> {
  budget?: TelegramSendBudget; botId: string; projectRoot: string; state: InboundStateStore; lease: BotLease; pairings: Pairings;
  call: TelegramCall; enabled?(): boolean; assertCredentials(): Promise<void>; changed(): void; dryRun?: boolean;
}
const identity = z.object({ id: z.number().int().positive().safe(), username: z.string().regex(/^[A-Za-z0-9_]{1,64}$/), first_name: z.string().max(256).optional() });
export class TelegramBotRuntime {
  private poller?: TelegramPoller;
  private actions?: TelegramActions;
  private replies?: TelegramReplies;
  private unregister?: () => void;
  private timer?: ReturnType<typeof setInterval>;
  private closing?: Promise<void>;
  private changes = new Set<Promise<unknown>>();
  private closed = false;
  private wrongChatNotices = new Map<string, number>();
  private startup?: Promise<void>;
  private readonly startupAbort = new AbortController();
  constructor(private readonly deps: RuntimeDependencies) {}
  health(): PollerHealth & { droppedReplies: number } { return { ...(this.poller?.health() ?? { state: 'stopped' as const }), droppedReplies: this.replies?.dropped ?? 0 }; }
  private needed(): boolean {
    if (this.closed || this.deps.enabled?.() === false) return false;
    const { state, pairings, botId, receiver } = this.deps;
    if (pairings.hasBot(botId)) return true;
    const snapshot = state.snapshot();
    return snapshot.grants.some(grant => authorize(snapshot, grant.chatId, grant.userId, receiver));
  }
  start(): Promise<void> {
    if (this.closed) return Promise.resolve();
    return this.startup ??= this.initialize();
  }
  private async initialize(): Promise<void> {
    try {
      const { lease, state, pairings, call, botId } = this.deps;
      await lease.validate(state.snapshot().binding);
      await this.deps.assertCredentials();
      if (this.closed) return;
      const me = identity.parse(await call('getMe', {}, this.startupAbort.signal));
      if (String(me.id) !== botId) throw new Error('bot_identity_changed');
      if (this.closed) return;
      const cache = new ConnectCache({ username: me.username, name: me.first_name ?? me.username }, this.deps.now);
      this.replies = new TelegramReplies(call, this.deps.now, this.deps.budget);
      this.actions = new TelegramActions({ budget: this.deps.budget, botId, state, call, now: this.deps.now, reply: (chat, text, valid) => { this.replies!.enqueue(chat, text, valid); } });
      const conversation = new TelegramConversation({ ...this.deps, active: () => !this.closed && this.deps.enabled?.() !== false, username: me.username, actions: this.actions,
        reply: (chat, text, valid, sent, button) => { this.replies!.enqueue(chat, text, valid, sent, button); } });
      this.poller = new TelegramPoller({ call, store: state, needed: () => this.needed(), now: this.deps.now,
        assertCredentials: this.deps.assertCredentials, allowedUpdates: ['message', 'callback_query', 'my_chat_member'],
        process: async (update, epoch) => {
          lease.assertOwner();
          if (this.closed || this.deps.enabled?.() === false) return;
          if (update.callback_query) { await this.actions!.process(update, epoch); this.deps.changed(); return; }
          if (await processGroupEvent(state, update, epoch)) { this.deps.changed(); return; }
          if (update.message && cache.capture(update.message)) { await state.finish(epoch, update.update_id); return; }
          const paired = update.message ? pairings.accept(botId, me.username, update.message) : 'ignored';
          if (paired !== 'ignored') {
            await state.finish(epoch, update.update_id);
            if (paired === 'wrong_chat') {
              const now = this.deps.now?.() ?? Date.now(), chatId = String(update.message!.chat.id);
              for (const [id, until] of this.wrongChatNotices) if (until <= now) this.wrongChatNotices.delete(id);
              if (!this.wrongChatNotices.has(chatId) && this.wrongChatNotices.size < 1000) {
                this.wrongChatNotices.set(chatId, now + 60_000);
                this.replies!.enqueue(chatId, 'This pairing link belongs to another chat. Open it from the chat configured in the cezar cockpit.', () => !this.closed);
              }
            }
            if (paired === 'candidate' && update.message) {
              const message = update.message, code = pairings.comparisonCode(botId, me.username, message);
              if (code) {
                const noticeKey = `comparison:${message.from!.id}:${code}`, now = this.deps.now?.() ?? Date.now();
                for (const [key, until] of this.wrongChatNotices) if (until <= now) this.wrongChatNotices.delete(key);
                if (!this.wrongChatNotices.has(noticeKey) && this.wrongChatNotices.size < 1000) {
                  this.wrongChatNotices.set(noticeKey, now + 60_000);
                  this.replies!.enqueue(String(message.chat.id), `Comparison code: ${code}. Compare it with the code in the cezar cockpit before approving group access.`,
                    () => !this.closed && pairings.comparisonCode(botId, me.username, message) === code);
                }
              }
            }
            this.deps.changed(); return;
          }
          await conversation.process(update, epoch); this.deps.changed();
        },
        onHealth: health => {
          this.deps.changed();
          if (['conflict', 'blocked', 'credentials-unavailable'].includes(health.state)) {
            const change = state.change(draft => { for (const binding of draft.receivers) binding.enabled = false; });
            this.changes.add(change); void change.catch(() => undefined).finally(() => this.changes.delete(change));
          }
        },
      });
      this.unregister = registerConnectOwner(botId, this.deps.projectRoot, this.deps.dryRun === true, lease, async code => cache.read(code));
      this.timer = setInterval(() => {
        pairings.prune(); this.replies?.prune(); this.actions?.prune();
        if (!this.needed()) void this.stop().catch(() => undefined);
      }, 1000);
      this.timer.unref(); this.poller.start();
    } catch (error) { if (!this.closed) throw error; }
  }
  /** A timed-out shutdown retains the lease until every effect and writer has settled. */
  async stop(): Promise<boolean> {
    if (!this.closing) {
      this.closed = true;
      this.actions?.clear();
      this.startupAbort.abort();
      if (this.timer) clearInterval(this.timer);
      this.closing = (async () => {
        await this.startup?.catch(() => undefined);
        await Promise.all([this.poller?.stop(), this.replies?.stop()]);
        await Promise.allSettled([...this.changes]);
        await this.deps.state.drain();
        this.unregister?.();
      })();
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([this.closing.then(() => true), new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), 5000); })]);
    } finally { if (timer) clearTimeout(timer); }
  }
}
