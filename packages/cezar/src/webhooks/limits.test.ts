import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import * as module from './limits.ts';
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
describe('webhook persistent request limits', () => {
  it('persists the three-tests-per-host limit across restart and endpoint recreation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'webhook-limits-')); dirs.push(dir);
    const limits = await module.ProjectLimits.open(dir);
    for (let i = 0; i < 3; i++) expect(await limits.take({ host: 'example.com', test: true }, 100000)).toEqual({ allowed: true });
    const restored = await module.ProjectLimits.open(dir);
    expect(await restored.take({ host: 'example.com', test: true }, 100000)).toEqual({ allowed: false, retryAt: 160000 });
    expect(await restored.take({ host: 'other.example.com', test: true }, 100000)).toEqual({ allowed: true });
    expect(await restored.take({ host: 'example.com', test: true }, 160000)).toEqual({ allowed: true });
  });
  it('enforces project burst and manual failure rate for retries too', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'webhook-limits-')); dirs.push(dir);
    const limits = await module.ProjectLimits.open(dir);
    for (let i = 0; i < 10; i++) expect(await limits.take({ host: 'example.com', manualFailure: true }, 100000)).toEqual({ allowed: true });
    expect(await limits.take({ host: 'example.com' }, 100000)).toEqual({ allowed: false, retryAt: 100500 });
    expect(await limits.take({ host: 'example.com', manualFailure: true }, 101000)).toEqual({ allowed: false, retryAt: 160000 });
    expect(await limits.take({ host: 'example.com' }, 101000)).toEqual({ allowed: true });
  });
});
