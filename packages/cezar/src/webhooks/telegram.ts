import { webhookEventSchema } from '@open-mercato/cezar-contract';

const labels = {
  'task.attention_required': 'Needs your input', 'task.review_ready': 'Ready for review', 'task.finished': 'Task finished',
  'task.failed': 'Task failed', 'task.cancelled': 'Task cancelled', 'webhook.test': 'Test message',
} as const;
const statusLabels: Record<string, string> = { queued: 'Queued', running: 'Running', waiting: 'Waiting for your answer', done: 'Completed', failed: 'Failed', cancelled: 'Cancelled', review: 'Ready for review' };
/** Human status names shared by notifications and bot replies; unknown codes never leak. */
export const readableTaskStatus = (status: string): string => statusLabels[status] ?? 'Status unavailable';
// Telegram counts the 4096-character limit after entity parsing, so budgets use visible text.
const LIMIT = 4096;
type Part = { text: string; tag?: 'b' | 'code'; href?: string };

export interface TelegramTaskReply {
  id: string; title: string; status: string; result?: string; error?: string;
  questions?: Array<{ question: string; options?: Array<{ label: string; description?: string }> }>;
  link?: string; privateChat?: boolean;
}

export function renderTelegramSourceOutcome(outcome: { state: string; policyReason?: string }): string {
  const text = outcome.state === 'uncertain'
    ? 'I cannot tell whether the task was created. Check the cockpit before trying again.'
    : outcome.state === 'expired'
      ? 'This Telegram task request expired before it could be completed. Check the cockpit.'
      : outcome.policyReason === 'account_unavailable'
        ? 'The saved account is unavailable. Nothing was run; check the cockpit.'
        : outcome.policyReason === 'provider_unavailable'
          ? 'The task provider is unavailable. Nothing was run; check the cockpit.'
          : 'The task could not be started. Nothing was run; check the cockpit.';
  return formatTelegramText(text);
}

function clip(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return text.slice(0, Math.max(0, limit - 1)).replace(/[\uD800-\uDBFF]$/, '') + '…';
}
// `@` gets a zero-width space so task text cannot read as a mention or channel handle.
const neutral = (text: string) => text.replace(/@/g, '@​');
const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const visible = (line: Part[]) => line.reduce((sum, part) => sum + part.text.length, 0);
function html(lines: Part[][]): string {
  return lines.map(line => line.map(part => {
    const text = escape(part.text);
    if (part.href) return `<a href="${escape(part.href).replace(/"/g, '&quot;')}">${text}</a>`;
    return part.tag ? `<${part.tag}>${text}</${part.tag}>` : text;
  }).join('')).join('\n');
}

/** Renders only the event's existing privacy-filtered fields (spec 2026-10-27-telegram-webhook-receivers). */
/** `replyHint` defaults off: only a receiver with two-way Telegram active can act on the hint. */
export function renderTelegramMessage(eventJson: string, ctx: { chatId: string; receiverName?: string; replyHint?: boolean }): string {
  if (!ctx.chatId) throw new Error('Telegram receiver has no chat ID');
  const event = webhookEventSchema.parse(JSON.parse(eventJson));
  const label = labels[event.type];
  const wire = (lines: Part[][]) => JSON.stringify({ chat_id: ctx.chatId, text: html(lines), parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
  if (event.type === 'webhook.test') {
    return wire([[{ text: label, tag: 'b' }, { text: neutral(clip(` · cezar is connected to this chat${ctx.receiverName ? ` · ${ctx.receiverName}` : ''}`, 512)) }]]);
  }
  const header: Part[] = [{ text: label, tag: 'b' }, { text: ` · ${neutral(clip(event.task.title || event.task.id.slice(0, 8), 256))}` }];
  const lines: Part[][] = [header, [],
    [{ text: `Project: ${neutral(clip(event.source.projectId, 256))}` }],
    [{ text: `Status: ${readableTaskStatus(event.task.status)} (was ${readableTaskStatus(event.task.previousStatus).toLowerCase()})` }],
    [{ text: 'Task: ' }, { text: clip(event.task.id, 128), tag: 'code' }]];
  if (event.type === 'task.failed' && event.data.message) lines.push([{ text: `Error: ${neutral(clip(event.data.message, 1024))}` }]);
  const url = event.links?.pullRequest ?? event.links?.issue ?? (event.source.mode === 'hosted' ? event.links?.cockpit : undefined);
  const link: Part[] | undefined = url && /^https?:\/\//i.test(url)
    ? [{ text: event.links?.pullRequest ? 'Open pull request' : event.links?.issue ? 'Open issue' : 'Open in cezar', href: url }] : undefined;
  const budget = () => lines.reduce((sum, line) => sum + visible(line) + 1, 0) + (link ? visible(link) + 2 : 0);
  if (event.type === 'task.attention_required' && event.data.questions?.length) {
    lines.push([]);
    for (const [index, question] of event.data.questions.entries()) {
      const text = neutral(`${index + 1}. ${question.question}${(question.options ?? []).map(option =>
        `\n• ${option.label}${option.description ? ` — ${option.description}` : ''}`).join('')}`);
      const room = LIMIT - budget();
      // Drop trailing questions first; clip only the first one that does not fit.
      if (text.length + 1 > room) { if (index === 0 && room > 64) lines.push([{ text: clip(text, room - 1) }]); break; }
      lines.push([{ text }]);
    }
    if (lines.at(-1)!.length === 0) lines.pop();
  }
  if (event.type === 'task.attention_required' && ctx.replyHint === true) {
    // Group commands need the @bot suffix the renderer does not know, so groups get the Reply path only.
    const hint: Part[] = [{ text: ctx.chatId.startsWith('-') ? 'Reply to this message to answer the task.' : 'Reply to this message to answer the task, or use /status and /reply.' }];
    const hintCost = visible(hint) + 2;
    // The link is appended below the hint. Reserve its separators too; the hint is
    // optional, while the task content and link are useful even at the Telegram limit.
    const linkCost = link ? visible(link) + 2 : 0;
    if (lines.reduce((sum, line) => sum + visible(line), 0) + lines.length - 1 + hintCost + linkCost <= LIMIT) lines.push([], hint);
  }
  if (link) lines.push([], link);
  const total = lines.reduce((sum, line) => sum + visible(line), 0) + lines.length - 1;
  return wire(total > LIMIT ? [header] : lines);
}

/** Plain command replies use the same escaping and mention policy as event notifications;
 *  `/command@<botUsername>` stays intact because groups only route the addressed form. */
export function formatTelegramText(value: string, limit = 4096, botUsername?: string): string {
  let low = 0, high = Math.min(value.length, limit), result = '';
  while (low <= high) {
    const length = Math.floor((low + high) / 2);
    let candidate = escape(neutral(clip(value, length)));
    if (botUsername) candidate = candidate.replace(new RegExp(`(/[A-Za-z0-9_]+)@\u200b(${botUsername.replace(/[^A-Za-z0-9_]/g, '')})(?![A-Za-z0-9_])`, 'gi'), '$1@$2');
    if (candidate.length <= limit) { result = candidate; low = length + 1; }
    else high = length - 1;
  }
  return result;
}
