import { Agent, request } from 'undici';
import { collectSecretValues, redactSecrets } from '../core/secret-redaction.ts';
import { DestinationPolicyError, validateDestination, type DestinationPolicy, type Lookup } from './destination.ts';
import { signWebhook } from './signing.ts';

export interface WebhookSend {
  url: string; body: string; eventId: string; secrets: readonly string[]; policy: DestinationPolicy;
  /** Redaction only; never passed to HMAC signing. */
  diagnosticSecrets?: readonly string[];
  signal?: AbortSignal;
}
export type SendResult = { kind: 'http'; status: number; contentType?: string; response?: string; retryAfter?: string }
  | { kind: 'policy' | 'transient'; reason: string };
type HttpResult = Extract<SendResult, { kind: 'http' }>;
// Original complete, bounded diagnostics live only for the result's lifetime,
// outside its serializable surface. A later receiver may contain an earlier
// masked value, so persistence must redact the original text, never a prefix or
// an already-redacted string. Neither raw text nor this context goes to disk.
const diagnosticContexts = new WeakMap<SendResult, { raw: HttpResult; secrets: readonly string[] }>();
export function redactWebhookDiagnostics(result: SendResult, secrets: readonly string[], omitText = false): SendResult {
  if (result.kind !== 'http') return result;
  const context = diagnosticContexts.get(result);
  const raw = context?.raw ?? result;
  // Protocol timing is not display text: redaction or clipping can turn a
  // valid delay into an earlier retry. Share the bounded grammar on every path.
  const value = raw.retryAfter !== undefined && Buffer.byteLength(raw.retryAfter) < 16384 ? raw.retryAfter.trim() : undefined;
  const timing = value && (/^\d+(?:\.\d+)?$/.test(value)
    || (/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value) && Number.isFinite(Date.parse(value)))) ? value : undefined;
  if (omitText) {
    // Only validated timing survives incomplete secret coverage.
    return { kind: 'http', status: raw.status, ...(timing ? { retryAfter: timing } : {}) };
  }
  const values = [...(context?.secrets ?? []), ...collectSecretValues(), ...secrets];
  const clean = (value: string | undefined, limit: number, inputLimit: number) => value !== undefined && Buffer.byteLength(value) <= inputLimit
    ? redactSecrets(value, values).slice(0, limit) : undefined;
  const response = clean(raw.response, 4096, 4096), contentType = clean(raw.contentType, 256, 16384), retryAfter = timing ?? clean(raw.retryAfter, 256, 16383);
  return { kind: 'http', status: raw.status, ...(response !== undefined ? { response } : {}),
    ...(contentType ? { contentType } : {}), ...(retryAfter ? { retryAfter } : {}) };
}
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
      connections: 1, pipelining: 1,
      connect: {
        rejectUnauthorized: true, autoSelectFamily: false,
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
    const secretValues = [...collectSecretValues(), ...input.secrets, input.url, ...(input.diagnosticSecrets ?? [])];
    // Undici's total header limit is 16 KiB. Keep complete values up to that
    // bound for the final redaction pass. Only diagnostic text gets a display cap.
    const header = (name: string) => {
      const value = result.headers[name]; return typeof value === 'string' && Buffer.byteLength(value) < 16384 ? value : undefined;
    };
    const contentType = header('content-type'), retryAfter = header('retry-after');
    let response: string | undefined;
    // Path/query values may be credentials of any length. A proxy can echo
    // arbitrary decoded fragments, which value redaction cannot reliably cover.
    // Keep status/retry diagnostics, but never retain that untrusted body.
    const destination = new URL(input.url);
    if (target.private || destination.pathname !== '/' || destination.search) {
      // An unread undici body has no iterator error handler. destroy() emits
      // UND_ERR_ABORTED asynchronously, outside this function's try/catch.
      // Consume that disposal error without draining an unbounded response.
      result.body.once('error', () => undefined);
      result.body.destroy();
    }
    else {
      const chunks: Buffer[] = []; let remaining = 4096;
      let complete = true;
      try {
        for await (const chunk of result.body) {
          const bytes = Buffer.from(chunk);
          // Never redact a clipped prefix: it may end inside a known secret.
          // At the limit, cancel immediately rather than waiting for EOF or
          // draining an unbounded stream just to decide if it was complete.
          if (bytes.length >= remaining) {
            complete = false;
            result.body.destroy();
            break;
          }
          chunks.push(bytes); remaining -= bytes.length;
        }
        if (complete) response = Buffer.concat(chunks).toString('utf8');
      } catch {
        // A partial response does not negate the HTTP status already received.
        response = undefined;
      }
    }
    const raw: HttpResult = { kind: 'http', status: result.statusCode, ...(contentType ? { contentType } : {}), ...(retryAfter ? { retryAfter } : {}), ...(response !== undefined ? { response } : {}) };
    const sanitized = redactWebhookDiagnostics(raw, secretValues);
    diagnosticContexts.set(sanitized, { raw, secrets: secretValues });
    return sanitized;
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
