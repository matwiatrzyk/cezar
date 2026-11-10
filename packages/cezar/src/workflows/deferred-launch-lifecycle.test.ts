import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fallbackAccounts from '../workspace/agent-fallback.ts';
import * as skills from '../skills.ts';
import * as config from '../config.ts';
import * as retention from '../runs/retention.ts';
import * as agentModels from '../agent-config/models.ts';
import { ClaudeCliRunner } from '../core/claude-cli-runner.ts';
import { RunStore } from '../runs/store.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

const workflow: WorkflowDef = { name: 'demo', source: 'built-in', steps: [{ id: 'task', name: 'Task', prompt: '{{task}}' }] };
let root: string;
let store: RunStore;
let manager: RunManager;
type Internals = {
  execute: RunManager['execute'];
  runContinuation: RunManager['runContinuation'];
  acquireRepoRoot: RunManager['acquireRepoRoot'];
  fallbackProviderRefusal: RunManager['fallbackProviderRefusal'];
  landingPolicy: RunManager['landingPolicy'];
  privateMcpForLaunch: RunManager['privateMcpForLaunch'];
  active: RunManager['active'];
  provisionTaskSkills: RunManager['provisionTaskSkills'];
  agentEnvForStep: RunManager['agentEnvForStep'];
};
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cez-deferred-launch-'));
  vi.stubEnv('CEZ_CLAUDE_BIN', fileURLToPath(new URL('../../scripts/mock-claude.mjs', import.meta.url)));
  vi.stubEnv('CEZ_DRY_RUN', '1');
  vi.stubEnv('CEZ_AUTONAME', '0');
  vi.spyOn(ClaudeCliRunner.prototype, 'startSession').mockImplementation(() => {
    throw new Error('Intercepted: no provider may start');
  });
  store = RunStore.open(join(root, '.ai/cezar'));
  manager = new RunManager(store, root, { semaphore: new WorkspaceSemaphore({ initial: { maxParallel: 1 } }) });
});
afterEach(async () => {
  for (const run of store.listRuns()) expect(await manager.cancelAndWait(run.id)).toBe(true);
  manager.dispose();
  store.flush();
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each([
  ['landingPolicy', 'replace'], ['landingPolicy', 'dispose'],
  ['privateMcpForLaunch', 'replace'], ['privateMcpForLaunch', 'dispose'],
] as const)('blocks deferred %s after %s', async (gateName, retirement) => {
  const internal = manager as unknown as Internals;
  let entered!: () => void;
  let release!: () => void;
  const atGate = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const spy = vi.spyOn(internal, gateName).mockImplementation(async () => { entered(); await gate; return undefined; });
  const run = store.createRun({ title: 'deferred', workflow: 'demo', task: 'mock:done', worktree: false, steps: [{ id: 'task', name: 'Task', kind: 'agent' }] });
  const pending = internal.execute(run.id, workflow, { task: 'mock:done', worktree: false, runner: 'claude' });
  await atGate;
  const old = internal.active.get(run.id)!;
  const replacement = { ...old, ownerToken: Symbol('replacement') };
  if (retirement === 'dispose') manager.dispose();
  else internal.active.set(run.id, replacement);
  const snapshot = JSON.stringify(store.getRun(run.id));
  try {
    release();
    await pending;
    expect(ClaudeCliRunner.prototype.startSession).not.toHaveBeenCalled();
    expect(JSON.stringify(store.getRun(run.id))).toBe(snapshot);
    if (retirement === 'replace') expect(internal.active.get(run.id)).toBe(replacement);
  } finally {
    spy.mockRestore();
    internal.active.delete(run.id);
  }
});

// A lease may resolve after dispose already swept the active map. The old async
// owner must release it itself without removing a replacement's registration.
it.each(['dispose', 'replace'] as const)('releases a lease granted after %s', async retirement => {
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, timeout: 10_000 });
  writeFileSync(join(root, 'tracked.txt'), 'base');
  execFileSync('git', ['add', 'tracked.txt'], { cwd: root, timeout: 10_000 });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'base'], { cwd: root, timeout: 10_000 });
  const internal = manager as unknown as Internals;
  let entered!: () => void;
  let release!: () => void;
  const atGate = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const releaseLease = vi.fn();
  vi.spyOn(manager.lifecycle, 'acquireAgentLease').mockImplementation(async () => {
    entered(); await gate; return releaseLease;
  });
  const run = store.createRun({ title: 'lease', workflow: 'demo', task: 'mock:done', steps: [{ id: 'task', name: 'Task', kind: 'agent' }] });
  const pending = internal.execute(run.id, workflow, { task: 'mock:done', runner: 'claude' });
  await atGate;
  const old = internal.active.get(run.id)!;
  const replacement = { ...old, ownerToken: Symbol('replacement') };
  if (retirement === 'dispose') manager.dispose();
  else internal.active.set(run.id, replacement);
  release();
  await pending;
  expect(releaseLease).toHaveBeenCalledTimes(1);
  expect(ClaudeCliRunner.prototype.startSession).not.toHaveBeenCalled();
  if (retirement === 'replace') expect(internal.active.get(run.id)).toBe(replacement);
  internal.active.delete(run.id);
});

