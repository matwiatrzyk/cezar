import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager, StartRunInput } from '../workflows/run.ts';
import type { WorkflowDef } from '../workflows/types.ts';
import { createApp } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { connectedProviderAuth } from './provider-auth.testkit.ts';

/** `POST /api/v1/runs` `afterRunId` (task chains): forwarded to the engine, unknown ids refused. */
describe('POST /api/v1/runs afterRunId', () => {
  let repoRoot: string;
  let store: RunStore;
  let app: Hono;
  let inputs: StartRunInput[];

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-afterrun-'));
    const dataDir = join(repoRoot, '.ai/cezar');
    mkdirSync(dataDir, { recursive: true });
    store = RunStore.open(dataDir);
    inputs = [];
    const manager = {
      startRun: (_workflow: WorkflowDef, input: StartRunInput) => {
        inputs.push(input);
        return store.createRun({ title: 't', workflow: '(planned)', task: input.task, steps: [] });
      },
    } as unknown as RunManager;
    app = createApp({ repoRoot, store, manager, version: '0.0.0-test', providerAuth: connectedProviderAuth() });
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const post = (body: unknown) =>
    apiRequest(app, '/api/v1/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const base = { task: 'next in the series', steps: [{ id: 'work', prompt: '{{task}}' }] };

  it('hands a known predecessor to the engine', async () => {
    const previous = store.createRun({ title: 'A', workflow: 'quick-task', task: 'A', steps: [] });
    const res = await post({ ...base, afterRunId: previous.id });
    expect(res.status).toBe(201);
    expect(inputs[0]?.afterRunId).toBe(previous.id);
  });

  it('refuses a predecessor this project does not have, starting nothing', async () => {
    const res = await post({ ...base, afterRunId: 'no-such-run' });
    expect(res.status).toBe(400);
    expect(inputs).toHaveLength(0);
  });

  it('leaves an unchained start untouched', async () => {
    const res = await post(base);
    expect(res.status).toBe(201);
    expect(inputs[0]).not.toHaveProperty('afterRunId');
  });
});
