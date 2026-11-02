import { BotOwnershipError, botDirectory, type BotLease } from './ownership.ts';
import type { ConnectRead } from './connect-cache.ts';
interface Owner { project: string; lease: BotLease; read(code: string): Promise<ConnectRead> }
const owners = new Map<string, Owner>();

/** One in-process consumer per bot; registration lasts through backoff and ends after the poller stopped. */
export function registerConnectOwner(botId: string, project: string, dryRun: boolean, lease: BotLease, read: Owner['read']): () => void {
  lease.assertOwner();
  const key = botDirectory(botId, dryRun);
  if (owners.has(key)) throw new BotOwnershipError('owner_conflict');
  const owner = { project, lease, read }; owners.set(key, owner);
  return () => { if (owners.get(key) === owner) owners.delete(key); };
}
