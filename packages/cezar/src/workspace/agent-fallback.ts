import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { readFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { agentFallbackPolicyPath } from '../paths.ts';
import { atomicWriteJsonSync } from './config.ts';
import { PROVIDER_IDS } from '../core/provider-auth.ts';
export type AgentFallbackCandidate = { provider: string; profileId: string; model?: string };
export type AgentFallbackPolicy = {
  enabled: boolean; candidates: AgentFallbackCandidate[]; revision: number;
  incarnation: string | null; revocation: string | null;
};

const candidate = z.object({
  provider: z.enum(PROVIDER_IDS),
  profileId: z.string().max(64).default('default'),
  model: z.string().max(200).optional(),
}).passthrough();
const entry = z.object({
  enabled: z.boolean().catch(false),
  candidates: z.array(candidate).max(10).catch(() => []),
  revision: z.number().int().nonnegative().catch(0),
  incarnation: z.string().nullable().catch(null),
  revocation: z.string().nullable().catch(null),
}).passthrough();
const store = z.object({ version: z.number().int().default(1).catch(1), projects: z.record(z.string(), entry).catch({}) }).passthrough();
type Store = z.infer<typeof store>;

const emptyPolicy = (): AgentFallbackPolicy => ({ enabled: false, candidates: [], revision: 0, incarnation: null, revocation: null });
const lockPath = () => `${agentFallbackPolicyPath()}.lock`;

function validateCandidates(candidates: AgentFallbackCandidate[]): AgentFallbackCandidate[] {
  const parsed = z.array(candidate).max(10).safeParse(candidates);
  if (!parsed.success) throw new Error('invalid fallback candidate');
  const seen = new Set<string>();
  for (const item of parsed.data) {
    const key = `${item.provider}:${item.profileId}`;
    if (seen.has(key)) throw new Error('duplicate fallback candidate');
    seen.add(key);
  }
  return parsed.data;
}

function acquireLock(): string {
  const path = lockPath();
  try {
    mkdirSync(path);
    const owner = `${process.pid}:${Date.now()}`;
    writeFileSync(`${path}/owner`, owner, { mode: 0o600 });
    return path;
  } catch {
    // Recover only a lock whose owner is demonstrably dead. An unknown or malformed owner is
    // deliberately left in place so concurrent writers never guess about ownership.
    try {
      const owner = readFileSync(`${path}/owner`, 'utf8').trim();
      const pid = Number(owner.split(':', 1)[0]);
      if (Number.isInteger(pid) && pid > 0) {
        try { process.kill(pid, 0); } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
            rmSync(path, { recursive: true, force: true });
            mkdirSync(path);
            writeFileSync(`${path}/owner`, `${process.pid}:${Date.now()}`, { mode: 0o600 });
            return path;
          }
        }
      }
    } catch { /* preserve an uncertain lock */ }
    throw new Error('fallback policy is being edited by another cezar process; retry later');
  }
}

function releaseLock(path: string): void { rmSync(path, { recursive: true, force: true }); }

async function load(): Promise<Store> {
  try {
    const raw = await readFile(agentFallbackPolicyPath(), 'utf8');
    const value = JSON.parse(raw) as Record<string, unknown>;
    const projects: Store['projects'] = {};
    const rows = value && typeof value.projects === 'object' && value.projects !== null ? value.projects as Record<string, unknown> : {};
    for (const [root, row] of Object.entries(rows)) {
      const parsed = entry.safeParse(row);
      if (parsed.success) projects[root] = parsed.data;
    }
    const parsed = store.safeParse({ ...value, projects });
    return parsed.success ? parsed.data : { version: 1, projects };
  } catch { return { version: 1, projects: {} }; }
}

function loadSync(): Store {
  try {
    const value = JSON.parse(readFileSync(agentFallbackPolicyPath(), 'utf8')) as Record<string, unknown>;
    const projects: Store['projects'] = {};
    const rows = value && typeof value.projects === 'object' && value.projects !== null ? value.projects as Record<string, unknown> : {};
    for (const [root, row] of Object.entries(rows)) {
      const parsed = entry.safeParse(row);
      if (parsed.success) projects[root] = parsed.data;
    }
    const parsed = store.safeParse({ ...value, projects });
    return parsed.success ? parsed.data : { version: 1, projects };
  } catch { return { version: 1, projects: {} }; }
}

export async function getAgentFallbackPolicy(root: string): Promise<AgentFallbackPolicy> {
  const s = await load();
  return (s.projects[root] as AgentFallbackPolicy | undefined) ?? emptyPolicy();
}

export function getAgentFallbackPolicySync(root: string): AgentFallbackPolicy {
  const s = loadSync();
  return (s.projects[root] as AgentFallbackPolicy | undefined) ?? emptyPolicy();
}

export async function putAgentFallbackPolicy(root: string, input: {
  expectedRevision: number; expectedIncarnation: string | null; enabled: boolean; candidates: AgentFallbackCandidate[];
}): Promise<AgentFallbackPolicy | { conflict: true }> {
  const lock = acquireLock();
  try {
    const s = await load();
    const current = (s.projects[root] as AgentFallbackPolicy | undefined) ?? emptyPolicy();
    if (current.revision !== input.expectedRevision || current.incarnation !== input.expectedIncarnation) return { conflict: true };
    const candidates = validateCandidates(input.candidates);
    if (input.enabled && candidates.length === 0) throw new Error('fallback policy requires at least one candidate');
    const next: AgentFallbackPolicy = {
      enabled: input.enabled && candidates.length > 0,
      candidates,
      revision: current.revision + 1,
      incarnation: input.enabled && !current.enabled ? randomUUID() : (current.incarnation ?? randomUUID()),
      revocation: input.enabled ? current.revocation : randomUUID(),
    };
    s.projects[root] = next as Store['projects'][string];
    atomicWriteJsonSync(agentFallbackPolicyPath(), s);
    return next;
  } finally { releaseLock(lock); }
}

export function fallbackCandidates(policy: AgentFallbackPolicy, currentProvider: string, attempted: string[] = []): AgentFallbackCandidate[] {
  if (!policy.enabled) return [];
  const used = new Set(attempted);
  // A different account of the same provider is a distinct fallback identity. The active
  // provider/account is recorded by the caller as an attempted identity when it must be skipped;
  // filtering by provider alone would make account failover impossible.
  return policy.candidates.filter((c) => !used.has(`${c.provider}:${c.profileId}`) && `${c.provider}:${c.profileId}` !== `${currentProvider}:default`);
}
