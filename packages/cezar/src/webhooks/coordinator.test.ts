import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebhookCoordinator } from './coordinator.ts';
const roots: string[] = [];
const instances: WebhookCoordinator[] = [];
function root() { const value = mkdtempSync(join(tmpdir(), 'webhook-coordinator-')); roots.push(value); execFileSync('git', ['init', '-q'], { cwd: value }); return value; }
afterEach(async () => { for (const coordinator of instances.splice(0)) await coordinator.dispose(); for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); vi.unstubAllEnvs(); });
describe('lightweight project webhook enrollment', () => {
  it('pins an unregistered boot root and aliases use one canonical owner', async () => {
    vi.stubEnv('CEZ_WEBHOOKS', '1'); const boot = root(), other = root();
    const coordinator = new WebhookCoordinator({ mode: () => 'local', ports: () => [4317], projects: async () => [{ id: 'a', root: other, status: 'ok' }] }); instances.push(coordinator);
    const first = await coordinator.get('boot-slug', boot, true);
    await coordinator.discover();
    expect(await coordinator.get('registered-later', boot)).toBe(first);
    expect(coordinator.count()).toBe(1);
  });
  it('does not discover other enrolled roots in single-project mode', async () => {
    vi.stubEnv('CEZ_WEBHOOKS', '1'); const boot = root(), other = root();
    const seed = new WebhookCoordinator({ mode: () => 'local', ports: () => [], projects: async () => [] }); instances.push(seed);
    await (await seed.get('other', other)).create({ name: 'Other', url: 'https://example.com' }); await seed.dispose();
    const projects = vi.fn(async () => [{ id: 'other', root: other, status: 'ok' }]);
    const coordinator = new WebhookCoordinator({ mode: () => 'local', ports: () => [], projects, singleProject: true }); instances.push(coordinator);
    await coordinator.get('boot', boot, true); await coordinator.discover();
    expect(coordinator.count()).toBe(1); expect(projects).not.toHaveBeenCalled();
  });
  it('pauses an owned project durably on explicit removal but not routine discovery', async () => {
    vi.stubEnv('CEZ_WEBHOOKS', '1'); const project = root();
    const coordinator = new WebhookCoordinator({ mode: () => 'local', ports: () => [], projects: async () => [] }); instances.push(coordinator);
    const service = await coordinator.get('project', project, true);
    const receiver = await service.create({ name: 'Ops', url: 'https://example.com' }); await service.activate(receiver.receiver.id, 1);
    await coordinator.discover(); expect(service.list().receivers[0]!.state).toBe('active');
    expect(await coordinator.remove(project)).toBeUndefined();
    const reopened = await coordinator.get('project', project, true);
    expect(reopened.list().receivers[0]!.state).toBe('paused');
  });
});
