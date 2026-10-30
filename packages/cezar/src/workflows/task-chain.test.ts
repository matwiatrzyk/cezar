import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { chainBlocked, RunManager } from './run.ts';
import { QUICK_TASK_WORKFLOW } from './types.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

describe('chainBlocked', () => {
  const lookup = (status?: string) => () => (status ? { status } as never : undefined);
  it('waits on an unfinished predecessor and releases on review/done', () => {
    for (const status of ['queued', 'running', 'waiting', 'failed', 'cancelled']) {
      expect(chainBlocked({ afterRunId: 'a' }, lookup(status))).toBe(true);
    }
    expect(chainBlocked({ afterRunId: 'a' }, lookup('review'))).toBe(false);
    expect(chainBlocked({ afterRunId: 'a' }, lookup('done'))).toBe(false);
  });
  it('releases when the predecessor is gone or none is named', () => {
    expect(chainBlocked({ afterRunId: 'a' }, lookup())).toBe(false);
    expect(chainBlocked({}, lookup('running'))).toBe(false);
  });
});

/** Task chains: a run created `afterRunId` stays queued behind its predecessor with free slots. */
describe('RunManager task chains', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  const savedDryRun = process.env.CEZ_DRY_RUN;

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-task-chain-'));
    process.env.CEZ_DRY_RUN = '1';
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot, { semaphore: new WorkspaceSemaphore({ initial: { maxParallel: 2 } }) });
  });

  afterEach(() => {
    manager.dispose();
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  /** A predecessor whose status the test drives by hand — no slot is ever freed by it. */
  const predecessor = (status: 'running' | 'failed') => {
    const rec = store.createRun({ title: 'A', workflow: 'quick-task', task: 'A', steps: [] });
    store.updateRun(rec.id, { status });
    return rec.id;
  };
  const settle = () => new Promise((r) => setTimeout(r, 200));
  const leftQueue = async (id: string): Promise<void> => {
    const deadline = Date.now() + 20_000;
    while (store.getRun(id)?.status === 'queued') {
      if (Date.now() > deadline) throw new Error('run never left the queue');
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  it('holds the follower with free slots and starts it when the predecessor reaches review', async () => {
    const a = predecessor('running');
    const b = manager.startRun(QUICK_TASK_WORKFLOW, { task: 'mock:done B', worktree: false, afterRunId: a });
    expect(store.getRun(b.id)?.afterRunId).toBe(a);
    await settle();
    expect(store.getRun(b.id)?.status).toBe('queued');

    store.updateRun(a, { status: 'review' });
    await leftQueue(b.id);
  }, 30_000);

  it('does not hold unchained tasks queued behind a chained one', async () => {
    const a = predecessor('running');
    const b = manager.startRun(QUICK_TASK_WORKFLOW, { task: 'mock:done B', worktree: false, afterRunId: a });
    const c = manager.startRun(QUICK_TASK_WORKFLOW, { task: 'mock:done C', worktree: false });
    await leftQueue(c.id);
    expect(store.getRun(b.id)?.status).toBe('queued');
  }, 30_000);

  it('keeps waiting after a failed predecessor until Start now releases it', async () => {
    const a = predecessor('failed');
    const b = manager.startRun(QUICK_TASK_WORKFLOW, { task: 'mock:done B', worktree: false, afterRunId: a });
    await settle();
    expect(store.getRun(b.id)?.status).toBe('queued');

    expect(await manager.startNow(b.id)).toBe('started');
    expect(store.getRun(b.id)?.afterRunId).toBeUndefined();
    await leftQueue(b.id);
  }, 30_000);

  it('releases the follower when its predecessor is deleted', async () => {
    const a = predecessor('running');
    const b = manager.startRun(QUICK_TASK_WORKFLOW, { task: 'mock:done B', worktree: false, afterRunId: a });
    await settle();
    expect(store.getRun(b.id)?.status).toBe('queued');

    store.deleteRun(a);
    await leftQueue(b.id);
  }, 30_000);
});
