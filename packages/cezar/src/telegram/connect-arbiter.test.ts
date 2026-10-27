import { describe, expect, it } from 'vitest';
import { randomInt } from 'node:crypto';
import { arbitrateConnect, registerConnectOwner } from './connect-arbiter.ts';
import { BotLease } from './ownership.ts';
const result = { bot: { username: 'test_bot', name: 'Test' }, chats: [] };
describe('Connect and inbound share a bot consumer', () => {
  it('uses active project owner even when it is in backoff without calling getUpdates', async () => {
    const id = String(randomInt(100000, 99999999)), lease = await BotLease.acquire(id);
    const unregister = registerConnectOwner(id, '/project', false, lease, async code => ({ ...result, bot: { ...result.bot, name: code } }));
    try {
      let reads = 0;
      const reply = await arbitrateConnect(id, '/project', false, 'code', async () => { reads++; return result; });
      expect(reply.bot.name).toBe('code'); expect(reads).toBe(0);
      await expect(arbitrateConnect(id, '/other', false, 'code', async () => result)).rejects.toThrow('owner_conflict');
    } finally { unregister(); await lease.release(); }
  });
  it('refuses inactive durable bindings regardless of whether inbound is enabled', async () => {
    const id = String(randomInt(100000, 99999999)), lease = await BotLease.acquire(id);
    await lease.bind({ projectId: 'project', installationId: 'installation', root: '/project' }); await lease.release();
    let reads = 0;
    await expect(arbitrateConnect(id, '/project', false, 'code', async () => { reads++; return result; })).rejects.toThrow('binding_conflict');
    expect(reads).toBe(0);
  });
  it('serializes legacy Connect and releases the lock on failure', async () => {
    const id = String(randomInt(100000, 99999999));
    await expect(arbitrateConnect(id, undefined, false, 'code', async () => {
      await expect(BotLease.acquire(id)).rejects.toThrow('owner_conflict'); throw new Error('network');
    })).rejects.toThrow('network');
    expect(await arbitrateConnect(id, undefined, false, 'code', async () => result)).toEqual(result);
  });
});
