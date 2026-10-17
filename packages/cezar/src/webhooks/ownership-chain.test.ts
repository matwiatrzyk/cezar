import { hostname } from 'node:os';
import { mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The chain walk is exercised without an OS probe per link: a 64-link dead chain would otherwise
// cost one probe each (a cold PowerShell spawn on Windows) and make this test host-dependent.
vi.mock('./process-identity.ts', () => ({
  ownProcessIdentity: () => ({ pid: 4242, start: '1', boot: 'boot' }),
  processStarts: (pids: number[]) => new Map(pids.filter(pid => pid === 4242).map(pid => [pid, '1'])),
}));
import * as ownership from './ownership.ts';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

// A successor slot is named after the dead PREDECESSOR token and holds the CLAIMANT identity, so
// each link carries the next token; every identity here has a dead PID.
const token = (i: number) => `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`;
const dead = (holder: string) => ({ token: holder, pid: 2147483647, start: '1', boot: 'boot', host: hostname() });

describe('recovery chain bound', () => {
  it('reaps a chain of dead successor slots instead of wedging on the 64-link bound', async () => {
    const dir = mkdtempSync(join(realpathSync(tmpdir()), 'webhook-chain-')); dirs.push(dir);
    writeFileSync(join(dir, 'owner.lock'), JSON.stringify(dead(token(0))));
    for (let i = 0; i < 64; i++) writeFileSync(join(dir, `owner-next-${token(i)}.json`), JSON.stringify(dead(token(i + 1))));

    const owner = await ownership.acquireOwnership(dir);
    expect(owner?.recovered).toBe(true);
    expect(owner?.valid()).toBe(true);
    expect(readdirSync(dir).filter(name => name.startsWith('owner-next-'))).toEqual([]);
    await owner!.release();
  });
});
