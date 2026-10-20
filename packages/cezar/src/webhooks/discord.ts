import { webhookEventSchema } from '@open-mercato/cezar-contract';

const presentation = {
  'task.attention_required': ['Needs your input', 15105570], 'task.review_ready': ['Ready for review', 3447003],
  'task.finished': ['Task finished', 3066993], 'task.failed': ['Task failed', 15158332],
  'task.cancelled': ['Task cancelled', 9807270], 'webhook.test': ['Test message', 3447003],
} as const;
function escape(text: string): string {
  return text.replace(/@/g, '@\u200b').replace(/[\\*_~`|>\[\]()]/g, '\\$&').replace(/^(\s*)([#-])/gm, '$1\\$2');
}
function clip(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return text.slice(0, limit - 1).replace(/[\uD800-\uDBFF]$/, '').replace(/\\$/, '') + '…';
}

/** Renders only the event's existing privacy-filtered fields; mention parsing stays disabled. */
export function renderDiscordMessage(eventJson: string, ctx: { receiverName?: string } = {}): string {
  const event = webhookEventSchema.parse(JSON.parse(eventJson));
  const [label, color] = presentation[event.type];
  const allowed_mentions = { parse: [] };
  if (event.type === 'webhook.test') {
    return JSON.stringify({ content: clip(`${label} · cezar is connected to this channel${ctx.receiverName ? ` · ${escape(ctx.receiverName)}` : ''}`, 2000), allowed_mentions });
  }
  const title = escape(event.task.title || event.task.id.slice(0, 8));
  const content = clip(`${label} · ${title}`, 2000);
  const fields = [
    { name: 'Project', value: clip(escape(event.source.projectId), 1024), inline: true },
    { name: 'Status', value: `${escape(event.task.previousStatus)} → ${escape(event.task.status)}`, inline: true },
    { name: 'Task', value: clip(escape(event.task.id), 1024), inline: true },
  ];
  if (event.type === 'task.failed' && event.data.message) fields.push({ name: 'Error', value: clip(escape(event.data.message), 1024), inline: false });
  const embedTitle = clip(`${label} · ${title}`, 256);
  const fixedLength = embedTitle.length + 'cezar'.length + fields.reduce((sum, field) => sum + field.name.length + field.value.length, 0);
  const descriptionLimit = Math.min(4096, 6000 - fixedLength);
  let description = '';
  if (event.type === 'task.attention_required') {
    for (const [index, question] of (event.data.questions ?? []).entries()) {
      const line = `${index + 1}. ${escape(question.question)}${(question.options ?? []).map(option =>
        `\n• ${escape(option.label)}${option.description ? ` — ${escape(option.description)}` : ''}`).join('')}`;
      if (description && description.length + line.length + 1 > descriptionLimit) break;
      description += `${description ? '\n' : ''}${clip(line, descriptionLimit)}`;
    }
  }
  const url = event.links?.pullRequest ?? event.links?.issue ?? (event.source.mode === 'hosted' ? event.links?.cockpit : undefined);
  const embed = { title: embedTitle, color, timestamp: event.occurredAt, fields, footer: { text: 'cezar' },
    ...(description ? { description } : {}), ...(url ? { url } : {}) };
  if (fixedLength + description.length > 6000) return JSON.stringify({ content, allowed_mentions });
  return JSON.stringify({ content, allowed_mentions, embeds: [embed] });
}
