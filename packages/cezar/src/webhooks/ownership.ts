import { constants, closeSync, fstatSync, linkSync, openSync, readFileSync, renameSync, unlinkSync } from 'node:fs';
import { open, readdir, rm } from 'node:fs/promises';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { webhookPlatformSupported, WEBHOOK_UNSUPPORTED_PLATFORM_MESSAGE } from './platform.ts';
import { statePath, syncDirectory } from './storage.ts';

const identitySchema = z.strictObject({ token: z.string().uuid(), pid: z.number().int().positive(), start: z.string().regex(/^\d+$/), boot: z.string().uuid(), host: z.string().min(1).max(255), directory: z.string().max(4096).optional() });
type Identity = z.infer<typeof identitySchema>;
function processStart(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    if (fields[0] === 'Z' || fields[0] === 'X') return undefined;
    if (!fields[19] || !/^\d+$/.test(fields[19])) throw new Error('Cannot verify process identity');
    return fields[19];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error('Cannot verify process identity');
  }
}
function ownIdentity(directory: string): Identity {
  if (!webhookPlatformSupported()) throw new Error(WEBHOOK_UNSUPPORTED_PLATFORM_MESSAGE);
  const start = processStart(process.pid);
  if (!start) throw new Error('Cannot verify process identity');
  return identitySchema.parse({ token: randomUUID(), directory, pid: process.pid, start, boot: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(), host: hostname() });
}
function readIdentity(directory: string, name: string): Identity | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(statePath(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
    if (fstatSync(fd).size > 2048) throw new Error('Owner too large');
    const raw = readFileSync(fd, 'utf8');
    if (raw.length > 2048) throw new Error('Owner too large');
    return identitySchema.parse(JSON.parse(raw));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error('Invalid webhook owner metadata');
  } finally { if (fd !== undefined) closeSync(fd); }
}
function alive(identity: Identity, own: Identity): boolean {
  if (identity.host !== own.host) throw new Error('Cannot verify foreign owner identity');
  if (identity.boot !== own.boot) return false;
  return processStart(identity.pid) === identity.start;
}
export interface WebhookOwnership { valid(): boolean; release(): Promise<void>; recovered: boolean }
/** Transfers failed acquisition cleanup into the caller's already-bounded reservation. */
export class OwnershipCleanupError extends Error {
  constructor(readonly ownership: WebhookOwnership, cause: unknown) {
    super('Webhook acquisition cleanup failed', { cause });
  }
}
/**
 * Each dead owner has one immutable successor slot, claimed with an exclusive hard link.
 * Contenders follow that slot rather than racing check/unlink on owner.lock. If recovery
 * itself crashes, its dead successor has its own slot. A live successor blocks contenders
 * before it publishes owner.lock by rename. No heartbeat age authorizes a takeover.
 */
export async function acquireOwnership(directory: string, copiedRoot = false): Promise<WebhookOwnership | undefined> {
  const own = ownIdentity(directory);
  const candidateName = `owner-record-${own.token}.json`;
  const candidate = statePath(directory, candidateName);
  const file = await open(candidate, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(JSON.stringify(own)); await file.sync(); } finally { await file.close(); }
  let acquired = false, recovered = false, handedOff = false;
  const owner: WebhookOwnership = {
    get recovered() { return recovered; },
    valid() {
      try { return readIdentity(directory, 'owner.lock')?.token === own.token && processStart(own.pid) === own.start; }
      catch { return false; }
    },
    async release() {
      // Missing or a verified replacement is safe to leave alone. Unreadable metadata
      // must throw so the caller retains this exact token for a later cleanup retry.
      if (readIdentity(directory, 'owner.lock')?.token === own.token) unlinkSync(statePath(directory, 'owner.lock'));
      await rm(candidate, { force: true }); await syncDirectory(directory);
    },
  };
  const ancestors = new Set<string>();
  try {
    try { linkSync(candidate, statePath(directory, 'owner.lock')); acquired = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    if (!acquired) {
      let previous = readIdentity(directory, 'owner.lock');
      if (!previous) return undefined; // A concurrent orderly release: retry on health recheck.
      for (let depth = 0; depth < 64; depth++) {
        if (!(copiedRoot && previous.directory !== directory) && alive(previous, own)) return undefined;
        ancestors.add(previous.token);
        const successorName = `owner-next-${previous.token}.json`;
        try {
          linkSync(candidate, statePath(directory, successorName));
          const current = readIdentity(directory, 'owner.lock');
          if (!current || !ancestors.has(current.token)) return undefined;
          // Current still belongs to the verified-dead chain; no yield before publication.
          const publication = statePath(directory, `owner-publication-${own.token}.tmp`);
          linkSync(candidate, publication);
          renameSync(publication, statePath(directory, 'owner.lock'));
          acquired = true; recovered = true; break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          const next = readIdentity(directory, successorName);
          if (!next) return undefined;
          previous = next;
        }
      }
      if (!acquired) throw new Error('Webhook owner recovery chain exceeds its bound');
    }
    await syncDirectory(directory);
    // Remove only verified-dead predecessor records, never another contender's candidate.
    for (const token of ancestors) {
      await rm(statePath(directory, `owner-record-${token}.json`), { force: true });
      await rm(statePath(directory, `owner-next-${token}.json`), { force: true });
    }
    // A crash before the first hard link can leave a candidate outside the predecessor chain.
    // Reap only provably dead identities; a live concurrent contender may still publish its link.
    for (const name of await readdir(directory)) {
      const match = /^owner-(?:record|publication)-([0-9a-f-]{36})\.(?:json|tmp)$/.exec(name);
      if (!match || match[1] === own.token) continue;
      const orphan = readIdentity(directory, name);
      if (orphan && orphan.token === match[1] && orphan.host === own.host && !alive(orphan, own)) {
        await rm(statePath(directory, name), { force: true });
      }
    }
    await syncDirectory(directory);
    handedOff = true;
    return owner;
  } finally {
    if (!handedOff) {
      // Never strand a live-PID owner when acquisition fails after publishing the link.
      if (acquired) {
        try { await owner.release(); }
        catch (error) { throw new OwnershipCleanupError(owner, error); }
      } else await rm(candidate, { force: true });
    }
  }
}
