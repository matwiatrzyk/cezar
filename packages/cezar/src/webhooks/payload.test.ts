import { describe, expect, it, vi, afterEach } from 'vitest';
import * as payload from './payload.ts';
import type { WebhookSource } from './source.ts';
const source = (): WebhookSource => ({
  version: 1, id: 'evt_00000000-0000-4000-8000-000000000001', sequence: 1, installationId: 'inst_test', projectId: 'project', previousStatus: 'running',
  episodeId: 'task-1-1', type: 'task.attention_required', occurredAt: '2026-10-13T12:00:00Z', mode: 'local',
  snapshot: { id: 'task-1', status: 'waiting', archived: false, continuation: 0, title: 'Private title', titleOrigin: 'marker', attentionRequest: { requestId: 'question-1', askedAt: '2026-10-13T12:00:00Z', questions: [{ question: 'Private question' }] } },
});
afterEach(() => vi.unstubAllEnvs());
describe('outbound webhook payload minimization', () => {
  it('omits agent-authored title and question text from Minimal, allows user title', () => {
    const item = source(); const minimal = payload.renderPayload(item, 'minimal', []);
    expect(minimal).not.toContain('Private');
    item.snapshot.titleOrigin = 'user';
    expect(payload.renderPayload(item, 'minimal', [])).toContain('Private title');
    expect(payload.renderPayload(item, 'standard', [])).toContain('Private question');
  });
  it('redacts outbound source and body even when transcript redaction is off', () => {
    vi.stubEnv('CEZ_REDACT_SECRETS', '0');
    const item = source(); item.snapshot.title = 'confidential-secret-value';
    const redacted = payload.redactSource(item, ['confidential-secret-value']);
    expect(JSON.stringify(redacted)).not.toContain('confidential-secret-value');
    expect(payload.renderPayload(item, 'standard', ['confidential-secret-value'])).not.toContain('confidential-secret-value');
  });
  it('trims optional question content deterministically to 64KiB preserving required data', () => {
    const item = source(); item.snapshot.attentionRequest!.questions = Array.from({ length: 20 }, () => ({ question: '界'.repeat(2000), options: Array.from({ length: 10 }, () => ({ label: '界'.repeat(120), description: '界'.repeat(500) })) }));
    const body = payload.renderPayload(item, 'standard', []);
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(65536);
    expect(JSON.parse(body)).toMatchObject({ truncated: true, data: { episodeId: 'task-1-1', reason: 'question', requestId: 'question-1' } });
    expect(payload.renderPayload(item, 'standard', [])).toBe(body);
  });
  it('bounds the redacted Standard source before durable capture', () => {
    const item = source(); item.snapshot.attentionRequest!.questions = Array.from({ length: 20 }, () => ({ question: '界'.repeat(2000), options: Array.from({ length: 10 }, () => ({ label: '界'.repeat(120), description: '界'.repeat(500) })) }));
    const bounded = payload.redactSource(item, []);
    expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThan(65536);
    expect(JSON.parse(payload.renderPayload(bounded, 'standard', []))).toMatchObject({ truncated: true });
  });
  it('rebuilds links only for the configured project repository, strips query and rejects credentials', () => {
    expect(payload.canonicalGithubLink('https://github.com/acme/app/pull/12?secret=private#frag', 'acme/app', 'pull')).toBe('https://github.com/acme/app/pull/12');
    expect(payload.canonicalGithubLink('https://github.com/attacker/app/pull/12', 'acme/app', 'pull')).toBeUndefined();
    expect(payload.canonicalGithubLink('https://user@github.com/acme/app/pull/12', 'acme/app', 'pull')).toBeUndefined();
  });
  it('includes measured completion usage and uses a validated automation link as fallback', () => {
    const item = source(); item.type = 'task.finished'; item.snapshot.status = 'done';
    Object.assign(item.snapshot, { inputTokens: 120, outputTokens: 30, costUsd: 0.2, automationUrl: 'https://github.com/acme/app/issues/42?secret=drop', pullRequestUrl: 'https://github.com/foreign/repo/pull/1', referencedPullRequestUrl: 'https://github.com/acme/app/pull/3' });
    const event = JSON.parse(payload.renderPayload(item, 'minimal', [], undefined, 'acme/app'));
    expect(event.data.usage).toEqual({ inputTokens: 120, outputTokens: 30, costUsd: 0.2, coverage: 'partial' });
    expect(event.links).toEqual({ issue: 'https://github.com/acme/app/issues/42', pullRequest: 'https://github.com/acme/app/pull/3' });
    delete item.snapshot.inputTokens; delete item.snapshot.outputTokens; delete item.snapshot.costUsd;
    expect(JSON.parse(payload.renderPayload(item, 'minimal', [])).data).not.toHaveProperty('usage');
  });
  it('does not invent failure disposition before readiness', () => {
    const item = source(); item.type = 'task.failed'; item.snapshot.status = 'failed';
    expect(() => payload.renderPayload(item, 'minimal', [])).toThrow('disposition');
    expect(JSON.parse(payload.renderPayload(item, 'minimal', [], { disposition: 'manual' }))).toMatchObject({ data: { disposition: 'manual' } });
  });
});
