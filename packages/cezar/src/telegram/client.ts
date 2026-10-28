import type { Agent } from 'undici';
import { telegramBotTokenSchema } from '@open-mercato/cezar-contract';
import { DestinationPolicyError, validateDestination, type DestinationPolicy, type Lookup } from '../webhooks/destination.ts';

export type TelegramMethod = 'getMe' | 'getChat' | 'getChatMember' | 'getUpdates' | 'sendMessage' | 'answerCallbackQuery' | 'editMessageReplyMarkup';
export class TelegramApiError extends Error {
  constructor(readonly code: 'network' | 'policy' | 'body_limit' | 'invalid_response' | 'http', readonly status?: number, readonly retryAfter?: number) {
    super(`Telegram request failed: ${code}`);
  }
}
export type TelegramCall = (method: TelegramMethod, body: object, signal?: AbortSignal) => Promise<unknown>;
function bounded<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new TelegramApiError('network'));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** Fixed Telegram methods/host, pinned public DNS, deadline includes lookup and body. Never logs the URL. */
export function telegramClient(options: {
  token(): Promise<string>; policy: DestinationPolicy; lookup?: Lookup; dryRun?: boolean;
}): TelegramCall {
  return async (method, body, parentSignal) => {
    // Dry-run requires an injected simulated transport; no accidental live call is possible.
    if (options.dryRun) throw new TelegramApiError('policy');
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (parentSignal?.aborted) abort(); else parentSignal?.addEventListener('abort', abort, { once: true });
    const deadline = method === 'getUpdates' ? 35_000 : 10_000;
    const timer = setTimeout(abort, deadline);
    let dispatcher: Agent | undefined;
    try {
      const token = telegramBotTokenSchema.parse(await bounded(options.token(), controller.signal));
      const target = await bounded(validateDestination(`https://api.telegram.org/bot${token}/${method}`, { ...options.policy, allowLocalNetwork: false }, options.lookup), controller.signal);
      const { Agent, request } = await import('undici');
      dispatcher = new Agent({ connections: 1, pipelining: 1, connect: { rejectUnauthorized: true, autoSelectFamily: false,
        lookup(_hostname, lookupOptions, callback) {
          if (lookupOptions.all) callback(null, [{ address: target.address, family: target.family }]);
          else callback(null, target.address, target.family);
        } } });
      const response = await request(target.url, { dispatcher, method: 'POST', body: JSON.stringify(body), signal: controller.signal,
        maxRedirections: 0, headersTimeout: deadline, bodyTimeout: deadline, headers: { 'content-type': 'application/json', 'user-agent': 'cezar-telegram/1' } });
      const chunks: Buffer[] = []; let length = 0;
      try {
        await bounded((async () => {
          for await (const chunk of response.body) {
            length += chunk.length;
            if (length > 1024 * 1024) throw new TelegramApiError('body_limit');
            chunks.push(Buffer.from(chunk));
          }
        })(), controller.signal);
      } finally { response.body.destroy(); }
      let data: unknown;
      try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new TelegramApiError('invalid_response'); }
      if (!data || typeof data !== 'object') throw new TelegramApiError('invalid_response');
      const envelope = data as Record<string, unknown>;
      if (response.statusCode !== 200 || envelope.ok !== true) {
        const parameters = envelope.parameters as { retry_after?: unknown } | undefined;
        const wait = parameters?.retry_after;
        throw new TelegramApiError('http', response.statusCode,
          typeof wait === 'number' && Number.isSafeInteger(wait) && wait > 0 ? wait : undefined);
      }
      return envelope.result;
    } catch (error) {
      if (error instanceof TelegramApiError) throw error;
      if (error instanceof DestinationPolicyError) throw new TelegramApiError('policy');
      throw new TelegramApiError('network');
    } finally {
      clearTimeout(timer); parentSignal?.removeEventListener('abort', abort);
      if (dispatcher) await dispatcher.destroy().catch(() => undefined);
    }
  };
}
