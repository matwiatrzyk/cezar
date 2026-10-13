import { afterEach, describe, expect, it, vi } from 'vitest';
const wire = vi.hoisted(() => ({ options: undefined as any, request: vi.fn(), destroy: vi.fn(async () => undefined) }));
vi.mock('undici', () => ({ Agent: class { constructor(options: any) { wire.options = options; } destroy = wire.destroy; }, request: wire.request }));
import * as transport from './transport.ts';
import { verifyWebhook } from './signing.ts';
const input = () => ({ url: 'https://example.com/private?token=hidden', body: '{"test":true}', eventId: 'evt_test', secrets: ['whsec_' + Buffer.alloc(32, 7).toString('base64')], policy: { mode: 'local' as const, allowLocalNetwork: false, serverPorts: [4317] } });
const lookup = async () => [{ address: '8.8.8.8', family: 4 }];
function response(text: string, statusCode = 200) {
  return { statusCode, headers: { 'content-type': 'text/plain', 'retry-after': '60' }, body: Object.assign((async function* () { yield Buffer.from(text); })(), { destroy: () => undefined }) };
}
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
describe('bounded webhook transport', () => {
  it('pins a validated IP and secure dedicated dispatcher regardless of environment', async () => {
    for (const [key, value] of Object.entries({ HTTP_PROXY: 'http://proxy.invalid', HTTPS_PROXY: 'http://proxy.invalid', NO_PROXY: '*', NODE_USE_ENV_PROXY: '1', NODE_TLS_REJECT_UNAUTHORIZED: '0' })) vi.stubEnv(key, value);
    wire.request.mockResolvedValue(response('ok'));
    const result = await transport.sendWebhook(input(), { lookup, now: () => 1700000000000 });
    expect(result).toMatchObject({ kind: 'http', status: 200, response: 'ok' });
    expect(wire.options.autoSelectFamily).toBe(false); expect(wire.options.connect.rejectUnauthorized).toBe(true);
    const actual = await new Promise(resolve => wire.options.connect.lookup('example.com', {}, (_: unknown, address: string) => resolve(address)));
    expect(actual).toBe('8.8.8.8');
    const options = wire.request.mock.calls[0]![1];
    expect(options.maxRedirections).toBe(0);
    expect(verifyWebhook('evt_test', 1700000000, input().body, options.headers['webhook-signature'], input().secrets, 1700000000)).toBe(true);
  });
  it('discards all private response bodies and caps public diagnostics', async () => {
    wire.request.mockResolvedValue(response('internal secret'));
    const privateResult = await transport.sendWebhook({ ...input(), url: 'http://127.0.0.1:9090/', policy: { ...input().policy, allowLocalNetwork: true } });
    expect(privateResult).toEqual({ kind: 'http', status: 200, contentType: 'text/plain', retryAfter: '60' });
    wire.request.mockResolvedValue(response('x'.repeat(10_000)));
    const publicResult = await transport.sendWebhook(input(), { lookup });
    expect(publicResult.kind === 'http' && publicResult.response?.length).toBe(4096);
  });
  it('returns safe policy/connection failures without URL paths or raw errors', async () => {
    expect(await transport.sendWebhook({ ...input(), url: 'http://169.254.169.254/private' })).toEqual({ kind: 'policy', reason: 'denied_address' });
    wire.request.mockRejectedValue(new Error('failure at https://example.com/private?token=hidden'));
    expect(await transport.sendWebhook(input(), { lookup })).toEqual({ kind: 'transient', reason: 'connection_failed' });
  });
  it('bounds DNS by the same total deadline as HTTP', async () => {
    vi.useFakeTimers();
    try {
      const result = transport.sendWebhook(input(), { lookup: () => new Promise(() => undefined) });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await result).toEqual({ kind: 'transient', reason: 'timeout' });
    } finally { vi.useRealTimers(); }
  });
  it('honors seconds/date Retry-After and never schedules earlier than backoff', () => {
    const now = 1700000000000;
    expect(transport.retryAt(1, now, '60', () => 0)).toBe(now + 60000);
    expect(transport.retryAt(1, now, new Date(now + 120000).toUTCString(), () => 0)).toBe(now + 120000);
    expect(transport.retryAt(1, now, '-1', () => 0)).toBe(now + 5000);
    expect(transport.retryAt(100, now, undefined, () => 1)).toBe(now + 3600000);
  });
});
