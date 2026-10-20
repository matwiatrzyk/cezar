import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'cez-fallback-'));
process.env.CEZ_HOME = root;

import { fallbackCandidates, getAgentFallbackPolicy, putAgentFallbackPolicy } from './agent-fallback.ts';

describe('agent fallback policy', () => {
  it('starts disabled and persists an ordered project policy', async () => {
    const initial = await getAgentFallbackPolicy('/repo');
    expect(initial).toMatchObject({ enabled: false, candidates: [], revision: 0 });
    const saved = await putAgentFallbackPolicy('/repo', {
      expectedRevision: 0,
      expectedIncarnation: null,
      enabled: true,
      candidates: [
        { provider: 'codex', profileId: 'default' },
        { provider: 'claude', profileId: 'backup' },
      ],
    });
    expect('conflict' in saved).toBe(false);
    if ('conflict' in saved) return;
    expect(saved.candidates.map((candidate) => candidate.provider)).toEqual(['codex', 'claude']);
    expect(readFileSync(join(root, 'agent-fallback.json'), 'utf8')).toContain('/repo');
  });

  it('rejects stale writes and skips the active provider', async () => {
    const conflict = await putAgentFallbackPolicy('/repo', {
      expectedRevision: 0,
      expectedIncarnation: null,
      enabled: true,
      candidates: [{ provider: 'pi', profileId: 'default' }],
    });
    expect(conflict).toEqual({ conflict: true });
    const policy = await getAgentFallbackPolicy('/repo');
    expect(fallbackCandidates(policy, 'codex').map((candidate) => candidate.provider)).toEqual(['claude']);
  });
});
