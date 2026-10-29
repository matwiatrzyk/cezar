import type { TelegramSendBudget } from './send-budget.ts';
import { TelegramActions } from './actions.ts';
import { processGroupEvent } from './group-events.ts';
import type { BotLease } from './ownership.ts';
import type { InboundStateStore } from './state.ts';
import type { Pairings } from './pairing.ts';
import { TelegramApiError, type TelegramCall } from './client.ts';
import { NoticeThrottle, TelegramConversation, telegramAccessGrantedText, type ConversationDependencies } from './conversation.ts';
import { renderTelegramSourceOutcome, renderTelegramTaskReply, TelegramReplies } from './dispatcher.ts';
import { TelegramPoller, type PollerHealth } from './poller.ts';
import { registerConnectOwner } from './connect-arbiter.ts';
import { ConnectCache } from './connect-cache.ts';
import { authorize } from './authorization.ts';
import { z } from 'zod';
interface RuntimeDependencies extends Pick<ConversationDependencies, 'receiver' | 'context' | 'deliver' | 'prepareControl' | 'episode' | 'now'> {
  budget?: TelegramSendBudget; botId: string; projectRoot: string; state: InboundStateStore; lease: BotLease; pairings: Pairings;
  call: TelegramCall; enabled?(): boolean; assertCredentials(): Promise<void>; changed(): void; dryRun?: boolean;
}
const commands = [
  { command: 'tasks', description: 'List this project’s tasks' }, { command: 'status', description: 'Show a task’s status' },
  { command: 'reply', description: 'Answer a task that is waiting for you' }, { command: 'cancel', description: 'Cancel a task' },
  { command: 'continue', description: 'Continue a task' }, { command: 'help', description: 'Show what this bot can do' },
];
const identity = z.object({ id: z.number().int().positive().safe(), username: z.string().regex(/^[A-Za-z0-9_]{1,64}$/), first_name: z.string().max(256).optional() });
export class TelegramBotRuntime {
  private poller?: TelegramPoller;
  private actions?: TelegramActions;
  private replies?: TelegramReplies;
  private unregister?: () => void;
  private timer?: ReturnType<typeof setInterval>;
  private closing?: Promise<void>;
  private closed = false;
  private wrongChatNotices = new Map<string, number>();
  private startup?: Promise<void>;
  private readonly startupAbort = new AbortController();
  private username?: string;
  private startupHealth?: PollerHealth;
  private readonly pairingNotices = new NoticeThrottle(() => this.deps.now?.() ?? Date.now());
  constructor(private readonly deps: RuntimeDependencies) {}
  private lostNotices = 0;
  get running(): boolean { return !this.closed; }
  health(): PollerHealth & { droppedReplies: number } {
    return { ...(this.poller?.health() ?? this.startupHealth ?? { state: 'stopped' as const }), droppedReplies: (this.replies?.dropped ?? 0) + this.lostNotices };
  }
  /** Pairing notices share the reply queue, so a busy budget delays them instead of dropping them silently. */
  /** Private approval notice; a group grant names the addressed group command. */
  notifyAccessGranted(userId: string, grantChatId: string): void {
    if (this.username) this.notify(userId, telegramAccessGrantedText(grantChatId, this.username));
  }
  notify(chatId: string, text: string): void {
    if (this.closed) return;
    if (!this.replies) { this.lostNotices++; return; }
    this.replies.enqueue(chatId, text, () => !this.closed);
  }
  private needed(): boolean {
    if (this.closed || this.deps.enabled?.() === false) return false;
    const { state, pairings, botId, receiver } = this.deps;
    if (pairings.hasBot(botId)) return true;
    const snapshot = state.snapshot();
    return snapshot.grants.some(grant => authorize(snapshot, grant.chatId, grant.userId, receiver));
  }
  private sourceValid(run: RunRecord): boolean {
    const source = run.telegramSource;
    if (!source || source.botId !== this.deps.botId || source.projectId !== this.deps.state.snapshot().binding.projectId) return false;
    const snapshot = this.deps.state.snapshot();
    const durable = snapshot.sources.find(row => row.id === source.id && row.runId === run.id);
    const binding = snapshot.receivers.find(row => row.receiverId === source.receiverId && row.chatId === source.chatId);
    const grant = snapshot.grants.find(row => row.id === source.grantId && row.generation === source.grantGeneration
      && row.enableGeneration === source.enableGeneration && row.chatId === source.chatId && row.userId === source.userId);
    return durable?.state === 'finished' && binding?.enabled === true && !!grant && !!authorize(snapshot, source.chatId, source.userId, this.deps.receiver);
  }
  private sourceOutcomeValid(source: NonNullable<RunRecord['telegramSource']>): boolean {
    if (source.botId !== this.deps.botId || source.projectId !== this.deps.state.snapshot().binding.projectId) return false;
    const snapshot = this.deps.state.snapshot();
    const binding = snapshot.receivers.find(row => row.receiverId === source.receiverId && row.chatId === source.chatId);
    const grant = snapshot.grants.find(row => row.id === source.grantId && row.generation === source.grantGeneration
      && row.enableGeneration === source.enableGeneration && row.chatId === source.chatId && row.userId === source.userId);
    return ['policy_refused', 'expired', 'uncertain'].includes(source.state)
      && binding?.enabled === true && !!grant && !!authorize(snapshot, source.chatId, source.userId, this.deps.receiver);
  }
  private async observeSourceOutcome(source: NonNullable<RunRecord['telegramSource']>): Promise<void> {
    if (!this.replies || !this.sourceOutcomeValid(source)) return;
    const phase = `source-outcome:${source.id}`;
    if (this.deps.state.snapshot().correlations.some(row => row.type === phase)) return;
    const accepted = this.replies.deliver(source.chatId, renderTelegramSourceOutcome(source), {
      key: phase, expiresInMs: 7 * 86400_000, valid: () => !this.closed && this.sourceOutcomeValid(source),
      sent: async result => {
        const receipt = z.object({ message_id: z.number().int().positive().safe().optional() }).safeParse(result);
        if (!receipt.success || !receipt.data.message_id) {
          await this.deps.state.change(state => {
            const row = state.sources.find(row => row.id === source.id);
            if (row && ['policy_refused', 'expired', 'uncertain'].includes(row.state)) { row.state = 'delivery_failed'; row.updatedAt = this.deps.now?.() ?? Date.now(); }
          }).catch(() => undefined);
          return;
        }
        const messageId = receipt.data.message_id;
        await this.deps.state.change(state => {
          if (state.correlations.some(row => row.type === phase)) return;
          const binding = state.receivers.find(row => row.receiverId === source.receiverId);
          if (!binding) throw new Error('Telegram receiver disappeared');
          state.correlations.push({ receiverId: source.receiverId, chatId: source.chatId, messageId,
            deliveryRevision: binding.deliveryRevision, bindingGeneration: state.binding.generation, enableGeneration: source.enableGeneration,
            runId: source.runId ?? source.id, type: phase, sequence: 2, episodeId: source.episodeId, continuation: 0, createdAt: this.deps.now?.() ?? Date.now() });
        });
      },
    });
    if (!accepted) this.pendingRunReplies.delete(phase);
  }
  private async observeRun(run: RunRecord): Promise<void> {
    const source = run.telegramSource;
    if (!source || source.botId !== this.deps.botId || !this.replies || !this.sourceValid(run)) return;
    const status = run.archived && !['done', 'review', 'failed', 'cancelled'].includes(run.status) ? 'expired' : run.status;
    if (status === 'queued') return; // The source-creation path already sent the one acknowledgement.
    const terminal = ['done', 'review', 'failed', 'cancelled', 'expired'].includes(status);
    const phase = terminal ? `source-final:${source.id}` : `source-progress:${source.id}:${status}:${run.attentionRequest?.requestId ?? ''}`;
    const snapshot = this.deps.state.snapshot();
    const recorded = snapshot.correlations.find(row => row.runId === run.id && row.type === phase);
    if (recorded) return;
    const revision = `${phase}:${status}:${run.attentionRequest?.requestId ?? ''}`;
    if (this.pendingRunReplies.has(revision)) return;
    const project = await this.deps.context().catch(() => undefined);
    if (!project || !this.sourceValid(run)) return;
    const title = project.store.redactRunText(run.id, run.title);
    const error = run.error ? project.store.redactRunText(run.id, run.error) : undefined;
    const questions = run.attentionRequest?.questions.map(question => ({ ...question,
      question: project.store.redactRunText(run.id, question.question),
      ...(question.options ? { options: question.options.map(option => ({ ...option,
        label: project.store.redactRunText(run.id, option.label),
        ...(option.description ? { description: project.store.redactRunText(run.id, option.description) } : {}) })) } : {}) }));
    const result = run.status === 'done' && run.completionReason ? project.store.redactRunText(run.id, run.completionReason) : undefined;
    const text = renderTelegramTaskReply({ id: run.id, title, status, ...(result ? { result } : {}), ...(error ? { error } : {}), ...(questions ? { questions } : {}),
      ...(run.pullRequestUrl ?? run.referencedPullRequestUrl ?? run.referencedIssueUrl ? { link: run.pullRequestUrl ?? run.referencedPullRequestUrl ?? run.referencedIssueUrl } : {}),
      privateChat: !source.chatId.startsWith('-') });
    this.pendingRunReplies.add(revision);
    const accepted = this.replies.deliver(source.chatId, text, {
      key: terminal ? phase : `source-progress:${source.id}`, expiresInMs: terminal ? 7 * 86400_000 : 30 * 60_000,
      valid: () => !this.closed && this.sourceValid(run),
      sent: async result => {
        const receipt = z.object({ message_id: z.number().int().positive().safe().optional() }).safeParse(result);
        const messageId = receipt.success ? receipt.data.message_id : undefined;
        if (!messageId) {
          await this.deps.state.change(state => {
            const row = state.sources.find(row => row.id === source.id && row.runId === run.id);
            if (row?.state === 'finished') { row.state = 'delivery_failed'; row.updatedAt = this.deps.now?.() ?? Date.now(); }
          }).catch(() => undefined);
          return;
        }
        try {
          await this.deps.state.change(state => {
            if (state.correlations.some(row => row.runId === run.id && row.type === phase)) return;
            const binding = state.receivers.find(row => row.receiverId === source.receiverId);
            if (!binding) throw new Error('Telegram receiver disappeared');
            state.correlations.push({ receiverId: source.receiverId, chatId: source.chatId, messageId, deliveryRevision: binding.deliveryRevision,
              bindingGeneration: state.binding.generation, enableGeneration: source.enableGeneration, runId: run.id, type: phase,
              sequence: terminal ? 2 : 1, episodeId: source.episodeId, continuation: 0,
              ...(run.attentionRequest ? { requestId: run.attentionRequest.requestId, askedAt: run.attentionRequest.askedAt } : {}), createdAt: this.deps.now?.() ?? Date.now() });
          });
        } catch {
          // Telegram accepted the message, but the receipt could not be made durable.
          // Fence this source so a recreated runtime never sends the same terminal notice again.
          await this.deps.state.change(state => {
            const row = state.sources.find(row => row.id === source.id && row.runId === run.id);
            if (row?.state === 'finished') { row.state = 'delivery_failed'; row.updatedAt = this.deps.now?.() ?? Date.now(); }
          }).catch(() => undefined);
        }
      },
      failed: async () => {
        await this.deps.state.change(state => {
          const row = state.sources.find(row => row.id === source.id && row.runId === run.id);
          if (row?.state === 'finished') { row.state = 'delivery_failed'; row.updatedAt = this.deps.now?.() ?? Date.now(); }
        });
      },
    });
    if (!accepted) this.pendingRunReplies.delete(revision);
    else queueMicrotask(() => this.pendingRunReplies.delete(revision));
  }
  private async ensureRunObserver(): Promise<void> {
    if (this.unregisterRuns || this.closed || !this.deps.state.snapshot().sources.some(source => source.runId || ['policy_refused', 'expired', 'uncertain'].includes(source.state))) return;
    for (const source of this.deps.state.snapshot().sources) {
      if (['policy_refused', 'expired', 'uncertain'].includes(source.state)) void this.observeSourceOutcome(source).catch(() => undefined);
    }
    const project = await this.deps.context().catch(() => undefined);
    if (!project || this.unregisterRuns || this.closed) return;
    const listener = (run: RunRecord) => {
      void this.observeRun(run).catch(() => undefined);
      if (run.telegramSource) void this.observeSourceOutcome(run.telegramSource).catch(() => undefined);
    };
    project.store.on('run', listener); this.unregisterRuns = () => project.store.off('run', listener);
    for (const run of project.store.listRuns()) {
      void this.observeRun(run).catch(() => undefined);
      if (run.telegramSource) void this.observeSourceOutcome(run.telegramSource).catch(() => undefined);
    }
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
      this.username = me.username;
      // Best effort: the command menu is a convenience, never a reason to stop polling.
      void call('setMyCommands', { commands }, this.startupAbort.signal).catch(() => undefined);
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
              if (this.pairingNotices.allow(`pairing:${message.from!.id}`)) this.notify(String(message.chat.id), 'Pairing request received. Waiting for approval in cezar.');
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
          if (['conflict', 'credentials-unavailable', 'blocked'].includes(health.state)) {
            void this.deps.state.change(snapshot => { snapshot.fatalStop = health.state as 'conflict' | 'credentials-unavailable' | 'blocked'; }).catch(() => undefined);
          }
          this.deps.changed();
        },
      });
      this.unregister = registerConnectOwner(botId, this.deps.projectRoot, this.deps.dryRun === true, lease, async code => cache.read(code));
      this.timer = setInterval(() => {
        pairings.prune(); this.replies?.prune(); this.actions?.prune();
        if (!this.needed()) void this.stop().catch(() => undefined);
      }, 1000);
      this.timer.unref(); this.poller.start();
    } catch (error) {
      if (this.closed) return;
      const state = error instanceof TelegramApiError && error.status === 401 ? 'credentials-unavailable'
        : error instanceof TelegramApiError && error.status === 409 ? 'conflict'
        : error instanceof TelegramApiError ? 'backoff' : 'blocked';
      this.startupHealth = { state };
      if (state === 'conflict' || state === 'credentials-unavailable' || state === 'blocked')
        void this.deps.state.change(snapshot => { snapshot.fatalStop = state; }).catch(() => undefined);
      this.deps.changed();
    }
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
