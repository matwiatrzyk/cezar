import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { adapterManifestWrites, writeAdapterManifests } from './artifacts.ts';
import { ADAPTER_KEYS, type ReleaseManifests } from './manifests.ts';
import { stampStableManifests } from './stable.ts';
import { stampManifests } from './snapshot.ts';

const repo = fileURLToPath(new URL('../../../../', import.meta.url));
const locations = {
  extensionSdk: 'packages/extension-sdk', telegram: 'packages/chat-plugins/telegram',
  slack: 'packages/chat-plugins/slack', discord: 'packages/chat-plugins/discord',
  contract: 'packages/contract', apiClient: 'packages/api-client', cezar: 'packages/cezar',
  alias: 'alias-cezar', runAlias: 'alias-cezar-run',
};

describe('released adapter tarballs', () => {
  it.each(['stable', 'snapshot'] as const)('%s preserves the npm installation version invariant in actual packed manifests', (channel) => {
    const root = mkdtempSync(join(tmpdir(), 'cezar-release-artifacts-'));
    try {
      const before = Object.fromEntries(Object.entries(locations).map(([key, dir]) =>
        [key, JSON.parse(readFileSync(join(repo, dir, 'package.json'), 'utf8'))])) as unknown as ReleaseManifests;
      const dirs = Object.fromEntries(Object.entries(locations).map(([key, dir]) => [key, join(root, dir)])) as Record<keyof ReleaseManifests, string>;
      for (const key of ADAPTER_KEYS) {
        mkdirSync(dirs[key], { recursive: true });
        writeFileSync(join(dirs[key], 'cezar-extension.json'), readFileSync(join(repo, locations[key], 'cezar-extension.json')));
      }
      const after = channel === 'stable' ? stampStableManifests(before, '0.99.0') : stampManifests(before, '0.99.0-pr77.5');
      writeAdapterManifests(adapterManifestWrites(dirs, before, after));
      for (const key of ADAPTER_KEYS) {
        writeFileSync(join(dirs[key], 'package.json'), JSON.stringify(after[key]));
        const output = execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', '--ignore-scripts', '--offline', '--json'],
          { cwd: dirs[key], encoding: 'utf8', timeout: 30_000, shell: process.platform === 'win32' });
        const filename = (JSON.parse(output) as Array<{ filename: string }>)[0]!.filename;
        const extract = (name: string) => JSON.parse(execFileSync('tar', ['-xOf', join(dirs[key], filename!), `package/${name}`], { encoding: 'utf8', timeout: 10_000 }));
        const pkg = extract('package.json');
        const extension = extract('cezar-extension.json');
        expect(extension.version).toBe(pkg.version);
        expect(pkg.version).toBe(channel === 'stable' ? before[key].version : `${before[key].version}-pr77.5`);
        expect(extension.id).toBe(`open-mercato.${key}`);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 120_000);
});
