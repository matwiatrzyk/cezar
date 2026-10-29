import { expect, it, vi } from 'vitest';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomInt } from 'node:crypto';
import { BotLease, botDirectory } from './ownership.ts';
import { TelegramBindings } from './bindings.ts';
it('lists a live owner without acquiring its lease, then releases only an orphan with matching revision', async () => {
  const root = await mkdtemp(join(tmpdir(), 'telegram-binding-')), botId = String(randomInt(100000, 99999999));
  const lease = await BotLease.acquire(botId), binding = await lease.bind({ projectId: 'project', root, installationId: 'installation' });
  let projects = [{ id: 'project', root, status: 'ready' }];
  const service = new TelegramBindings({ mode: () => 'local', projects: async () => projects });
  vi.stubEnv('CEZ_WEBHOOKS', '1'); vi.stubEnv('CEZ_CHAT_INBOUND', '1');
  try {
    const before = await readdir(botDirectory(botId));
    const row = (await service.list()).bindings.find(item => item.botId === botId)!;
    expect(row).toMatchObject({ orphaned: false, projectId: 'project' });
    expect(JSON.stringify(row)).not.toContain(root); expect(await readdir(botDirectory(botId))).toEqual(before);
    projects = [];
    await expect(service.release(botId, row.inboundRevision)).rejects.toThrow('owner_conflict');
    await lease.release();
    await expect(service.release(botId, 'a'.repeat(64))).rejects.toMatchObject({ code: 'revision_conflict' });
    await service.release(botId, row.inboundRevision);
    const next = await BotLease.acquire(botId);
    try { expect(await next.binding()).toBeUndefined(); await expect(next.validate(binding)).rejects.toThrow('binding_missing'); }
    finally { await next.release(); }
  } finally { await lease.release(); await rm(root, { recursive: true, force: true }); vi.unstubAllEnvs(); }
});
it('rechecks project presence and gates mutation before touching ownership files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'telegram-binding-')), botId = String(randomInt(100000, 99999999));
  const lease = await BotLease.acquire(botId); await lease.bind({ projectId: 'project', root, installationId: 'installation' }); await lease.release();
  let projects: { id: string; root: string; status: string }[] = [];
  const service = new TelegramBindings({ mode: () => 'local', projects: async () => projects, visibleProject: () => 'project' });
  vi.stubEnv('CEZ_WEBHOOKS', '1'); vi.stubEnv('CEZ_CHAT_INBOUND', '1');
  try {
    const row = (await service.list()).bindings.find(item => item.botId === botId)!;
    projects = [{ id: 'project', root, status: 'ready' }];
    await expect(service.release(botId, row.inboundRevision)).rejects.toMatchObject({ code: 'project_present' });
    vi.stubEnv('CEZ_CHAT_INBOUND', '0');
    await expect(service.release(botId, row.inboundRevision)).rejects.toMatchObject({ code: 'flag_off' });
  } finally { await rm(root, { recursive: true, force: true }); vi.unstubAllEnvs(); }
});
it('diagnostics do not create a missing home or follow a symlinked binding file', async () => {
  const { symlink, writeFile } = await import('node:fs/promises');
  const { existsSync } = await import('node:fs');
  const outer = await mkdtemp(join(tmpdir(), 'telegram-binding-read-'));
  vi.stubEnv('CEZ_HOME', join(outer, 'absent-home')); vi.stubEnv('CEZ_WEBHOOKS', '1'); vi.stubEnv('CEZ_CHAT_INBOUND', '1');
  const service = new TelegramBindings({ mode: () => 'local', projects: async () => [] });
  try {
    expect(await service.list()).toEqual({ bindings: [], truncated: false });
    expect(existsSync(join(outer, 'absent-home'))).toBe(false);
    const botId = String(randomInt(100000, 99999999)), lease = await BotLease.acquire(botId);
    await lease.release();
    const target = join(outer, 'private.json'); await writeFile(target, JSON.stringify({ secret: 'must not read' }));
    await symlink(target, join(botDirectory(botId), 'binding.json'));
    expect(await service.list()).toEqual({ bindings: [], truncated: true });
  } finally { vi.unstubAllEnvs(); await rm(outer, { recursive: true, force: true }); }
});
it('lists no bindings while hosted or flag-off, even when one exists', async () => {
  const root = await mkdtemp(join(tmpdir(), 'telegram-binding-')), botId = String(randomInt(100000, 99999999));
  const lease = await BotLease.acquire(botId); await lease.bind({ projectId: 'project', root, installationId: 'installation' }); await lease.release();
  let mode: 'local' | 'hosted' = 'local';
  const service = new TelegramBindings({ mode: () => mode, projects: async () => [] });
  try {
    vi.stubEnv('CEZ_WEBHOOKS', '1'); vi.stubEnv('CEZ_CHAT_INBOUND', '1');
    expect((await service.list()).bindings.some(row => row.botId === botId)).toBe(true);
    mode = 'hosted'; expect(await service.list()).toEqual({ bindings: [], truncated: false });
    mode = 'local'; vi.stubEnv('CEZ_CHAT_INBOUND', '0'); expect(await service.list()).toEqual({ bindings: [], truncated: false });
    expect((await service.scan()).bindings.some(row => row.botId === botId)).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); vi.unstubAllEnvs(); }
});
