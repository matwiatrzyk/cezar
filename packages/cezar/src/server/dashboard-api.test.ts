import { dashboardOverviewSchema } from '@open-mercato/cezar-contract';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  dashboardSnapshotSchema,
  dashboardCostsSchema,
  dashboardTasksPageSchema,
  dashboardTelemetrySchema,
  dashboardFeedSchema,
  projectsResponseSchema,
} from '@open-mercato/cezar-contract';
import { RunStore } from '../runs/store.ts';
import * as processUsage from '../core/process-usage.ts';
import type { RunManager } from '../workflows/run.ts';
import { listProjects, registerProject } from '../workspace/projects.ts';
import { createApp } from './server.ts';
import { ProjectContexts } from './project-context.ts';
import { apiRequest } from './loopback-request.testkit.ts';
const dirs: string[] = [];
const stores: RunStore[] = [];
const cleanups: Array<() => void> = [];
const savedHome = process.env.CEZ_HOME;
beforeEach(() => {
  const home = mkdtempSync(join(tmpdir(), 'cez-dashboard-home-'));
  dirs.push(home);
  process.env.CEZ_HOME = home;
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) cleanup();
  for (const s of stores.splice(0)) s.flush();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  if (savedHome === undefined) delete process.env.CEZ_HOME;
  else process.env.CEZ_HOME = savedHome;
});
describe('dashboard workspace routes', () => {
  it('serves validated overview drilldowns without exposing usage fields', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cez-dashboard-overview-'));
    dirs.push(root);
    const store = RunStore.open(join(root, '.ai/cezar'));
    stores.push(store);
    const run = store.createRun({
      title: 'Completed outcome',
      task: 'private prompt',
      workflow: 'build',
      steps: [],
    });
    store.updateRun(run.id, {
      status: 'done',
      finishedAt: new Date().toISOString(),
      costUsd: 12,
    });
    const app = createApp({
      repoRoot: root,
      store,
      manager: {} as RunManager,
      version: 'test',
      onDispose: (cleanup) => cleanups.push(cleanup),
    });
    const response = await apiRequest(app, '/api/v1/workspace/dashboard/overview');
    expect(response.status).toBe(200);
    const wire = await response.json();
    const data = dashboardOverviewSchema.parse(wire);
    expect(data).toEqual(wire);
    expect(data.metrics.completed).toBe(1);
    expect(data.page.rows[0]?.id).toBe(run.id);
    expect(data.page.rows[0]).not.toHaveProperty('costUsd');
    expect(data.page.rows[0]).not.toHaveProperty('task');
    expect(
      (await apiRequest(app, '/api/v1/workspace/dashboard/overview?group=nonsense')).status,
    ).toBe(400);
    expect(
      (await apiRequest(app, '/api/v1/workspace/dashboard/overview?snapshotId=missing')).status,
    ).toBe(409);
    const details = await apiRequest(
      app,
      `/api/v1/workspace/dashboard/overview?snapshotId=${data.snapshotId}&group=completed`,
    );
    expect(dashboardOverviewSchema.parse(await details.json()).page.total).toBe(1);
  });

  it('applies independent runtime usage settings to fresh and cached cost responses', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cez-dashboard-cost-policy-'));
    dirs.push(root);
    const store = RunStore.open(join(root, '.ai/cezar'));
    stores.push(store);
    const run = store.createRun({
      title: 'Reported usage',
      task: 't',
      workflow: 'build',
      steps: [],
    });
    store.updateRun(run.id, { costUsd: 2, inputTokens: 11, outputTokens: 7 });
    const app = createApp({
      repoRoot: root,
      store,
      manager: {} as RunManager,
      version: 'test',
      onDispose: (cleanup) => cleanups.push(cleanup),
    });
    const names = ['CEZ_HIDE_TOKEN_METRICS', 'CEZ_HIDE_COST', 'CEZ_HIDE_TOKEN_USAGE'] as const;
    const saved = names.map((name) => process.env[name]);
    const read = async (snapshotId?: string) => {
      const response = await apiRequest(
        app,
        `/api/v1/workspace/dashboard/costs${snapshotId ? `?snapshotId=${snapshotId}` : ''}`,
      );
      expect(response.status).toBe(200);
      const wire = await response.json();
      const parsed = dashboardCostsSchema.parse(wire);
      expect(parsed).toEqual(wire);
      return parsed;
    };
    try {
      for (const name of names) delete process.env[name];
      let first = await read();
      for (const tokens of [true, false])
        for (const cost of [true, false]) {
          process.env.CEZ_HIDE_TOKEN_USAGE = tokens ? '0' : '1';
          process.env.CEZ_HIDE_COST = cost ? '0' : '1';
          for (const result of [await read(first.snapshotId), await read()]) {
            expect(result.visibility).toEqual({ tokens, cost });
            expect('inputTokens' in result.totals).toBe(tokens);
            expect('outputTokens' in result.projects[0]!).toBe(tokens);
            expect('costUsd' in result.tasks.rows[0]!).toBe(cost);
            if (tokens) expect(result.totals.inputTokens?.value).toBe(11);
            if (cost) expect(result.totals.costUsd?.value).toBe(2);
            first = result;
          }
        }
      process.env.CEZ_HIDE_TOKEN_USAGE = '0';
      process.env.CEZ_HIDE_COST = '0';
      process.env.CEZ_HIDE_TOKEN_METRICS = '1';
      const hidden = await read();
      expect(hidden.visibility).toEqual({ tokens: false, cost: false });
      expect(hidden.totals).toEqual({ tasks: 1 });
    } finally {
      names.forEach((name, index) => {
        if (saved[index] === undefined) delete process.env[name];
        else process.env[name] = saved[index];
      });
    }
  });

  it.each([false, true])(
    'includes unregistered boot tasks, results and telemetry (other project registered: %s)',
    async (otherRegistered) => {
      const root = mkdtempSync(join(tmpdir(), 'cez-dashboard-unregistered-'));
      dirs.push(root);
      const store = RunStore.open(join(root, '.ai/cezar'));
      stores.push(store);
      const question = store.createRun({
        title: 'Boot question',
        task: 't',
        workflow: 'build',
        steps: [],
      });
      store.updateRun(question.id, { status: 'waiting' });
      const result = store.createRun({
        title: 'Boot result',
        task: 't',
        workflow: 'build',
        steps: [],
      });
      store.updateRun(result.id, { status: 'done', finishedAt: new Date().toISOString() });
      const running = store.createRun({
        title: 'Boot running',
        task: 't',
        workflow: 'build',
        steps: [],
      });
      store.updateRun(running.id, { status: 'running' });
      const sampledAt = new Date().toISOString();
      vi.spyOn(processUsage, 'currentTimedUsage').mockImplementation((id) =>
        id === running.id ? { sampledAt, cpuPct: 1, rssBytes: 42, procCount: 1 } : undefined,
      );
      let otherId: string | undefined;
      if (otherRegistered) {
        const other = mkdtempSync(join(tmpdir(), 'cez-dashboard-registered-'));
        dirs.push(other);
        otherId = (await registerProject(other)).id;
      }
      const contexts = new ProjectContexts({ listProjects });
      cleanups.push(() => contexts.disposeAll());
      const app = createApp({
        repoRoot: root,
        store,
        manager: {} as RunManager,
        version: 'test',
        contexts,
        onDispose: (cleanup) => cleanups.push(cleanup),
      });
      const get = (path: string) => apiRequest(app, `/api/v1/workspace/dashboard${path}`);
      const snapshot = dashboardSnapshotSchema.parse(await (await get('')).json());
      expect(snapshot.counts.questions).toBe(1);
      expect(snapshot.counts.running).toBe(1);
      const bootId = snapshot.questions.rows[0]?.projectId;
      expect(bootId).toBeTruthy();
      expect(snapshot.questions.rows[0]?.id).toBe(question.id);
      const projectsWire = projectsResponseSchema.parse(
        await (await apiRequest(app, '/api/v1/projects')).json(),
      );
      expect(projectsWire.bootProject).toBe(bootId);
      expect(projectsWire.projects.find((p) => p.id === bootId)?.unregistered).toBe(true);
      expect(snapshot.coverage.projects.map((p) => p.projectId)).toEqual(
        otherId ? [bootId, otherId] : [bootId],
      );
      const costs = dashboardCostsSchema.parse(await (await get('/costs')).json());
      expect(costs.totals.tasks).toBe(3);
      expect(costs.tasks.rows.every((row) => row.projectId === bootId)).toBe(true);
      const feed = dashboardFeedSchema.parse(await (await get('/feed?filter=tasks')).json());
      expect(
        feed.rows.some(
          (row) =>
            row.kind === 'task-result' &&
            row.run.id === result.id &&
            row.run.projectId === bootId,
        ),
      ).toBe(true);
      const telemetry = dashboardTelemetrySchema.parse(await (await get('/telemetry')).json());
      expect(telemetry.samples).toEqual([
        {
          projectId: bootId,
          runId: running.id,
          sampledAt,
          cpuPct: 1,
          rssBytes: 42,
          procCount: 1,
        },
      ]);
      const previous = process.env.CEZ_SINGLE_PROJECT;
      process.env.CEZ_SINGLE_PROJECT = '1';
      try {
        const single = dashboardSnapshotSchema.parse(await (await get('')).json());
        expect(single.coverage.projects.map((p) => p.projectId)).toEqual([bootId]);
        expect(single.counts.questions).toBe(1);
        expect(
          dashboardTelemetrySchema.parse(await (await get('/telemetry')).json()).samples,
        ).toHaveLength(1);
      } finally {
        if (previous === undefined) delete process.env.CEZ_SINGLE_PROJECT;
        else process.env.CEZ_SINGLE_PROJECT = previous;
      }
      expect(contexts.ids()).toEqual([]);
      expect((await listProjects()).map((p) => p.id)).toEqual(otherId ? [otherId] : []);
    },
  );
  it('reads cold projects without opening contexts and restricts aggregation in single-project mode', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cez-dashboard-boot-'));
    const cold = mkdtempSync(join(tmpdir(), 'cez-dashboard-cold-'));
    dirs.push(root, cold);
    const store = RunStore.open(join(root, '.ai/cezar'));
    stores.push(store);
    const boot = await registerProject(root);
    const other = await registerProject(cold);
    mkdirSync(join(cold, '.ai/cezar'), { recursive: true });
    writeFileSync(
      join(cold, '.ai/cezar/runs.json'),
      JSON.stringify([
        {
          id: 'cold-review',
          title: 'Cold review',
          task: 't',
          workflow: 'build',
          status: 'review',
          createdAt: '2026-09-18T00:00:00Z',
          tokensUsed: 0,
          archived: false,
          steps: [],
        },
      ]),
    );
    const contexts = new ProjectContexts({ listProjects });
    cleanups.push(() => contexts.disposeAll());
    const app = createApp({
      repoRoot: root,
      store,
      manager: {} as RunManager,
      version: 'test',
      bootProjectId: boot.id,
      contexts,
      onDispose: (cleanup) => cleanups.push(cleanup),
    });
    const all = dashboardSnapshotSchema.parse(
      await (await apiRequest(app, '/api/v1/workspace/dashboard')).json(),
    );
    expect(
      all.reviews.rows.some((r) => r.projectId === other.id && r.id === 'cold-review'),
    ).toBe(true);
    const costs = dashboardCostsSchema.parse(
      await (await apiRequest(app, '/api/v1/workspace/dashboard/costs')).json(),
    );
    expect(costs.tasks.rows.some((row) => row.id === 'cold-review')).toBe(true);
    expect(contexts.ids()).toEqual([]);
    const previous = process.env.CEZ_SINGLE_PROJECT;
    process.env.CEZ_SINGLE_PROJECT = '1';
    try {
      const single = dashboardSnapshotSchema.parse(
        await (await apiRequest(app, '/api/v1/workspace/dashboard')).json(),
      );
      expect(single.coverage.projects.map((p) => p.projectId)).toEqual([boot.id]);
      expect(single.counts.reviews).toBe(0);
      expect(contexts.ids()).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.CEZ_SINGLE_PROJECT;
      else process.env.CEZ_SINGLE_PROJECT = previous;
    }
  });
  it('chains real routes, validates paging, and returns exactly contract JSON', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cez-dashboard-api-'));
    dirs.push(root);
    const store = RunStore.open(join(root, '.ai/cezar'));
    stores.push(store);
    await registerProject(root);
    const run = store.createRun({ title: 'Question', task: 't', workflow: 'build', steps: [] });
    store.updateRun(run.id, { status: 'waiting' });
    const app = createApp({
      repoRoot: root,
      store,
      manager: {} as RunManager,
      version: 'test',
      onDispose: (cleanup) => cleanups.push(cleanup),
    });
    const get = (path: string) => apiRequest(app, `/api/v1/workspace/dashboard${path}`);
    const response = await get('');
    expect(response.status).toBe(200);
    const snapshotJson = await response.json();
    const snapshot = dashboardSnapshotSchema.parse(snapshotJson);
    expect(snapshot).toEqual(snapshotJson);
    const pageJson = await (
      await get(`/tasks?snapshotId=${snapshot.snapshotId}&group=questions`)
    ).json();
    const page = dashboardTasksPageSchema.parse(pageJson);
    expect(page).toEqual(pageJson);
    expect(page.page.rows[0]?.id).toBe(run.id);
    expect((await get('/tasks?group=questions')).status).toBe(400);
    expect(
      (await get(`/tasks?snapshotId=${snapshot.snapshotId}&group=questions&limit=21`)).status,
    ).toBe(400);
    const expired = await get('/tasks?snapshotId=missing&group=questions');
    expect(expired.status).toBe(409);
    expect(await expired.json()).toEqual({
      error: 'Dashboard changed; refresh the list',
      code: 'snapshot-expired',
    });
    const telemetry = await (await get('/telemetry')).json();
    expect(dashboardTelemetrySchema.parse(telemetry)).toEqual(telemetry);
    const feed = await (await get('/feed?filter=tasks')).json();
    expect(dashboardFeedSchema.parse(feed)).toEqual(feed);
    expect((await get('/feed?filter=nope')).status).toBe(400);
    expect((await apiRequest(app, '/api/v1/p/default/workspace/dashboard')).status).toBe(404);
  });
});
