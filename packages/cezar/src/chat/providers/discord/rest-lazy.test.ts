import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => { vi.doUnmock('undici'); vi.resetModules(); });

it.each(['ownership', 'authorization', 'abort'] as const)(
 'blocks %s revoked while the HTTP client is loading',
 async revoked => {
  vi.resetModules();
  let loaded!: () => void;
  let release!: () => void;
  const loading = new Promise<void>(resolve => { loaded = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const fetch = vi.fn().mockResolvedValue({ ok: true, headers: new Headers(), body: null });
  vi.doMock('undici', async () => { loaded(); await gate; return { fetch }; });
  const { discordRequest } = await import('./rest.ts');
  let owned = true, authorized = true;
  const controller = new AbortController();
  const request = discordRequest('fixture-token', () => owned);
  const pending = request('POST', '/channels/10/messages', { content: 'hello' }, controller.signal, () => authorized);
  await loading;
  if (revoked === 'ownership') owned = false;
  if (revoked === 'authorization') authorized = false;
  if (revoked === 'abort') controller.abort();
  release();
  await expect(pending).rejects.toMatchObject({ failure: { kind: 'blocked' } });
  expect(fetch).not.toHaveBeenCalled();
 });
