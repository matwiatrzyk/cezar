import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as storage from './storage.ts';
const roots: string[] = [];
function project() { const root = mkdtempSync(join(tmpdir(), 'webhook-storage-')); roots.push(root); execFileSync('git', ['init', '-q'], { cwd: root }); return { root, dataDir: join(root, '.ai/cezar') }; }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
describe('private webhook storage', () => {
  it('cleans only orphan atomic writes and old bounded diagnostics under exclusive ownership', async () => {
    const { root, dataDir } = project(); const directory = await storage.prepareStorage(root, dataDir, false);
    mkdirSync(join(directory, 'events'));
    const stale = 'endpoints.json.00000000-0000-4000-8000-000000000001.tmp';
    writeFileSync(join(directory, stale), 'partial');
    writeFileSync(join(directory, 'events', stale), 'partial');
    writeFileSync(join(directory, 'outbox-tail-00000000-0000-4000-8000-000000000001.quarantine'), 'old');
    writeFileSync(join(directory, 'endpoints.json'), 'preserved');
    writeFileSync(join(directory, 'unrelated.tmp'), 'preserved');
    await storage.cleanupInterruptedWrites(directory);
    expect(existsSync(join(directory, stale))).toBe(false);
    expect(existsSync(join(directory, 'events', stale))).toBe(false);
    expect(readFileSync(join(directory, 'endpoints.json'), 'utf8')).toBe('preserved');
    expect(readFileSync(join(directory, 'unrelated.tmp'), 'utf8')).toBe('preserved');
  });
  it('enforces ignore protection and private permissions before creating state', async () => {
    const { root, dataDir } = project(); const directory = await storage.prepareStorage(root, dataDir, false);
    expect(directory).toBe(join(dataDir, 'webhooks'));
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(execFileSync('git', ['check-ignore', join(directory, 'endpoints.json')], { cwd: root, encoding: 'utf8' }).trim()).toBe(join(directory, 'endpoints.json'));
    await storage.atomicWrite(directory, 'endpoints.json', { receivers: [] });
    expect(statSync(join(directory, 'endpoints.json')).mode & 0o777).toBe(0o600);
  });
  it('refuses tracked private data instead of silently untracking it', async () => {
    const { root, dataDir } = project(); mkdirSync(join(dataDir, 'webhooks'), { recursive: true });
    writeFileSync(join(dataDir, 'webhooks/endpoints.json'), '{}');
    execFileSync('git', ['add', '-f', '.ai/cezar/webhooks/endpoints.json'], { cwd: root });
    await expect(storage.prepareStorage(root, dataDir, false)).rejects.toThrow('tracked');
  });
  it('rejects symlinked directories, files and path traversal', async () => {
    const { root, dataDir } = project(); mkdirSync(dataDir, { recursive: true });
    const foreign = join(root, 'foreign'); mkdirSync(foreign);
    symlinkSync(foreign, join(dataDir, 'webhooks'));
    await expect(storage.prepareStorage(root, dataDir, false)).rejects.toThrow('symlink');
    rmSync(join(dataDir, 'webhooks')); const directory = await storage.prepareStorage(root, dataDir, false);
    const victim = join(root, 'victim'); writeFileSync(victim, 'untouched'); symlinkSync(victim, join(directory, 'endpoints.json'));
    await expect(storage.atomicWrite(directory, 'endpoints.json', {})).rejects.toThrow('symlink');
    await expect(storage.atomicWrite(directory, '../victim', {})).rejects.toThrow('path');
    expect(readFileSync(victim, 'utf8')).toBe('untouched');
  });
  it('keeps dry-run writes separate and refuses corrupt state without overwriting it', async () => {
    const { root, dataDir } = project(); const directory = await storage.prepareStorage(root, dataDir, true);
    expect(directory).toBe(join(dataDir, 'webhooks/dry-run'));
    writeFileSync(join(directory, 'endpoints.json'), '{broken');
    await expect(storage.readState(directory, 'endpoints.json', z.object({ version: z.literal(1) }))).rejects.toThrow('Invalid');
    expect(readFileSync(join(directory, 'endpoints.json'), 'utf8')).toBe('{broken');
  });
});
