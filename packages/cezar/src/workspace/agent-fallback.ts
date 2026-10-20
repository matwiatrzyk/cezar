import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { agentFallbackPolicyPath } from '../paths.ts';
import { atomicWriteJsonSync } from './config.ts';
export type AgentFallbackCandidate = { provider: string; profileId: string; model?: string };
export type AgentFallbackPolicy = {
  enabled: boolean; candidates: AgentFallbackCandidate[]; revision: number;
  incarnation: string | null; revocation: string | null;
};

const candidate = z.object({
  provider: z.string().max(32),
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

async function load(): Promise<Store> {
  try {
    const raw = await readFile(agentFallbackPolicyPath(), 'utf8');
    const parsed = store.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : { version: 1, projects: {} };
  } catch { return { version: 1, projects: {} }; }
}

function loadSync(): Store {
  try {
    const parsed = store.safeParse(JSON.parse(readFileSync(agentFallbackPolicyPath(), 'utf8')));
    return parsed.success ? parsed.data : { version: 1, projects: {} };
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
  const s = await load();
  const current = (s.projects[root] as AgentFallbackPolicy | undefined) ?? emptyPolicy();
  if (current.revision !== input.expectedRevision || current.incarnation !== input.expectedIncarnation) return { conflict: true };
  const next: AgentFallbackPolicy = {
    enabled: input.enabled && input.candidates.length > 0,
    candidates: input.candidates,
    revision: current.revision + 1,
    incarnation: current.incarnation ?? randomUUID(),
    revocation: input.enabled ? current.revocation : randomUUID(),
  };
  s.projects[root] = next;
  atomicWriteJsonSync(agentFallbackPolicyPath(), s);
  return next;
}

export function fallbackCandidates(policy: AgentFallbackPolicy, currentProvider: string): AgentFallbackCandidate[] {
  if (!policy.enabled) return [];
  return policy.candidates.filter((c) => c.provider !== currentProvider);
}