// Remove the retired workspace before releasing setup: preventing a provider launch
// alone does not prevent late attachment-directory creation or record writes.
it.each(
  (['provisionTaskSkills', 'configuredModelProvider', 'agentEnvForStep'] as const).flatMap(gateName =>
    (['dispose', 'replace', 'cancel'] as const).map(retirement => ({ gateName, retirement }))),
)('leaves retired setup untouched after $gateName / $retirement', async ({ gateName, retirement }) => {
  const internal = manager as unknown as Internals;
  let entered!: () => void;
  let release!: () => void;
  const atGate = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  if (gateName === 'configuredModelProvider') {
    // The first read is execute's metadata echo; gate the authoritative step read.
    vi.spyOn(agentModels, 'readAgentModelProvider')
      .mockResolvedValueOnce(undefined)
      .mockImplementation(async () => { entered(); await gate; return undefined; });
  } else if (gateName === 'provisionTaskSkills') {
    vi.spyOn(internal, gateName).mockImplementation(async () => { entered(); await gate; return []; });
  } else {
    vi.spyOn(internal, gateName).mockImplementation(async () => {
      entered(); await gate; return { profileId: 'default', env: {} };
    });
  }
  const run = store.createRun({ title: 'setup', workflow: 'demo', task: 'mock:done', worktree: false, steps: [{ id: 'task', name: 'Task', kind: 'agent' }] });
  const pending = internal.execute(run.id, workflow, { task: 'mock:done', worktree: false, runner: 'claude', model: 'sonnet' });
  await atGate;
  const replacement = { ...internal.active.get(run.id)!, ownerToken: Symbol('replacement') };
  if (retirement === 'dispose') manager.dispose();
  else if (retirement === 'replace') internal.active.set(run.id, replacement);
  else expect(await manager.cancelAndWait(run.id)).toBe(true);
  store.flush();
  const snapshot = JSON.stringify(store.getRun(run.id));
  rmSync(root, { recursive: true, force: true });
  try {
    release();
    await pending;
    expect(ClaudeCliRunner.prototype.startSession).not.toHaveBeenCalled();
    expect.soft(existsSync(root)).toBe(false);
    expect.soft(JSON.stringify(store.getRun(run.id))).toBe(snapshot);
    if (retirement === 'replace') expect(internal.active.get(run.id)).toBe(replacement);
  } finally {
    internal.active.delete(run.id);
  }
});

