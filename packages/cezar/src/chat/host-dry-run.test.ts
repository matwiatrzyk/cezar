import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { WebhookScheduler } from '../webhooks/scheduler.ts';
import { WebhookService } from '../webhooks/service.ts';
import { encodeSlackCredentials } from './providers/slack/identity.ts';
import type { ChatServiceDependencies } from './service.ts';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.unstubAllEnvs(); });
const credentials = {
 telegram: `123456:${'A'.repeat(35)}`,
 slack: encodeSlackCredentials({ appToken: 'xapp-synthetic12345', botToken: 'xoxb-synthetic12345' }),
 discord: `${'a'.repeat(24)}.${'b'.repeat(6)}.${'c'.repeat(27)}`,
};
// With no artifact registered there is no transport to fall back to (spec 2026-11-09).
it.each(['telegram', 'slack', 'discord'] as const)('a dry run answers blocked for %s instead of reaching a platform', async provider => {
 vi.stubEnv('CEZ_WEBHOOKS', '1');
 const root = await mkdtemp(join(tmpdir(), 'chat-dry-run-')); cleanups.push(() => rm(root, { recursive: true, force: true }));
 execFileSync('git', ['init', '-q'], { cwd: root, timeout: 5000 });
 const service = (await WebhookService.open({ root, dataDir: join(root, '.ai/cezar'), projectId: 'project', mode: 'local', serverPorts: () => [], scheduler: new WebhookScheduler(), dryRun: true }))!;
 cleanups.push(() => service.dispose());
 const { deps } = service[provider] as unknown as { deps: ChatServiceDependencies };
 await expect(deps.credentialTransport!(credentials[provider]).identify()).rejects.toMatchObject({ failure: { kind: 'blocked' } });
});
