import { describe, expect, it, vi } from 'vitest';
import { createTelegramTask } from '../server/run-messages.ts';

describe('Telegram task source round trip', () => {
  it('uses the quick-task seam and refuses before creation when the provider gate blocks', async () => {
    const startRun = vi.fn(() => ({ id: 'run-1' }));
    const project = { root: '/missing-project', manager: { startRun } } as never;
    const blocked = await createTelegramTask(project, 'private prompt', () => undefined, {
      providerActionError: async () => 'Codex credentials are unavailable.',
    });
    expect(blocked).toEqual({ created: false, reason: 'provider_unavailable' });
    expect(startRun).not.toHaveBeenCalled();
  });

  it('rechecks authorization after the account gate and creates exactly one run', async () => {
    const startRun = vi.fn(() => ({ id: 'run-1' }));
    const project = { root: '/missing-project', manager: { startRun } } as never;
    let valid = true;
    const result = await createTelegramTask(project, 'private prompt', () => valid ? undefined : 'grant_changed', {
      providerActionError: async () => null,
    });
    expect(result).toEqual({ created: true, runId: 'run-1' });
    expect(startRun).toHaveBeenCalledTimes(1);
    valid = false;
    expect(await createTelegramTask(project, 'private prompt', () => 'grant_changed', { providerActionError: async () => null }))
      .toEqual({ created: false, reason: 'project_unavailable' });
    expect(startRun).toHaveBeenCalledTimes(1);
  });
});
