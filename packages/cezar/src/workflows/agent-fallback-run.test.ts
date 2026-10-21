import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cezarHomeDir } from '../paths.ts';
import { RunStore } from '../runs/store.ts';
import { putAgentFallbackPolicy, type AgentFallbackPolicy } from '../workspace/agent-fallback.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/**
 * Automatic agent fallback through the real engine (spec 2026-10-20-agent-usage-limit-fallback).
 * The trigger is the bundled mock's `mock:limit` reply — Claude Code's own exhaustion envelope.
 * The successor is a second Claude ACCOUNT, because that is a distinct budget the dry run can drive.
 */
describe('automatic agent fallback', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager | undefined;
  const savedEnv: Record<string, string | undefined> = {};

  const workflow: WorkflowDef = { name: 'quick-task', source: 'built-in', steps: [{ id: 'work', name: 'Work', prompt: '{{task}}' }] };

  async function until(check: () => boolean, label: string): Promise<void> {
    const deadline = Date.now() + 20_000;
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  const settled = (id: string) => ['done', 'review', 'failed', 'cancelled'].includes(store.getRun(id)?.status ?? '');
  const messages = (id: string) => store.readEvents(id).map((event) => String(event.message ?? ''));

  function registerAccounts(ids: string[]): void {
    const home = cezarHomeDir();
    mkdirSync(home, { recursive: true });
    const accounts = ids.map((id) => {
      const configDir = join(home, `claude-${id}`);
      mkdirSync(configDir, { recursive: true });
      writeFileSync(join(configDir, '.claude.json'), '{}');
      return { id, provider: 'claude', configDir, label: id === 'second' ? 'Second' : id, addedAt: '2026-10-21T00:00:00.000Z' };
    });
    writeFileSync(join(home, 'agent-accounts.json'), JSON.stringify({ version: 1, accounts, selections: {}, defaults: {} }));
  }

  async function enable(candidates: AgentFallbackPolicy['candidates']): Promise<AgentFallbackPolicy> {
    const saved = await putAgentFallbackPolicy(repoRoot, { expectedRevision: 0, expectedIncarnation: null, enabled: true, candidates });
    if ('conflict' in saved) throw new Error('conflict');
    return saved;
  }

  beforeEach(async () => {
    savedEnv.CEZ_DRY_RUN = process.env.CEZ_DRY_RUN;
    savedEnv.CEZ_MOCK_LIMIT_RESET_SECONDS = process.env.CEZ_MOCK_LIMIT_RESET_SECONDS;
    process.env.CEZ_DRY_RUN = '1';
    process.env.CEZ_MOCK_LIMIT_RESET_SECONDS = '3600';
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-fallback-run-'));
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    rmSync(join(cezarHomeDir(), 'agent-fallback.json'), { force: true });
    rmSync(join(cezarHomeDir(), 'agent-accounts.json'), { force: true });
  });

  afterEach(async () => {
    if (manager) {
      for (const { id } of store.listRuns()) manager.cancel(id);
      await until(() => store.listRuns().every(({ id }) => !manager?.isActive(id)), 'runs to stop');
      manager.dispose();
      manager = undefined;
    }
    await store.flush?.();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('hands an exhausted task to the next configured account, in the same run, and holds the exhausted account', async () => {
    registerAccounts(['second']);
    await enable([{ provider: 'claude', profileId: 'second' }]);
    manager = new RunManager(store, repoRoot);
    const started = manager.startRun(workflow, { task: 'fix the bug mock:limit', worktree: false });
    await until(() => (store.getRun(started.id)?.fallbackEpisode?.current !== undefined), 'fallback to reserve its successor');
    const record = store.getRun(started.id);
    expect(record?.agentProfile).toBe('second');
    expect(record?.fallbackEpisode?.attempted).toEqual(['claude:default', 'claude:second']);
    expect(record?.usageLimitHolds?.map((hold) => hold.account)).toEqual(['claude:default']);
    expect(record?.autoResumeAt).toBeUndefined();
    expect(messages(started.id)).toContain('Claude reached its usage limit — Claude (Second) continues this task');
    expect(manager.accountHolds().deadline.has('claude:default')).toBe(true);
    expect(store.listRuns()).toHaveLength(1);
  }, 40_000);

  it('stops with one clear reason when no configured agent can continue, and never returns to the starting agent', async () => {
    registerAccounts([]);
    // Listing the starting agent itself and a removed account: both must be skipped, not used.
    await enable([{ provider: 'claude', profileId: 'default' }, { provider: 'claude', profileId: 'removed' }]);
    manager = new RunManager(store, repoRoot);
    const started = manager.startRun(workflow, { task: 'mock:limit', worktree: false });
    await until(() => messages(started.id).some((m) => m.startsWith('no fallback agent could continue')), 'exhaustion summary');
    const record = store.getRun(started.id);
    expect(record?.status).toBe('failed');
    expect(record?.autoResumeAt).toBeUndefined();
    expect(record?.steps.some((step) => step.id.startsWith('continue-'))).toBe(false);
    expect(messages(started.id)).toContain("fallback skipped Claude (removed) — account no longer exists");
    const summary = store.readEvents(started.id).find((e) => String(e.message ?? '').startsWith('no fallback agent could continue'));
    expect(summary?.tone).toBe('danger');
  }, 40_000);

  it('leaves the zero-config path untouched: no policy means the reset-time auto-resume, exactly as before', async () => {
    manager = new RunManager(store, repoRoot);
    const started = manager.startRun(workflow, { task: 'mock:limit', worktree: false });
    await until(() => settled(started.id), 'run to fail');
    await until(() => store.getRun(started.id)?.autoResumeAt !== undefined, 'auto-resume to arm');
    expect(store.getRun(started.id)?.fallbackEpisode).toBeUndefined();
    expect(store.getRun(started.id)?.fallbackPolicy).toMatchObject({ enabled: false });
  }, 40_000);

  it('keeps graph workflows on the reset-time auto-resume even with fallback enabled', async () => {
    registerAccounts(['second']);
    await enable([{ provider: 'claude', profileId: 'second' }]);
    manager = new RunManager(store, repoRoot);
    const { getAgentFallbackPolicy } = await import('../workspace/agent-fallback.ts');
    const graphRun = store.createRun({ title: 'g', workflow: 'graph', task: 't', runner: 'claude', steps: [{ id: 'work', name: 'Work', kind: 'agent' }] });
    store.updateRun(graphRun.id, {
      status: 'failed',
      error: 'Claude AI usage limit reached|' + String(Math.floor(Date.now() / 1000) + 3600),
      fallbackPolicy: await getAgentFallbackPolicy(repoRoot),
      workflowDef: { name: 'graph', source: 'built-in', steps: [{ id: 'work', name: 'Work', prompt: '{{task}}' }], graph: { start: 'work', nodes: { work: { step: 'work' } } } } as unknown as WorkflowDef,
    });
    store.updateStep(graphRun.id, 'work', { status: 'failed', sessionId: 'sess-1' });
    (manager as unknown as { scheduleAutoResumeIfLimited(id: string): void }).scheduleAutoResumeIfLimited(graphRun.id);
    expect(store.getRun(graphRun.id)?.fallbackEpisode).toBeUndefined();
    expect(store.getRun(graphRun.id)?.autoResumeAt).toBeDefined();
  }, 40_000);

  it('does not switch providers on a transient rate limit', async () => {
    registerAccounts(['second']);
    await enable([{ provider: 'claude', profileId: 'second' }]);
    manager = new RunManager(store, repoRoot);
    const record = store.createRun({ title: 't', workflow: 'quick-task', task: 't', runner: 'claude', steps: [{ id: 'work', name: 'Work', kind: 'agent' }] });
    const snapshot = await import('../workspace/agent-fallback.ts').then((m) => m.getAgentFallbackPolicy(repoRoot));
    store.updateRun(record.id, { status: 'failed', error: 'rate_limit_error: exceeded your per-minute rate limit', fallbackPolicy: snapshot, workflowDef: workflow });
    store.updateStep(record.id, 'work', { status: 'failed', sessionId: 'sess-1' });
    (manager as unknown as { scheduleAutoResumeIfLimited(id: string): void }).scheduleAutoResumeIfLimited(record.id);
    expect(store.getRun(record.id)?.fallbackEpisode).toBeUndefined();
    expect(store.getRun(record.id)?.runner).toBe('claude');
  });

  it('a run created before the policy existed never picks it up later', async () => {
    manager = new RunManager(store, repoRoot);
    const record = store.createRun({ title: 't', workflow: 'quick-task', task: 't', runner: 'claude', steps: [{ id: 'work', name: 'Work', kind: 'agent' }] });
    registerAccounts(['second']);
    await enable([{ provider: 'claude', profileId: 'second' }]);
    store.updateRun(record.id, { status: 'failed', error: 'Claude AI usage limit reached|' + String(Math.floor(Date.now() / 1000) + 3600), workflowDef: workflow });
    store.updateStep(record.id, 'work', { status: 'failed', sessionId: 'sess-1' });
    (manager as unknown as { scheduleAutoResumeIfLimited(id: string): void }).scheduleAutoResumeIfLimited(record.id);
    expect(store.getRun(record.id)?.fallbackEpisode).toBeUndefined();
    expect(store.getRun(record.id)?.autoResumeAt).toBeDefined();
  });

  it('re-queues a reserved sessionless successor after a restart instead of restarting the workflow', async () => {
    const record = store.createRun({ title: 't', workflow: 'quick-task', task: 't', runner: 'claude', steps: [{ id: 'work', name: 'Work', kind: 'agent' }] });
    store.addStep(record.id, { id: 'continue-1', name: 'Continue', kind: 'agent' });
    store.updateStep(record.id, 'work', { status: 'failed' });
    store.updateRun(record.id, {
      status: 'queued',
      workflowDef: workflow,
      fallbackEpisode: { attempted: ['codex:default', 'claude:default'], current: { key: 'claude:default', stepId: 'continue-1' } },
    });
    manager = new RunManager(store, repoRoot);
    await manager.recover();
    expect(messages(record.id).some((m) => m.endsWith('interrupted continuation re-queued'))).toBe(true);
    expect(store.getRun(record.id)?.steps.map((step) => step.id)).toEqual(['work', 'continue-1']);
  }, 40_000);
});
