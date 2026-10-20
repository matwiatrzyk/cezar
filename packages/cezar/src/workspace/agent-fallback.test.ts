import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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

  it('does not revisit a provider already consumed by the episode', async () => {
    const policy = await getAgentFallbackPolicy('/repo');
    expect(fallbackCandidates(policy, 'codex', ['claude:backup']).map((candidate) => candidate.provider)).toEqual([]);
  });

  it('treats another account of the same provider as a distinct candidate', async () => {
    const policy = {
      enabled: true,
      candidates: [
        { provider: 'claude', profileId: 'default' },
        { provider: 'claude', profileId: 'backup' },
      ],
      revision: 1,
      incarnation: 'inc',
      revocation: null,
    };
    expect(fallbackCandidates(policy, 'claude', [], 'default').map((candidate) => candidate.profileId)).toEqual(['backup']);
  });

  it('rejects duplicate provider/account entries', async () => {
    const policy = await getAgentFallbackPolicy('/repo');
    await expect(putAgentFallbackPolicy('/repo', {
      expectedRevision: policy.revision,
      expectedIncarnation: policy.incarnation,
      enabled: true,
      candidates: [{ provider: 'codex', profileId: 'default' }, { provider: 'codex', profileId: 'default' }],
    })).rejects.toThrow('duplicate fallback candidate');
  });

  it('rejects enabling an empty fallback list', async () => {
    const policy = await getAgentFallbackPolicy('/repo');
    await expect(putAgentFallbackPolicy('/repo', {
      expectedRevision: policy.revision,
      expectedIncarnation: policy.incarnation,
      enabled: true,
      candidates: [],
    })).rejects.toThrow('requires at least one candidate');
  });

  it('rotates the incarnation when fallback is re-enabled after revocation', async () => {
    const before = await getAgentFallbackPolicy('/repo');
    const disabled = await putAgentFallbackPolicy('/repo', {
      expectedRevision: before.revision,
      expectedIncarnation: before.incarnation,
      enabled: false,
      candidates: before.candidates,
    });
    expect('conflict' in disabled).toBe(false);
    if ('conflict' in disabled) return;
    const enabled = await putAgentFallbackPolicy('/repo', {
      expectedRevision: disabled.revision,
      expectedIncarnation: disabled.incarnation,
      enabled: true,
      candidates: [{ provider: 'codex', profileId: 'default' }],
    });
    expect('conflict' in enabled).toBe(false);
    if ('conflict' in enabled) return;
    expect(enabled.incarnation).not.toBe(disabled.incarnation);
  });

  it('salvages valid projects when another project entry is malformed', async () => {
    writeFileSync(join(root, 'agent-fallback.json'), JSON.stringify({
      version: 1,
      projects: {
        '/repo': { enabled: false, candidates: [], revision: 3, incarnation: 'inc', revocation: null },
        '/broken': { enabled: 'yes' },
      },
    }));
    const policy = await getAgentFallbackPolicy('/repo');
    expect(policy.revision).toBe(3);
    const saved = await putAgentFallbackPolicy('/repo', {
      expectedRevision: 3,
      expectedIncarnation: 'inc',
      enabled: false,
      candidates: [],
    });
    expect('conflict' in saved).toBe(false);
    const persisted = JSON.parse(readFileSync(join(root, 'agent-fallback.json'), 'utf8'));
    expect(persisted.projects['/repo']).toBeTruthy();
    expect(persisted.projects['/broken']).toMatchObject({ enabled: false, revision: 0 });
  });
});
