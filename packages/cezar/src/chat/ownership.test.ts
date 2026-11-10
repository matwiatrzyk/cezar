import { describe, expect, it, vi } from 'vitest';
import { randomInt, randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BotLease, botDirectory } from './ownership.ts';

const identity = { projectId: 'project', installationId: 'instance', root: '/repo' };
const botId = () => String(randomInt(1_000_000, 999_999_999));
describe('Telegram bot ownership', () => {
  it('keeps a binding after release and refuses a second project', async () => {
    const id = botId(), first = await BotLease.acquire(id);
    const binding = await first.bind(identity);
    await first.release();
    const second = await BotLease.acquire(id);
    try {
      expect(await second.bind(identity)).toEqual(binding);
      await expect(second.bind({ ...identity, projectId: 'other' })).rejects.toThrow('binding_conflict');
    } finally { await second.release(); }
  });
  it('prevents a second consumer while the first owns even an unbound bot', async () => {
    const id = botId(), lease = await BotLease.acquire(id);
    try { await expect(BotLease.acquire(id)).rejects.toThrow('owner_conflict'); }
    finally { await lease.release(); }
    const next = await BotLease.acquire(id); await next.release();
  });
  it('reassignment invalidates the old generation and dry-run does not occupy a real bot', async () => {
    const id = botId(), lease = await BotLease.acquire(id);
    const binding = await lease.bind(identity);
    const dry = await BotLease.acquire(id, true);
    await dry.release();
    expect(botDirectory(id, true)).not.toBe(botDirectory(id));
    await lease.disconnect(binding);
    const replacement = await lease.bind(identity);
    expect(replacement.generation).not.toBe(binding.generation);
    await expect(lease.validate(binding)).rejects.toThrow('binding_changed');
    await lease.release();
  });
});
it('reuses a verified owner check on hot read paths but never for writes', async () => {
  const id = botId(), lease = await BotLease.acquire(id);
  try {
    const valid = vi.spyOn((lease as unknown as { owner: { valid(): boolean } }).owner, 'valid');
    lease.assertOwner(); lease.assertOwnerCached(); lease.assertOwnerCached();
    expect(valid).toHaveBeenCalledTimes(1);
    lease.assertOwner(); expect(valid).toHaveBeenCalledTimes(2);
    valid.mockReturnValue(false);
    expect(() => lease.assertOwner()).toThrow('owner_conflict');
    expect(() => lease.assertOwnerCached()).toThrow('owner_conflict');
  } finally { vi.restoreAllMocks(); await lease.release(); }
});
describe('bot directory', () => {
  // S1: the provider is the one path segment a route parameter can reach.
  it.each(['../evil', '../../evil/x', 'acme/../../x', '/abs', 'acme/chat/extra', 'Acme/chat', '', '..', 'acme\\chat'])('rejects provider %j', provider => {
    expect(() => botDirectory('123', false, provider)).toThrow('Invalid chat provider');
  });
  it.each(['telegram', 'slack', 'discord', 'acme/chat', 'acme.tools/chat-x'])('keeps provider-scoped paths for %j', provider => {
    expect(botDirectory('123', false, provider)).toMatch(new RegExp(`chat/${encodeURIComponent(provider)}/bots/123$`));
  });
});
it('allows unrelated providers with the same bot ID', async () => {
  const id = botId(), lease = await BotLease.acquire(id, false, 'telegram');
  try { const other = await BotLease.acquire(id, false, 'slack'); await other.release(); }
  finally { await lease.release(); }
});
it('retains the existing provider-scoped binding and lock location', async () => {
  const home = await mkdtemp(join(tmpdir(), 'chat-ownership-migration-'));
  const id = botId();
  vi.stubEnv('CEZ_HOME', home);
  const legacy = join(home, 'chat', 'telegram', 'bots', id);
  await mkdir(legacy, { recursive: true });
  await writeFile(join(legacy, 'binding.json'), JSON.stringify({ ...identity, generation: randomUUID() }));
  const lease = await BotLease.acquire(id, false, 'telegram');
  try {
    await expect(lease.binding()).resolves.toMatchObject(identity);
    expect(lease.directory).toBe(legacy);
    await expect(access(legacy)).resolves.toBeUndefined();
    await expect(access(botDirectory(id))).resolves.toBeUndefined();
  } finally {
    await lease.release();
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  }
});
it('keeps the provider lease exclusive across processes', async () => {
  const { spawnSync } = await import('node:child_process');
  const home = await mkdtemp(join(tmpdir(), 'chat-owner-process-'));
  vi.stubEnv('CEZ_HOME', home);
  const lease = await BotLease.acquire('123', false, 'telegram');
  try {
    const source = new URL('./ownership.ts', import.meta.url).href;
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
      `import { BotLease } from ${JSON.stringify(source)};
       try { const lease = await BotLease.acquire('123', false, 'telegram'); await lease.release(); process.exitCode = 1; }
       catch (error) { if (error.code !== 'owner_conflict') throw error; }
       const other = await BotLease.acquire('123', false, 'discord'); await other.release();`],
    { encoding: 'utf8', timeout: 5000 });
    expect(child.error).toBeUndefined(); expect(child.stderr).toBe(''); expect(child.status).toBe(0);
    expect(() => lease.assertOwner()).not.toThrow();
  } finally { await lease.release(); vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }); }
});
it.each([false, true])('fails closed on ambiguous global binding storage without moving or rewriting it (dry run %s)', async dryRun => {
  const { readFile, readdir } = await import('node:fs/promises');
  const { ChatBindings } = await import('./bindings.ts');
  const home = await mkdtemp(join(tmpdir(), 'chat-ambiguous-owner-'));
  vi.stubEnv('CEZ_HOME', home);
  const global = join(home, 'chat', ...(dryRun ? ['dry-run'] : []), 'bots', '123');
  await mkdir(global, { recursive: true });
  const bytes = JSON.stringify({ ...identity, generation: randomUUID() });
  await writeFile(join(global, 'binding.json'), bytes);
  try {
    for (const provider of ['telegram', 'discord', 'acme/chat']) {
      const scan = new ChatBindings({ provider, dryRun, mode: () => 'local', projects: async () => [] });
      expect((await scan.scan()).bindings).toEqual([]);
      await expect(BotLease.acquire('123', dryRun, provider)).rejects.toThrow('binding_conflict');
      await expect(access(botDirectory('123', dryRun, provider))).rejects.toMatchObject({ code: 'ENOENT' });
    }
    expect(await readdir(global)).toEqual(['binding.json']);
    expect(await readFile(join(global, 'binding.json'), 'utf8')).toBe(bytes);
  } finally { vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }); }
});

