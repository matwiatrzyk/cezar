import type { RunRecord } from './store.ts';

type TelegramSource = NonNullable<RunRecord['telegramSource']>;
/** The wire half of `telegramSourceStatusSchema`: no chat, user, bot or message identifier. */
export type PublicTelegramSource = Pick<TelegramSource, 'id' | 'projectId' | 'receiverId' | 'requestId' | 'runId' | 'state' | 'policyReason' | 'createdAt' | 'updatedAt'>;
export type PublicRun = Omit<RunRecord, 'telegramSource'> & { telegramSource?: PublicTelegramSource };

/** Every run that leaves the process (routes, SSE frames) goes through here (spec 2026-10-29). */
export function publicRun(run: RunRecord): PublicRun {
  const { telegramSource, ...rest } = run;
  if (!telegramSource) return rest;
  const { id, projectId, receiverId, requestId, runId, state, policyReason, createdAt, updatedAt } = telegramSource;
  return { ...rest, telegramSource: { id, projectId, receiverId, requestId, runId, state, policyReason, createdAt, updatedAt } };
}
