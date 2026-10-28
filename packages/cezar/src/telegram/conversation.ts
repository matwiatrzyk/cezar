import { TelegramControlRefusal, type PreparedControl } from './controls.ts';
import type { TelegramActions } from './actions.ts';
import type { ConfirmationButton } from './dispatcher.ts';
import type { PrivateReceiver } from '../webhooks/endpoints.ts';
import type { ProjectContext } from '../server/project-context.ts';
import type { RunRecord } from '../runs/store.ts';
import type { deliverUserMessage } from '../server/run-messages.ts';
import type { InboundStateStore } from './state.ts';
import { eligibleText, parseCommand, resolveTask, type TelegramUpdate } from './protocol.ts';
import { randomUUID } from 'node:crypto';
import { authorize, correlationCurrent, grantFresh } from './authorization.ts';
import { CommandLimiter } from './dispatcher.ts';
import type { Correlation, InboundGrant, JournalEntry } from './state.ts';
import { runLifecycleSnapshot } from '../runs/lifecycle.ts';
import { formatTelegramText } from '../webhooks/telegram.ts';
import { z } from 'zod';
export interface ConversationDependencies {
  botId: string; username: string; state: InboundStateStore;
  receiver(id: string): PrivateReceiver | undefined;
  context(): Promise<ProjectContext>;
  deliver(project: ProjectContext, run: RunRecord, text: string, check: () => string | undefined): ReturnType<typeof deliverUserMessage>;
  prepareControl?(project: ProjectContext, run: RunRecord, kind: 'cancel' | 'continue', text: string): Promise<PreparedControl | undefined>;
  actions?: TelegramActions;
  episode(runId: string): string | undefined;
  reply(chatId: string, text: string, valid: () => boolean, sent?: (result: unknown) => Promise<void>, button?: ConfirmationButton): void;
  now?: () => number;
  active?(): boolean;
}
const HELP = '/tasks — list recent tasks; /status <task> — show task status; /reply <task> <text> — answer a task. You can also Reply to a bot notification. /cancel <task> and /continue <task> [text] require separate permission and confirmation. Plain-text questions are shown in the cockpit; Reply to the bot message to answer them.';
const shortId = (id: string) => id.slice(0, 8);
const statusLabel: Record<string, string> = { queued: 'Queued', running: 'Running', waiting: 'Waiting for your answer', done: 'Completed', failed: 'Failed', cancelled: 'Cancelled', review: 'Ready for review' };
const readableStatus = (status: string): string => statusLabel[status] ?? 'Status unavailable';
const receiptSchema = z.object({ message_id: z.number().int().positive().safe(), chat: z.object({ id: z.number().int().safe() }) });

