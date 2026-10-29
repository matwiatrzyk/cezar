import { describe, expect, it, vi } from 'vitest';
import { createTelegramTask } from '../server/run-messages.ts';
import { randomUUID } from 'node:crypto';

const source = () => ({ id: randomUUID(), botId: '123', epoch: randomUUID(), projectId: 'project', receiverId: 'receiver', grantId: randomUUID(),
  grantGeneration: randomUUID(), enableGeneration: randomUUID(), chatId: '456', userId: '456', sourceMessageId: 1, updateId: 1,
  episodeId: randomUUID(), requestId: randomUUID(), runId: randomUUID(), state: 'claimed' as const, createdAt: 1, updatedAt: 1 });

describe('Telegram task source round trip', () => {
  it('uses the quick-task seam and refuses before creation when the provider gate blocks', async () => {
    const startRun = vi.fn(() => ({ id: 'run-1' }));
    const project = { root: '/missing-project', manager: { startRun } } as never;
    const blocked = await createTelegramTask(project, 'private prompt', source(), () => undefined, {
      providerActionError: async () => 'Codex credentials are unavailable.',
    });
    expect(blocked).toEqual({ created: false, reason: 'provider_unavailable' });
    expect(startRun).not.toHaveBeenCalled();
  });

  it('rechecks authorization after the account gate and creates exactly one run', async () => {
    const startRun = vi.fn(() => ({ id: 'run-1' }));
    const project = { root: '/missing-project', manager: { startRun } } as never;
    let valid = true;
    const claimed = source();
    const result = await createTelegramTask(project, 'private prompt', claimed, () => valid ? undefined : 'grant_changed', {
      providerActionError: async () => null,
    });
    expect(result).toEqual({ created: true, runId: 'run-1' });
    expect(startRun).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ telegramSource: claimed }));
    expect(startRun).toHaveBeenCalledTimes(1);
    valid = false;
    expect(await createTelegramTask(project, 'private prompt', source(), () => 'grant_changed', { providerActionError: async () => null }))
      .toEqual({ created: false, reason: 'project_unavailable' });
    expect(startRun).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['account "work" is unavailable', 'account_unavailable'],
    ['Codex credentials are unavailable.', 'provider_unavailable'],
  ] as const)('returns a terminal policy result for %s', async (message, reason) => {
    const startRun = vi.fn();
    const result = await createTelegramTask({ root: '/missing-project', manager: { startRun } } as never,
      'private prompt', source(), () => undefined, { providerActionError: async () => message });
    expect(result).toEqual({ created: false, reason }); expect(startRun).not.toHaveBeenCalled();
  });

  it('returns project_unavailable when the project/grant fence closes', async () => {
    const startRun = vi.fn();
    const result = await createTelegramTask({ root: '/missing-project', manager: { startRun } } as never,
      'private prompt', source(), () => 'project_changed', { providerActionError: async () => null });
    expect(result).toEqual({ created: false, reason: 'project_unavailable' }); expect(startRun).not.toHaveBeenCalled();
  });
});