// Continuations have their own setup path, including awaits before model/account setup.
it.each(
  (['landingPolicy', 'agentEnvForStep', 'configuredModelProvider', 'discoverSkills',
    'loadConfig', 'rematerialize', 'requiresGate', 'prepare', 'acquireAgentLease',
    'acquireRepoRoot', 'privateMcpForLaunch', 'provisionTaskSkills',
    'loadFallbackAccounts', 'fallbackProviderRefusal'] as const).flatMap(gateName =>
    (['dispose', 'replace', 'cancel'] as const).map(retirement => ({ gateName, retirement }))),
)('leaves retired continuation untouched after $gateName / $retirement', async ({ gateName, retirement }) => {
  const internal = manager as unknown as Internals;
  let entered!: () => void;
  let release!: () => void;
  const atGate = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const defer = async () => { entered(); await gate; };
  const releaseLease = vi.fn();
  const worktree = ['requiresGate', 'prepare', 'acquireAgentLease'].includes(gateName);
  vi.spyOn(manager.lifecycle, 'requiresGate').mockResolvedValue(true);
  vi.spyOn(manager.lifecycle, 'prepare').mockResolvedValue({ ready: true } as Awaited<ReturnType<typeof manager.lifecycle.prepare>>);
  if (gateName === 'configuredModelProvider') {
    vi.spyOn(agentModels, 'readAgentModelProvider').mockImplementation(async () => { await defer(); return undefined; });
  } else if (gateName === 'discoverSkills') {
    vi.spyOn(skills, 'discoverSkills').mockImplementation(async () => { await defer(); return []; });
  } else if (gateName === 'loadConfig') {
    const value = await config.loadConfig(root);
    vi.spyOn(config, 'loadConfig').mockImplementation(async () => { await defer(); return value; });
  } else if (gateName === 'rematerialize') {
    vi.spyOn(retention, 'rematerializeReclaimedWorktree').mockImplementation(async () => { await defer(); return false; });
  } else if (gateName === 'loadFallbackAccounts') {
    vi.spyOn(fallbackAccounts, 'loadFallbackAccounts').mockImplementation(async () => { await defer(); return null; });
  } else if (gateName === 'requiresGate') {
    vi.mocked(manager.lifecycle.requiresGate).mockImplementation(async () => { await defer(); return true; });
  } else if (gateName === 'prepare') {
    vi.mocked(manager.lifecycle.prepare).mockImplementation(async () => {
      await defer(); return { ready: true } as Awaited<ReturnType<typeof manager.lifecycle.prepare>>;
    });
  } else if (gateName === 'acquireAgentLease') {
    vi.spyOn(manager.lifecycle, gateName).mockImplementation(async () => { await defer(); return releaseLease; });
  } else if (gateName === 'acquireRepoRoot') {
    vi.spyOn(internal, gateName).mockImplementation(async (_id, state) => {
      await defer(); state.releaseRepoRoot = releaseLease; return true;
    });
  } else if (gateName === 'agentEnvForStep') {
    vi.spyOn(internal, gateName).mockImplementation(async () => { await defer(); return { profileId: 'late-profile', env: {} }; });
  } else if (gateName === 'provisionTaskSkills') {
    vi.spyOn(internal, gateName).mockImplementation(async () => { await defer(); return []; });
  } else {
    vi.spyOn(internal, gateName).mockImplementation(async () => { await defer(); return undefined; });
  }
  const run = store.createRun({ title: 'continuation', workflow: 'demo', task: 'mock:done', worktree: false,
    steps: [{ id: 'task', name: 'Task', kind: 'agent' }] });
  store.updateRun(run.id, { status: 'review', ...(gateName !== 'acquireRepoRoot' ? { readOnly: true as const } : {}), model: 'sonnet',
    ...(['loadFallbackAccounts', 'fallbackProviderRefusal'].includes(gateName)
      ? { fallbackEpisode: { attempted: [], current: { key: 'claude:default', stepId: 'task' } } } : {}), ...(worktree ? { worktreePath: join(root, 'tree') } : {}) });
  const pending = internal.runContinuation(run.id, 'task', undefined, 'claude', 'mock:done');
  await atGate;
  const replacement = { ...internal.active.get(run.id)!, ownerToken: Symbol('replacement') };
  if (retirement === 'dispose') manager.dispose();
  else if (retirement === 'replace') internal.active.set(run.id, replacement);
  else expect(await manager.cancelAndWait(run.id)).toBe(true);
  store.flush();
  const snapshot = JSON.stringify(store.getRun(run.id));
  rmSync(root, { recursive: true, force: true });
  try {
    release();
    await pending;
    expect(ClaudeCliRunner.prototype.startSession).not.toHaveBeenCalled();
    expect.soft(existsSync(root)).toBe(false);
    expect.soft(JSON.stringify(store.getRun(run.id))).toBe(snapshot);
    if (retirement === 'replace') expect(internal.active.get(run.id)).toBe(replacement);
    if (gateName === 'acquireAgentLease' || gateName === 'acquireRepoRoot') expect(releaseLease).toHaveBeenCalledTimes(1);
  } finally {
    internal.active.delete(run.id);
  }
});

it.each(['resolve', 'reject'] as const)('retains a disposed continuation lease until its live provider result %s', async outcome => {
  const internal = manager as unknown as Internals;
  const releaseLease = vi.fn();
  vi.spyOn(manager.lifecycle, 'requiresGate').mockResolvedValue(true);
  vi.spyOn(manager.lifecycle, 'prepare').mockResolvedValue({ ready: true } as Awaited<ReturnType<typeof manager.lifecycle.prepare>>);
  vi.spyOn(manager.lifecycle, 'acquireAgentLease').mockResolvedValue(releaseLease);
  let started!: () => void;
  const atSession = new Promise<void>(resolve => { started = resolve; });
  let finish!: () => void;
  let fail!: (error: Error) => void;
  const result = new Promise<{ text: string; toolCalls: []; tokensUsed: number }>((resolve, reject) => {
    finish = () => resolve({ text: 'done', toolCalls: [], tokensUsed: 0 });
    fail = reject;
  });
  const end = vi.fn();
  const interrupt = vi.fn();
  vi.mocked(ClaudeCliRunner.prototype.startSession).mockImplementation(() => {
    started();
    return { result, sendMessage: () => false, end, interrupt, open: true };
  });
  const run = store.createRun({ title: 'live continuation', workflow: 'demo', task: 'mock:done',
    steps: [{ id: 'task', name: 'Task', kind: 'agent' }] });
  mkdirSync(join(root, 'tree'));
  store.updateRun(run.id, { status: 'review', worktreePath: join(root, 'tree') });
  const pending = internal.runContinuation(run.id, 'task', undefined, 'claude', 'mock:done');
  await atSession;
  manager.dispose();
  expect(releaseLease).not.toHaveBeenCalled();
  expect(end).not.toHaveBeenCalled();
  expect(interrupt).not.toHaveBeenCalled();
  if (outcome === 'resolve') finish();
  else fail(new Error('provider exited'));
  await pending;
  expect(releaseLease).toHaveBeenCalledTimes(1);
  expect(ClaudeCliRunner.prototype.startSession).toHaveBeenCalledTimes(1);
});
