import type { AttachmentEntry, MessageResponse } from '@open-mercato/cezar-contract';
import type { ProviderId } from '../core/provider-auth.ts';
import type { RunRecord } from '../runs/store.ts';
import type { PastedContent } from '../workflows/run.ts';
import { queuedStackRefusal } from '../workflows/queued-bounds.ts';
import type { ProjectContext } from './project-context.ts';
import { providerForActiveRun, recordedProfileFor, type ProviderAccountScope } from './provider-action-gate.ts';

export interface MessageDeliveryDependencies {
  providerActionError(required: readonly ProviderId[], scope: ProviderAccountScope): Promise<string | null>;
  resolveAttachments(entries: AttachmentEntry[]): PastedContent[] | string;
  /** Telegram rechecks its grant after asynchronous account checks. HTTP leaves this absent. */
  beforeEffect?(): string | undefined;
}

// HTTP keeps receipts and response serialization; all callers share the same account gate and ladder.
export async function deliverUserMessage(
  project: Pick<ProjectContext, 'root' | 'dataDir' | 'store' | 'manager'>,
  run: RunRecord,
  input: { text: string; images: AttachmentEntry[] },
  deps: MessageDeliveryDependencies,
): Promise<{ status: 200; body: MessageResponse } | { status: 400 | 409; body: { error: string } }> {
  const { root: repoRoot, dataDir, store, manager } = project;
  const id = run.id;
  if (run.status !== 'queued') {
    const blocked = await deps.providerActionError([providerForActiveRun(run)], {
      repoRoot,
      profileFor: (provider) => recordedProfileFor(run, provider),
    });
    if (blocked) return { status: 409, body: { error: blocked } };
  }
  const attachments = deps.resolveAttachments(input.images);
  if (typeof attachments === 'string') return { status: 400, body: { error: attachments } };
  const content: PastedContent[] = [
    ...attachments,
    ...(input.text.trim() ? [{ type: 'text' as const, text: input.text }] : []),
  ];
  const refusal = deps.beforeEffect?.();
  if (refusal) return { status: 409, body: { error: refusal } };
  if (manager.sendMessage(id, content)) return { status: 200, body: { delivered: true } };
  const currentRun = store.getRun(id);
  if (currentRun?.status === 'queued') {
    const refusal = queuedStackRefusal(dataDir, currentRun, content, input.text);
    if (refusal) return { status: 400, body: { error: refusal } };
  }
  const queued = manager.enqueueMessage(id, content);
  if (queued) return { status: 200, body: { queued: true, message: queued } };
  if (manager.deferMessage(id, content)) return { status: 200, body: { deferred: true } };
  return { status: 409, body: { error: 'session closed' } };
}
