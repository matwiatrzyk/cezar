import { expect, it } from 'vitest';
import { randomInt } from 'node:crypto';
import { registerConnectOwner } from './connect-arbiter.ts';
import { BotLease } from './ownership.ts';
it('allows one registered consumer per bot until it unregisters', async () => {
  const id = String(randomInt(100000, 99999999)), lease = await BotLease.acquire(id);
  const read = async () => ({ bot: { username: 'test_bot', name: 'Test' }, chats: [] });
  const unregister = registerConnectOwner(id, '/project', false, lease, read);
  try { expect(() => registerConnectOwner(id, '/project', false, lease, read)).toThrow('owner_conflict'); }
  finally { unregister(); }
  registerConnectOwner(id, '/project', false, lease, read)();
  await lease.release();
});
