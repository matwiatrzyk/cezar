import { constants } from 'node:fs';
import { open, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { webhookActivitySchema, webhookDeliverySchema, type WebhookActivity, type WebhookDelivery } from '@open-mercato/cezar-contract';
import { redactDeep, collectSecretValues } from '../core/secret-redaction.ts';
import { prepareText, statePath } from './storage.ts';
import { WebhookStateError } from './endpoints.ts';
const cursorSchema = z.strictObject({ scope: z.string().max(2048), upper: z.tuple([z.string(), z.string()]), after: z.tuple([z.string(), z.string()]) });
const compare = (a: readonly string[], b: readonly string[]) => a[0]!.localeCompare(b[0]!) || a[1]!.localeCompare(b[1]!);
export function pageRecords<T extends { id: string; at: string }>(rows: T[], scope: string, query: { limit: number; cursor?: string }) {
  const sorted = [...rows].sort((a, b) => compare([b.at, b.id], [a.at, a.id]));
  let boundary: z.infer<typeof cursorSchema> | undefined;
  if (query.cursor) {
    try {
      if (query.cursor.length > 4096) throw new Error();
      boundary = cursorSchema.parse(JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')));
      if (boundary.scope !== scope) throw new Error();
    } catch { throw new WebhookStateError(409, 'Invalid history cursor; refresh the list'); }
  }
  const upper = boundary?.upper ?? [sorted[0]?.at ?? '', sorted[0]?.id ?? ''] as [string, string];
  const eligible = sorted.filter(row => compare([row.at, row.id], upper) <= 0 && (!boundary || compare([row.at, row.id], boundary.after) < 0));
  const items = eligible.slice(0, Math.max(1, Math.min(100, query.limit))), hasMore = eligible.length > items.length, last = items.at(-1);
  return { items, total: rows.length, hasMore, ...(hasMore && last ? { nextCursor: Buffer.from(JSON.stringify({ scope, upper, after: [last.at, last.id] })).toString('base64url') } : {}) };
}
const activityRowSchema = z.strictObject({ receiverId: z.string().max(128), activity: webhookActivitySchema });
type ActivityRow = z.infer<typeof activityRowSchema>;
export class WebhookHistory {
  private deliveries: WebhookDelivery[] = [];
  private actions: ActivityRow[] = [];
  private reset = false;
  private constructor(private readonly directory: string, private readonly now: () => number, private readonly cap: number) {}
  /** History is display data: an unreadable log is quarantined, never allowed to brick webhooks. */
  get wasReset(): boolean { return this.reset; }
  static async open(directory: string, now = Date.now, cap = 10 * 1024 * 1024): Promise<WebhookHistory> {
    const history = new WebhookHistory(directory, now, cap);
    history.deliveries = await history.read('deliveries.ndjson', webhookDeliverySchema);
    history.actions = await history.read('activity.ndjson', activityRowSchema);
    return history;
  }
  private async read<T>(name: string, schema: z.ZodType<T>): Promise<T[]> {
    try {
      const file = await open(statePath(this.directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if ((await file.stat()).size > this.cap) throw new Error('Webhook history exceeds capacity');
        const content = await file.readFile('utf8');
        return content.split('\n').filter(Boolean).map(line => schema.parse(JSON.parse(line)));
      } finally { await file.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      // The log is bounded display data, not identity or admission evidence: one malformed row
      // must not disable a project's webhooks forever with no repair path (spec §"Storage,
      // privacy and degradation"). Preserve the bytes for inspection and start clean.
      const quarantine = statePath(this.directory, `${name}.corrupt-${randomUUID()}`);
      try { await rename(statePath(this.directory, name), quarantine); }
      catch { throw error; }
      this.reset = true;
      console.warn(`Webhook ${name} was unreadable and has been quarantined as ${quarantine}; earlier history is unavailable.`, error);
      return [];
    }
  }
  private async write<T>(name: string, values: T[], assertOwner?: () => void): Promise<T[]> {
    let size = 0; const retained: T[] = [];
    for (const value of [...values].reverse()) {
      const bytes = Buffer.byteLength(JSON.stringify(value)) + 1;
      if (size + bytes > this.cap) break;
      retained.push(value); size += bytes;
    }
    retained.reverse();
    const prepared = await prepareText(this.directory, name, retained.map(value => JSON.stringify(value) + '\n').join(''));
    try { assertOwner?.(); prepared.publish(); await prepared.finish(); } finally { await prepared.discard(); }
    return retained;
  }
  /** Legacy rows have no trustworthy destination provenance, including deleted receivers. */
  async clearLegacyResponses(assertOwner: () => void): Promise<void> {
    if (!this.deliveries.some(row => row.response !== undefined)) return;
    assertOwner();
    const clean = this.deliveries.map(({ response: _, ...row }) => row);
    this.deliveries = await this.write('deliveries.ndjson', clean, assertOwner);
  }
  results(receiverId: string): WebhookDelivery[] { return structuredClone(this.deliveries.filter(row => row.receiverId === receiverId)); }
  activities(receiverId: string): WebhookActivity[] { return structuredClone(this.actions.filter(row => row.receiverId === receiverId || row.receiverId === '').map(row => row.activity)); }
  receiverIds(): Set<string> { return new Set([...this.deliveries.map(row => row.receiverId), ...this.actions.map(row => row.receiverId)]); }
  async result(row: WebhookDelivery): Promise<void> { await this.upsert([row]); }
  /** One log rewrite for any number of rows (a Pause can settle thousands of queued deliveries). */
  async upsert(rows: readonly WebhookDelivery[]): Promise<void> {
    if (!rows.length) return;
    const parsed = rows.map(row => webhookDeliverySchema.parse(row)), ids = new Set(parsed.map(row => row.deliveryId));
    this.deliveries = await this.write('deliveries.ndjson', [...this.deliveries.filter(old => !ids.has(old.deliveryId)), ...parsed]);
  }
  async activity(receiverId: string, value: WebhookActivity, secrets: readonly string[] = []): Promise<void> {
    const activity = webhookActivitySchema.parse(redactDeep(value, [...collectSecretValues(), ...secrets]));
    this.actions = await this.write('activity.ndjson', [...this.actions, { receiverId, activity }]);
  }
  /** Rewrites a log only when a row expired: an idle project must not rewrite and fsync it every window. */
  async prune(): Promise<void> {
    const earliest = this.now() - 30 * 86400000;
    const deliveries = this.deliveries.filter(row => Date.parse(row.completedAt ?? row.createdAt) > earliest);
    if (deliveries.length !== this.deliveries.length) this.deliveries = await this.write('deliveries.ndjson', deliveries);
    const actions = this.actions.filter(row => Date.parse(row.activity.at) > earliest);
    if (actions.length !== this.actions.length) this.actions = await this.write('activity.ndjson', actions);
  }
}