export class TelegramConversation {
  private readonly limiter: CommandLimiter;
  private readonly notices = new Map<string, number>();
  private readonly now: () => number;
  constructor(private readonly deps: ConversationDependencies) {
    this.now = deps.now ?? Date.now; this.limiter = new CommandLimiter(this.now);
  }
  private currentGrant(chatId: string, userId: string): InboundGrant | undefined {
    if (this.deps.active?.() === false) return undefined;
    this.deps.state.assertReady();
    return authorize(this.deps.state.snapshot(), chatId, userId, this.deps.receiver);
  }
  private valid(grant: InboundGrant): boolean {
    try {
      const current = this.currentGrant(grant.chatId, grant.userId);
      return current?.id === grant.id && current.generation === grant.generation && current.enableGeneration === grant.enableGeneration;
    } catch { return false; }
  }
  private say(chatId: string, text: string, valid: () => boolean, throttled = false): void {
    if (throttled) {
      const now = this.now();
      for (const [key, until] of this.notices) if (until <= now) this.notices.delete(key);
      if (this.notices.has(chatId) || this.notices.size >= 1000) return;
      this.notices.set(chatId, now + 60_000);
    }
    this.deps.reply(chatId, formatTelegramText(text), valid);
  }
  async process(update: TelegramUpdate, epoch: string): Promise<void> {
    const { state } = this.deps;
    if (state.duplicate(epoch, update.update_id)) return;
    const message = update.message;
    if (!message || !eligibleText(message, true)) { await state.finish(epoch, update.update_id); return; }
    const command = parseCommand(message, this.deps.username);
    if (command.kind === 'ignore') { await state.finish(epoch, update.update_id); return; }
    if (message.chat.type !== 'private') {
      const token = message.text!.slice(0, message.entities?.find(entity => entity.type === 'bot_command' && entity.offset === 0)?.length ?? 0);
      const addressed = token.toLowerCase().endsWith(`@${this.deps.username.toLowerCase()}`);
      if (command.kind !== 'text' ? !addressed : !message.reply_to_message) { await state.finish(epoch, update.update_id); return; }
    }
    const chatId = String(message.chat.id), userId = String(message.from!.id);
    const grant = this.currentGrant(chatId, userId);
    const entry: JournalEntry = { id: randomUUID(), epoch, updateId: update.update_id, at: this.now(), botId: this.deps.botId, chatId, userId,
      ...(grant ? { receiverId: grant.receiverId } : {}), kind: command.kind === 'command' && ['tasks', 'status', 'reply', 'cancel', 'continue'].includes(command.name)
        ? command.name as JournalEntry['kind'] : command.kind === 'text' && message.reply_to_message ? 'answer' : 'unknown_command',
      state: 'rejected', reason: 'unsupported' };
    const finish = async (result: JournalEntry['state'], reason: string, text?: string, throttled = false) => {
      await state.finish(epoch, update.update_id, { ...entry, state: result, reason });
      if (text) this.say(chatId, text, grant ? () => this.valid(grant) : () => true, throttled);
    };
    if (!grant) { await finish('rejected', 'unauthorized', 'To control tasks, start pairing in the cezar cockpit.', true); return; }
    if (!this.limiter.accept(userId)) { await finish('rejected', 'rate_limited', 'Too many commands. Try again in a minute.', true); return; }
    if (!grantFresh(state.snapshot(), grant, message.date, this.now())) {
      await finish('rejected', 'expired', 'This message is too old or predates enabled access, so it was not delivered. Check /status <task>.', true); return;
    }
    const contentLength = command.kind === 'command' && ['reply', 'continue'].includes(command.name)
      ? (command.args.match(/^\S+(?:\s+([\s\S]*))?$/)?.[1] ?? '').length : message.text!.length;
    if (contentLength > 4000) { await finish('rejected', 'too_long', 'Message is too long (maximum 4,000 characters).'); return; }
    if (command.kind === 'unknown' || (command.kind === 'text' && !message.reply_to_message)
      || (command.kind === 'command' && !['tasks', 'status', 'reply', 'cancel', 'continue'].includes(command.name))) {
      await finish('rejected', 'unsupported', HELP); return;
    }
    let project: ProjectContext;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      project = await Promise.race([this.deps.context(), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('context timeout')), 30_000);
      })]);
    } catch { await finish('rejected', 'context_unavailable', 'The project is unavailable. Nothing was run.'); return; }
    finally { if (timer) clearTimeout(timer); }
    if (!this.valid(grant)) { await finish('rejected', 'grant_changed'); return; }
    if (!grantFresh(state.snapshot(), grant, message.date, this.now())) { await finish('rejected', 'expired'); return; }
    const runs = project.store.listRuns().filter(run => !run.archived);
    if (command.kind === 'command' && command.name === 'tasks') {
      const lines: string[] = [];
      for (const run of runs.slice(0, 10)) {
        const line = `${shortId(run.id)} · ${readableStatus(run.status)} · ${project.store.redactRunText(run.id, run.title).slice(0, 180)}`;
        if (formatTelegramText([...lines, line].join('\n'), Number.MAX_SAFE_INTEGER).length > 4096) break;
        lines.push(line);
      }
      await finish('accepted', 'read', lines.join('\n') || 'No tasks found.'); return;
    }
    let correlation: Correlation | undefined;
    let run: RunRecord | undefined, text: string;
    if (command.kind === 'text') {
      correlation = state.snapshot().correlations.find(row => row.chatId === chatId && row.messageId === message.reply_to_message!.message_id && row.receiverId === grant.receiverId);
      run = correlation ? project.store.getRun(correlation.runId) : undefined;
      if (!correlation || !run) { await finish('rejected', 'unknown_reply', 'I cannot match this reply to a task. Use /reply <task> <text>.'); return; }
      text = message.text!;
    } else if (command.kind === 'command') {
      const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(command.args);
      run = match ? resolveTask(match[1]!, runs) : undefined; text = match?.[2] ?? '';
    } else { await finish('rejected', 'unsupported', HELP); return; }
    if (!run || run.archived) { await finish('rejected', 'unknown_task', 'No unique task found. Provide the full ID or a longer prefix (at least 8 characters).'); return; }
    entry.runId = run.id;
    if (command.kind === 'command' && command.name === 'status') {
      const snapshot = runLifecycleSnapshot(run), episodeId = this.deps.episode(run.id);
      const body = [`Task ${shortId(run.id)}`, readableStatus(run.status), run.title];
      if (run.status === 'waiting') {
        if (run.attentionRequest) for (const question of run.attentionRequest.questions) body.push(question.question, ...(question.options ?? []).map(option => `${option.label}${option.description ? ` — ${option.description}` : ''}`));
        else body.push('This task is waiting. Open the cockpit to read the question, then Reply to this message or use /reply <task> <text>.');
        body.push(`Reply to this message to answer task ${shortId(run.id)}.`);
      }
      const rendered = formatTelegramText(project.store.redactRunText(run.id, body.join('\n')));
      await finish('accepted', 'read');
      const bound = state.snapshot().receivers.find(receiver => receiver.receiverId === grant.receiverId)!;
      this.deps.reply(chatId, rendered, () => this.valid(grant), async raw => {
        const receipt = receiptSchema.safeParse(raw), sequence = Number(episodeId?.slice(episodeId.lastIndexOf('-') + 1));
        if (!receipt.success || String(receipt.data.chat.id) !== chatId || !episodeId || snapshot.status !== 'waiting' || !Number.isSafeInteger(sequence) || sequence < 1) return;
        const next: Correlation = { receiverId: grant.receiverId, chatId, messageId: receipt.data.message_id,
          deliveryRevision: bound.deliveryRevision, bindingGeneration: state.snapshot().binding.generation, enableGeneration: bound.generation,
          runId: snapshot.id, type: 'task.attention_required', sequence, episodeId, continuation: snapshot.continuation, createdAt: this.now(),
          ...(snapshot.attentionRequest ? { requestId: snapshot.attentionRequest.requestId, askedAt: snapshot.attentionRequest.askedAt } : {}) };
        await state.change(draft => { if (this.valid(grant)) draft.correlations.push(next); });
      });
      return;
    }
    if (command.kind === 'command' && (command.name === 'cancel' || command.name === 'continue')) {
      const kind = command.name;
      if (!grant.permissions.includes(kind) || !this.deps.prepareControl || !this.deps.actions) {
        await finish('rejected', 'unauthorized', 'You do not have permission for this action. Check the cockpit.'); return;
      }
      let prepared: PreparedControl | undefined, refusal = 'configuration_unknown';
      try { prepared = await this.deps.prepareControl(project, run, kind, text); } catch (error) { if (error instanceof TelegramControlRefusal) refusal = error.reason; }
      if (!prepared || !this.valid(grant) || !grantFresh(state.snapshot(), grant, message.date, this.now())) { await finish('rejected', refusal, 'The task state or saved account does not allow this action. Check the cockpit.'); return; }
      const snapshot = state.snapshot(), binding = snapshot.receivers.find(row => row.receiverId === grant.receiverId)!;
      const signature = JSON.stringify([snapshot.binding.generation, binding.deliveryRevision]);
      const valid = () => {
        if (!this.valid(grant) || !prepared.valid()) return false;
        const latest = state.snapshot(), receiver = latest.receivers.find(row => row.receiverId === grant.receiverId);
        return signature === JSON.stringify([latest.binding.generation, receiver?.deliveryRevision]);
      };
      const pending = this.deps.actions.create({ kind, receiverId: grant.receiverId, chatId, userId, runId: run.id, valid, responseValid: () => this.valid(grant), execute: prepared.execute });
      if (!pending) { await finish('rejected', 'confirmation_limit', 'Too many pending confirmations. Try again in two minutes.'); return; }
      await finish('accepted', 'preview');
      this.deps.reply(chatId, formatTelegramText(project.store.redactRunText(run.id, prepared.summary)), pending.valid, pending.sent,
        { text: 'Confirm', callback_data: pending.data });
      return;
    }
    const runId = run.id;
    const check = (): string | undefined => {
      if (!this.valid(grant) || !grantFresh(state.snapshot(), grant, message.date, this.now())) return 'grant_changed';
      const current = project.store.getRun(runId);
      if (!current || current.archived || current.status !== 'waiting') return 'not_waiting';
      if (correlation && !correlationCurrent(state.snapshot(), correlation, current, this.deps.episode(runId))) return 'stale_reply';
      return undefined;
    };
    const refusal = check();
    if (refusal) { await finish('rejected', refusal, 'The question is out of date or the task is not waiting. Check /status <task> and use /reply for the current question.'); return; }
    if (!text.trim()) { await finish('rejected', 'empty_text', HELP); return; }
    if (!await state.claim({ ...entry, state: 'claimed', reason: 'pending' })) return;
    let outcome: 'accepted' | 'queued' | 'deferred' | 'rejected' | 'uncertain', reason: string, response: string;
    try {
      const result = await this.deps.deliver(project, run, `[via Telegram] ${text}`, check);
      if (result.status !== 200) { outcome = 'rejected'; reason = 'delivery_refused'; response = 'Delivery refused: the account or task state does not allow this message. Check the cockpit.'; }
      else if ('queued' in result.body) { outcome = 'queued'; reason = 'queued'; response = 'Added to the queue.'; }
      else if ('deferred' in result.body) { outcome = 'deferred'; reason = 'deferred'; response = 'Waiting for the session to start.'; }
      else { outcome = 'accepted'; reason = 'delivered'; response = 'Delivered.'; }
    } catch { outcome = 'uncertain'; reason = 'delivery_uncertain'; response = `I cannot tell whether the message reached task ${shortId(runId)}. Check /status ${shortId(runId)}.`; }
    await finish(outcome, reason, response);
  }
}
