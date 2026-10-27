import type { TelegramConnectResponse } from '@open-mercato/cezar-contract';
import { BotOwnershipError, botDirectory, unboundBotRead, type BotLease } from './ownership.ts';
interface Owner { project: string; lease: BotLease; read(code: string): Promise<TelegramConnectResponse> }
const owners = new Map<string, Owner>();

/** Registration lasts through backoff and is removed only after the poller has stopped. */
export function registerConnectOwner(botId: string, project: string, dryRun: boolean, lease: BotLease, read: Owner['read']): () => void {
  lease.assertOwner();
  const key = botDirectory(botId, dryRun);
  if (owners.has(key)) throw new BotOwnershipError('owner_conflict');
  const owner = { project, lease, read }; owners.set(key, owner);
  return () => { if (owners.get(key) === owner) owners.delete(key); };
}
export async function arbitrateConnect(botId: string, project: string | undefined, dryRun: boolean, code: string, read: () => Promise<TelegramConnectResponse>): Promise<TelegramConnectResponse> {
  const owner = owners.get(botDirectory(botId, dryRun));
  if (owner) {
    owner.lease.assertOwner();
    if (owner.project !== project) throw new BotOwnershipError('owner_conflict');
    return owner.read(code);
  }
  return unboundBotRead(botId, dryRun, read);
}
