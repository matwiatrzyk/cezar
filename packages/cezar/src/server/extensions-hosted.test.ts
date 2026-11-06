import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';

/** Installing, enabling or running extension code is a local-machine capability: a hosted
 *  cockpit (`CEZ_REMOTE`) must 409 every route that would execute plugin code on the host. */
describe('extension routes in hosted mode', () => {
  let repoRoot: string;
  let store: RunStore;
  let app: Hono;
  const prevRemote = process.env.CEZ_REMOTE;

  beforeEach(() => {
    delete process.env.CEZ_REMOTE;
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-ext-hosted-'));
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    const ext = join(repoRoot, 'probe-ext');
    mkdirSync(ext);
    writeFileSync(join(ext, 'package.json'), JSON.stringify({ name: 'probe-ext', version: '1.0.0', type: 'module' }));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    app = createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test' });
  });
  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    if (prevRemote === undefined) delete process.env.CEZ_REMOTE;
    else process.env.CEZ_REMOTE = prevRemote;
  });

  const post = (path: string, body: unknown = {}) => apiRequest(app, path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });

  it('refuses install, update, uninstall, enable and invocation with 409', async () => {
    process.env.CEZ_REMOTE = '1';
    const responses = await Promise.all([
      post('/api/v1/extensions/prepare-install', { source: './probe-ext' }),
      post('/api/v1/extensions/commit-install', { preparedId: 'x' }),
      post('/api/v1/extensions/probe/prepare-update'),
      apiRequest(app, '/api/v1/extensions/probe', { method: 'DELETE' }),
      post('/api/v1/extensions/probe/enable', {}),
      post('/api/v1/extensions/probe/commands/run/invoke', {}),
      post('/api/v1/extensions/probe/actions', { actionId: 'run' }),
      apiRequest(app, '/api/v1/extensions/probe/panels/main'),
    ]);
    expect(responses.map(r => r.status)).toEqual(Array(responses.length).fill(409));
  });

  it('still answers the read-only listing in hosted mode', async () => {
    process.env.CEZ_REMOTE = '1';
    expect((await apiRequest(app, '/api/v1/extensions')).status).toBe(200);
    expect((await apiRequest(app, '/api/v1/extensions/access')).status).toBe(200);
  });

  it('lets a local cockpit reach the installer', async () => {
    const res = await post('/api/v1/extensions/prepare-install', { source: './probe-ext' });
    expect(res.status).not.toBe(409);
  });
});

describe('CEZ_EXTENSIONS=0', () => {
  it('turns extension execution off on a local cockpit, keeping the listing readable', async () => {
    const { extensionsUnavailableReason } = await import('./extensions.ts');
    expect(extensionsUnavailableReason({ CEZ_EXTENSIONS: '0' }, true)).toMatch(/CEZ_EXTENSIONS=0/);
    expect(extensionsUnavailableReason({}, false)).toMatch(/hosted/);
    expect(extensionsUnavailableReason({}, true)).toBeUndefined();
  });
});

describe('extension chat routes', () => {
  it('answer a malformed extension id with 400, not a provider outage', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cez-ext-chat-'));
    mkdirSync(join(root, '.ai/cezar'), { recursive: true });
    const runs = RunStore.open(join(root, '.ai/cezar'));
    const server = createApp({ repoRoot: root, store: runs, manager: {} as RunManager, version: '0.0.0-test' });
    try {
      const res = await apiRequest(server, '/api/v1/extensions/BAD!/chat/x');
      expect(res.status).toBe(400);
    } finally { runs.flush(); rmSync(root, { recursive: true, force: true }); }
  });
});
