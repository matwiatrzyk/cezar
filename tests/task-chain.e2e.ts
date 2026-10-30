import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

for (const width of [1440, 390]) {
  test(`task chain search, continuation and release at ${width}px`, async ({ app, screen, browser }) => {
    await browser.setViewport({ width, height: 900 });
    const api = async (path: string, method = 'GET', body?: unknown) => {
      const response = await fetch(new URL(`/api/v1${path}`, app.baseUrl), {
        method, headers: { 'content-type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      expect(response.ok).toBe(true);
      return response.json();
    };
    const a = await api('/runs', 'POST', { task: `Chain predecessor ${width}`, steps: [{ id: 'work', prompt: '{{task}}' }], worktree: false });
    const created = [a.id];
    try {
      await api(`/runs/${a.id}/cancel`, 'POST');
      await app.open('/new');
      await screen.getByRole('textbox', 'Describe a task for the agent').fill(`Chain follower ${width}`);
      await screen.getByRole('button', 'Choose task start time').tap();
      await screen.getByRole('radio', 'After another task').tap();
      await expect(screen.getByRole('button', 'Queue task')).toBeDisabled();
      await screen.getByRole('textbox', 'Find the task to start after').fill(a.id);
      await expect(screen.getByRole('option')).toHaveCount(1);
      await screen.getByRole('option').tap();
      await expect(screen.getByRole('button', 'Queue task')).toBeEnabled();
      await screen.getByRole('button', 'Queue task').tap();
      await expect(screen.getByRole('button', 'Add another to the series')).toBeVisible();
      await expect(screen.getByText('That task was stopped', { exact: false })).toBeVisible();
      const followerUrl = await browser.url();
      const bId = new URL(followerUrl).pathname.split('/').at(-1)!;
      created.push(bId);
      const b = await api(`/runs/${bId}`);
      expect(b.afterRunId).toBe(a.id);
      expect(b.status).toBe('queued');
      await app.screenshot(`chain-waiting-${width}`);
      await screen.getByRole('button', 'Add another to the series').tap();
      await expect(screen.getByRole('button', 'After:', { exact: false })).toBeVisible();
      await expect(screen.getByRole('button', 'After:', { exact: false })).toContainText(`Chain follower ${width}`);
      await screen.getByRole('button', 'Start now instead').tap();
      await expect(screen.getByRole('button', 'Start task')).toBeVisible();
      await browser.goto(followerUrl);
      await screen.getByRole('button', 'Start now', { exact: true }).tap();
      await expect.poll(async () => (await api(`/runs/${bId}`)).status, { timeout: 20000 }).not.toBe('queued');
      expect((await api(`/runs/${bId}`)).afterRunId).toBeUndefined();

    } finally {
      for (const id of created.reverse()) {
        await api(`/runs/${id}/cancel`, 'POST');
        await api(`/runs/${id}`, 'DELETE');
      }
    }
  });
}