describe('evidence-bound interim ownership recovery', () => {
  it.each([false, true])('retains the global binding and fences both layouts (dry run %s)', async dryRun => {
    const { readFile } = await import('node:fs/promises');
    const { freshState, inboundStateFilename } = await import('./state.ts');
    const { acquireOwnership } = await import('../webhooks/ownership.ts');
    const home = await mkdtemp(join(tmpdir(), 'chat-interim-recovery-'));
    vi.stubEnv('CEZ_HOME', home);
    const directory = join(home, 'project-state');
    const global = join(home, 'chat', ...(dryRun ? ['dry-run'] : []), 'bots', '123');
    const binding = { ...identity, generation: randomUUID() };
    await mkdir(directory); await mkdir(global, { recursive: true });
    const bytes = JSON.stringify(binding);
    await writeFile(join(global, 'binding.json'), bytes);
    await writeFile(join(directory, inboundStateFilename('123')), JSON.stringify(freshState('123', binding, 'telegram')));
    let lease: BotLease | undefined;
    try {
      const evidence = { directory, identity };
      // A bot ID alone, or another provider's state, never authorizes attribution.
      await expect(BotLease.acquire('123', dryRun, 'discord', evidence)).rejects.toThrow('binding_conflict');
      const old = await acquireOwnership(global); expect(old).toBeTruthy();
      await expect(BotLease.acquire('123', dryRun, 'telegram', evidence)).rejects.toThrow('owner_conflict');
      await old!.release();
      lease = await BotLease.acquire('123', dryRun, 'telegram', evidence);
      expect(await lease.binding()).toEqual(binding);
      expect(await acquireOwnership(global)).toBeUndefined();
      await expect(BotLease.acquire('123', dryRun, 'telegram', evidence)).rejects.toThrow('owner_conflict');
      expect(await readFile(join(global, 'binding.json'), 'utf8')).toBe(bytes);
      await lease.release(); lease = undefined;
      const statePath = join(directory, inboundStateFilename('123'));
      const savedBytes = await readFile(statePath);
      await writeFile(statePath, '{damaged');
      lease = await BotLease.acquire('123', dryRun, 'telegram', evidence);
      expect(await lease.binding()).toEqual(binding); // explicit reset remains reachable
      await writeFile(statePath, savedBytes);
      await lease.disconnect(binding); await lease.release(); lease = undefined;
      // An explicit disconnect may remove project state. The durable attribution
      // still permits the SAME project to pair again, retaining both lease fences.
      await rm(join(directory, inboundStateFilename('123')));
      lease = await BotLease.acquire('123', dryRun, 'telegram', evidence);
      const replacement = await lease.bind(identity);
      expect(replacement.generation).not.toBe(binding.generation);
      await lease.release(); lease = undefined;
      await expect(BotLease.acquire('123', dryRun, 'telegram', { directory, identity: { ...identity, projectId: 'other' } })).rejects.toThrow('binding_conflict');
      expect(await readFile(join(global, 'binding.json'), 'utf8')).toBe(bytes);
    } finally { await lease?.release(); vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }); }
  });
});
