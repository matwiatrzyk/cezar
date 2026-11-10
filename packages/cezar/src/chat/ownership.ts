import { z } from 'zod';
import type { ChatProviderId } from './provider.ts';
import { chatProviderIdSchema } from '@open-mercato/cezar-contract';
import { chmod, lstat, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { cezarHomeDir } from '../paths.ts';
import { acquireOwnership, OwnershipCleanupError, type WebhookOwnership } from '../webhooks/ownership.ts';
import { assertNoSymlink, atomicWrite, readState, statePath, syncDirectory } from '../webhooks/storage.ts';
import { bindingSchema, chatIdSchema, readInboundState, type BotBinding } from './state.ts';

export class BotOwnershipError extends Error {
  constructor(readonly code: 'owner_conflict' | 'binding_conflict' | 'binding_missing' | 'binding_changed') { super(code); }
}
const pendingCleanup = new Map<string, WebhookOwnership>();
export function botDirectory(botId: string, dryRun = false, provider: ChatProviderId = 'telegram'): string {
  if (!chatIdSchema.safeParse(botId).success || !/^[A-Za-z0-9][A-Za-z0-9_.:@-]*$/.test(botId)) throw new Error('Invalid bot ID');
  // Platform IDs are only unique within their provider. Keep the original path so
  // an older process holding its lease remains authoritative during upgrades.
  if (!chatProviderIdSchema.safeParse(provider).success) throw new Error('Invalid chat provider');
  // Qualified IDs must be one segment: telegram/dry-run must not share the
  // native Telegram dry-run directory. The schema excludes percent escapes;
  // encoding is collision-free and leaves every native path and lock unchanged.
  return join(cezarHomeDir(), 'chat', encodeURIComponent(provider), ...(dryRun ? ['dry-run'] : []), 'bots', botId);
}
type RecoveryEvidence = { directory: string; identity: Omit<BotBinding, 'generation'> };
const recoverySchema = z.strictObject({ provider: chatProviderIdSchema, binding: bindingSchema });
const sameIdentity = (a: Omit<BotBinding, 'generation'>, b: Omit<BotBinding, 'generation'>) =>
  a.projectId === b.projectId && a.root === b.root && a.installationId === b.installationId;
const sameBinding = (a: BotBinding, b: BotBinding) => sameIdentity(a, b) && a.generation === b.generation;
async function releaseOwner(path: string, owner: WebhookOwnership): Promise<void> {
  try { await owner.release(); pendingCleanup.delete(path); }
  catch (error) { pendingCleanup.set(path, owner); throw error; }
}
async function acquireOwner(path: string): Promise<WebhookOwnership> {
  const cleanup = pendingCleanup.get(path);
  if (cleanup) await releaseOwner(path, cleanup);
  let owner;
  try { owner = await acquireOwnership(path); }
  catch (error) {
    if (error instanceof OwnershipCleanupError) pendingCleanup.set(path, error.ownership);
    throw error;
  }
  if (!owner) throw new BotOwnershipError('owner_conflict');
  return owner;
}
async function recoveryEvidence(global: string, botId: string, provider: ChatProviderId, evidence: RecoveryEvidence) {
  const binding = await readState(global, 'binding.json', bindingSchema);
  const recovered = await readState(global, 'interim-recovery.json', recoverySchema);
  assertNoSymlink(evidence.directory);
  const saved = await readInboundState(evidence.directory, botId).catch(error => {
    // Once attribution exists, damaged project state uses the ordinary explicit
    // reset path. It cannot change the recorded provider/project attribution.
    if (recovered) return undefined;
    throw error;
  });
  if (!binding || !sameIdentity(binding, evidence.identity)
    || (saved && (saved.botId !== botId || saved.provider !== provider || !sameIdentity(saved.binding, evidence.identity)))) throw new BotOwnershipError('binding_conflict');
  if (recovered) {
    if (recovered.provider !== provider || !sameBinding(recovered.binding, binding)) throw new BotOwnershipError('binding_conflict');
  } else if (!saved || !sameBinding(saved.binding, binding)) throw new BotOwnershipError('binding_conflict');
  return { binding, recovered, saved };
}
/** Passive discovery only; acquisition repeats all evidence checks under both locks. */
export async function readInterimBinding(botId: string, dryRun: boolean, provider: ChatProviderId, evidence: RecoveryEvidence): Promise<BotBinding | undefined> {
  botDirectory(botId, dryRun, provider); // validate both identifiers before constructing paths
  const global = join(cezarHomeDir(), 'chat', ...(dryRun ? ['dry-run'] : []), 'bots', botId);
  assertNoSymlink(global);
  const found = await recoveryEvidence(global, botId, provider, evidence);
  return !found.recovered && found.saved ? found.binding : undefined;
}
export class BotLease {
  private verifiedAt = -Infinity;
  private constructor(readonly directory: string, private readonly owner: WebhookOwnership, private readonly now: () => number = performance.now.bind(performance)) {}
  static async acquire(botId: string, dryRun = false, provider: ChatProviderId = 'telegram', evidence?: RecoveryEvidence): Promise<BotLease> {
    const path = botDirectory(botId, dryRun, provider); assertNoSymlink(path);
    const global = join(cezarHomeDir(), 'chat', ...(dryRun ? ['dry-run'] : []), 'bots', botId);
    assertNoSymlink(global);
    const interim = await lstat(global).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; });
    if (interim && (!evidence || !interim.isDirectory())) throw new BotOwnershipError('binding_conflict');
    if (!interim) {
      await mkdir(path, { recursive: true, mode: 0o700 }); await chmod(path, 0o700);
      return new BotLease(path, await acquireOwner(path));
    }
    // Never infer a provider from the bot ID. Before taking either lease, require
    // full project/provider state, or the attribution recorded by an earlier
    // evidence-verified recovery. Repeat the reads under BOTH ownership fences.
    const verify = () => recoveryEvidence(global, botId, provider, evidence!);
    await verify();
    const oldOwner = await acquireOwner(global);
    let owner: WebhookOwnership | undefined;
    try {
      await mkdir(path, { recursive: true, mode: 0o700 }); await chmod(path, 0o700);
      owner = await acquireOwner(path);
      const canonicalOwner = owner;
      const both: WebhookOwnership = {
        recovered: oldOwner.recovered || canonicalOwner.recovered, identity: canonicalOwner.identity,
        valid: () => oldOwner.valid() && canonicalOwner.valid(),
        // Keep the old-layout fence until canonical ownership has been released.
        release: async () => { await releaseOwner(path, canonicalOwner); await releaseOwner(global, oldOwner); },
      };
      const lease = new BotLease(path, both);
      lease.assertOwner();
      const { binding, recovered, saved } = await verify();
      const canonical = await lease.binding();
      if (canonical && (!sameIdentity(canonical, evidence!.identity) || (saved && !sameBinding(canonical, saved.binding)))) throw new BotOwnershipError('binding_conflict');
      if (!recovered) {
        if (canonical && !sameBinding(canonical, binding)) throw new BotOwnershipError('binding_conflict');
        if (!canonical) { lease.assertOwner(); await atomicWrite(path, 'binding.json', binding); }
        lease.assertOwner(); await atomicWrite(global, 'interim-recovery.json', { provider, binding });
      }
      // The original binding, state, vault and cursor are never moved or rewritten.
      lease.assertOwner(); return lease;
    } catch (error) {
      try { if (owner) await releaseOwner(path, owner); }
      catch (cleanupError) { pendingCleanup.set(global, oldOwner); throw cleanupError; }
      await releaseOwner(global, oldOwner);
      throw error;
    }
  }
  /** Durable writes and decisions: always re-reads owner.lock. */
  assertOwner(): void {
    if (!this.owner.valid()) { this.verifiedAt = -Infinity; throw new BotOwnershipError('owner_conflict'); }
    this.verifiedAt = this.now();
  }
  /** Hot read paths (budget lookup, readiness): a success is reused for up to one second. */
  assertOwnerCached(): void { if (this.now() - this.verifiedAt >= 1000) this.assertOwner(); }
  async binding(): Promise<BotBinding | undefined> {
    this.assertOwner();
    const binding = await readState(this.directory, 'binding.json', bindingSchema);
    this.assertOwner(); return binding;
  }
  async bind(identity: Omit<BotBinding, 'generation'>, generation: string = randomUUID()): Promise<BotBinding> {
    const current = await this.binding();
    if (current) {
      if (current.projectId !== identity.projectId || current.root !== identity.root || current.installationId !== identity.installationId) throw new BotOwnershipError('binding_conflict');
      return current;
    }
    const next = bindingSchema.parse({ ...identity, generation });
    this.assertOwner(); await atomicWrite(this.directory, 'binding.json', next); this.assertOwner();
    return next;
  }
  async validate(expected: BotBinding): Promise<void> {
    const current = await this.binding();
    if (!current) throw new BotOwnershipError('binding_missing');
    if (current.generation !== expected.generation || current.projectId !== expected.projectId
      || current.root !== expected.root || current.installationId !== expected.installationId) throw new BotOwnershipError('binding_changed');
  }
  async disconnect(expected: BotBinding): Promise<void> {
    await this.validate(expected);
    this.assertOwner(); await rm(statePath(this.directory, 'binding.json')); await syncDirectory(this.directory);
  }
  async release(): Promise<void> {
    try { await this.owner.release(); pendingCleanup.delete(this.directory); }
    catch (error) { pendingCleanup.set(this.directory, this.owner); throw error; }
  }
}
