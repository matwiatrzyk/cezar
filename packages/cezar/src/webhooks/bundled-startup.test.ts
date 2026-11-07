import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { WebhookService } from './service.ts';
import { WebhookScheduler } from './scheduler.ts';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean(); vi.unstubAllEnvs(); });
type Gate = { bundledTransport(provider: 'slack' | 'discord', botId: string, receiverId: string, valid: () => boolean, compatibility: unknown): Promise<unknown> };

async function open(options: Record<string, unknown>) {
  const directory = await mkdtemp(join(tmpdir(), 'bundled-startup-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  vi.stubEnv('CEZ_HOME', join(directory, 'home')); vi.stubEnv('CEZ_WEBHOOKS', '1');
  execFileSync('git', ['init', '-q'], { cwd: directory, timeout: 5000 });
  const service = (await WebhookService.open({ root: directory, dataDir: join(directory, '.ai/cezar'), projectId: 'project', mode: 'local', serverPorts: () => [], scheduler: new WebhookScheduler(), ...options }))!;
  cleanups.push(() => service.dispose());
  return service as unknown as Gate;
}

// The compatibility owner stays for every case the design keeps in-process; no worker is spawned.
it.each([
  ['hosted mode', { mode: 'hosted' }, {}],
  ['CEZ_EXTENSIONS=0', {}, { CEZ_EXTENSIONS: '0' }],
  ['dry run (no network)', { dryRun: true }, {}],
  ['an injected Slack wire', { slackWire: () => ({}) }, {}],
  ['an injected chat transport', { chatTransport: () => ({}) }, {}],
] as const)('keeps the in-process adapter under %s', async (_name, options, env) => {
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  const service = await open(options);
  await expect(service.bundledTransport('slack', 'T1:U1', 'missing', () => true, {})).rejects.toThrow('bundled workers disabled');
});

it('keeps the in-process adapter when the catalog is absent', async () => {
  const empty = await mkdtemp(join(tmpdir(), 'bundled-none-'));
  cleanups.push(() => rm(empty, { recursive: true, force: true }));
  const service = await open({ bundledChat: { packageRoot: empty } });
  await expect(service.bundledTransport('discord', '1', 'missing', () => true, {})).rejects.toThrow('bundled worker unavailable');
});
