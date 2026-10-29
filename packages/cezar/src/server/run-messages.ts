import type { AttachmentEntry, MessageResponse, TelegramTaskCreateResult } from '@open-mercato/cezar-contract';
import type { ProviderId } from '../core/provider-auth.ts';
import type { RunRecord } from '../runs/store.ts';
import type { PastedContent } from '../workflows/run.ts';
import { queuedStackRefusal } from '../workflows/queued-bounds.ts';
import type { ProjectContext } from './project-context.ts';
import { providerForActiveRun, recordedProfileFor, type ProviderAccountScope } from './provider-action-gate.ts';
import { providersRequiredByWorkflow } from './provider-action-gate.ts';
import { QUICK_TASK_WORKFLOW } from '../workflows/types.ts';
import { loadConfig } from '../config.ts';

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
  // Stacking onto a queued prompt invokes no provider, so it skips the gate (provider-auth spec).
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
  // Three-rung ladder (#472): branch on the engine's answer, not a status read — it alone sees the dequeue race.
  if (manager.sendMessage(id, content)) return { status: 200, body: { delivered: true } };
  const currentRun = store.getRun(id);
  // Bounds only when stacking: an over-long message to a finished run answers 409, not 400.
  if (currentRun?.status === 'queued') {
    const refusal = queuedStackRefusal(dataDir, currentRun, content, input.text);
    if (refusal) return { status: 400, body: { error: refusal } };
  }
  const queued = manager.enqueueMessage(id, content);
  if (queued) return { status: 200, body: { queued: true, message: queued } };
  if (manager.deferMessage(id, content)) return { status: 200, body: { deferred: true } };
  return { status: 409, body: { error: 'session closed' } };
}

/** The non-HTTP task creation seam used by Telegram after its durable source claim. */
export async function createTelegramTask(
  project: Pick<ProjectContext, 'root' | 'manager'>,
  text: string,
  check: () => string | undefined,
  deps: Pick<MessageDeliveryDependencies, 'providerActionError'>,
): Promise<TelegramTaskCreateResult> {
  if (check()) return { created: false, reason: 'project_unavailable' };
  const fallback = (await loadConfig(project.root)).defaultRunner;
  const blocked = await deps.providerActionError(providersRequiredByWorkflow(QUICK_TASK_WORKFLOW, fallback), { repoRoot: project.root });
  if (blocked) return { created: false, reason: blocked.includes('account "') ? 'account_unavailable' : 'provider_unavailable' };
  if (check()) return { created: false, reason: 'project_unavailable' };
  try {
    const run = project.manager.startRun(QUICK_TASK_WORKFLOW, { task: text, runner: fallback });
    return { created: true, runId: run.id };
  } catch {
    return { created: false, reason: 'creation_failed' };
  }
}
