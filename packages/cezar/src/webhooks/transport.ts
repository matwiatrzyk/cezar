import { Agent, request } from 'undici';
import { collectSecretValues, redactSecrets } from '../core/secret-redaction.ts';
import { DestinationPolicyError, validateDestination, type DestinationPolicy, type Lookup } from './destination.ts';
import { signWebhook } from './signing.ts';

export interface WebhookSend {
  url: string; body: string; eventId: string; secrets: readonly string[]; policy: DestinationPolicy;
  signal?: AbortSignal;
}
export type SendResult = { kind: 'http'; status: number; contentType?: string; response?: string; retryAfter?: string }
  | { kind: 'policy' | 'transient'; reason: string };
function untilAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('aborted'));
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
export async function sendWebhook(input: WebhookSend, dependencies: { lookup?: Lookup; now?: () => number } = {}): Promise<SendResult> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (input.signal?.aborted) controller.abort();
  else input.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, 10_000);
  let dispatcher: Agent | undefined;
  try {
    const target = await untilAbort(validateDestination(input.url, input.policy, dependencies.lookup), controller.signal);
    dispatcher = new Agent({
      connections: 1, pipelining: 1, autoSelectFamily: false,
      connect: {
        rejectUnauthorized: true,
        lookup(_hostname, options, callback) {
          // DNS was validated as an entire set; the connector gets one pinned answer only.
          if (options.all) callback(null, [{ address: target.address, family: target.family }]);
          else callback(null, target.address, target.family);
        },
      },
    });
    const timestamp = Math.floor((dependencies.now ?? Date.now)() / 1000);
    const result = await request(target.url, {
      dispatcher, method: 'POST', body: input.body, signal: controller.signal,
      maxRedirections: 0, headersTimeout: 10_000, bodyTimeout: 10_000,
      headers: {
        'content-type': 'application/json', 'user-agent': 'cezar-webhooks/1',
        'webhook-id': input.eventId, 'webhook-timestamp': String(timestamp),
        'webhook-signature': signWebhook(input.eventId, timestamp, input.body, input.secrets),
      },
    });
    const secretValues = [...collectSecretValues(), ...input.secrets, input.url];
    const header = (name: string) => {
      const value = result.headers[name]; return typeof value === 'string' ? redactSecrets(value, secretValues).slice(0, 256) : undefined;
    };
    const contentType = header('content-type'), retryAfter = header('retry-after');
    let response: string | undefined;
    // Path/query values may be credentials of any length. A proxy can echo
    // arbitrary decoded fragments, which value redaction cannot reliably cover.
    // Keep status/retry diagnostics, but never retain that untrusted body.
    const destination = new URL(input.url);
    if (target.private || destination.pathname !== '/' || destination.search) result.body.destroy();
    else {
      const chunks: Buffer[] = []; let remaining = 4096;
      try {
        for await (const chunk of result.body) {
          const bytes = Buffer.from(chunk);
          chunks.push(bytes.subarray(0, remaining)); remaining -= Math.min(remaining, bytes.length);
          if (!remaining) { result.body.destroy(); break; }
        }
        response = redactSecrets(Buffer.concat(chunks).toString('utf8'), secretValues).slice(0, 4096);
      } catch {
        // A partial response does not negate the HTTP status already received.
        response = undefined;
      }
    }
    return { kind: 'http', status: result.statusCode, ...(contentType ? { contentType } : {}), ...(retryAfter ? { retryAfter } : {}), ...(response !== undefined ? { response } : {}) };
  } catch (error) {
    if (error instanceof DestinationPolicyError) return { kind: 'policy', reason: error.code };
    return { kind: 'transient', reason: controller.signal.aborted ? 'timeout' : 'connection_failed' };
  } finally {
    clearTimeout(timer); input.signal?.removeEventListener('abort', abort);
    if (dispatcher) await dispatcher.destroy().catch(() => undefined);
  }
}
export function retryAt(attempt: number, now: number, retryAfter?: string, random: () => number = Math.random): number {
  const base = Math.min(3_600_000, 5000 * 2 ** Math.min(Math.max(0, attempt - 1), 20));
  const backoff = Math.min(3_600_000, base * (1 + Math.max(0, Math.min(1, random())) * 0.2));
  let requested = 0;
  // Saturate valid oversized delays instead of falling back to an early retry.
  // The caller compares this deadline with delivery expiry before scheduling.
  const maxDate = 8_640_000_000_000_000;
  if (retryAfter && /^\d+(?:\.\d+)?$/.test(retryAfter.trim())) requested = Math.min(maxDate, now + Number(retryAfter) * 1000);
  else if (retryAfter && /^[A-Za-z]{3}, /.test(retryAfter)) requested = Date.parse(retryAfter);
  return Math.min(maxDate, Math.max(now + backoff, Number.isFinite(requested) ? requested : 0));
}
