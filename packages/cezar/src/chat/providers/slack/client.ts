import WebSocket from 'ws';
import { ChatTransportError } from '../../provider.ts';
import { decodeSlackCredentials } from './identity.ts';
export type SlackMethod = 'auth.test' | 'apps.connections.open' | 'conversations.info' | 'conversations.members' | 'conversations.history' | 'conversations.replies' | 'chat.postMessage' | 'chat.update';
// Slack accepts JSON bodies only on write methods; read methods take form arguments.
const jsonMethods = new Set<SlackMethod>(['chat.postMessage', 'chat.update']);
function encode(method: SlackMethod, body: Record<string, unknown>): { type: string; body: string } {
 if (method === 'apps.connections.open') return { type: 'application/json', body: JSON.stringify(body) };
 if (jsonMethods.has(method)) return { type: 'application/json; charset=utf-8', body: JSON.stringify(body) };
 const form = new URLSearchParams();
 for (const [key, value] of Object.entries(body)) if (value !== undefined) form.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
 return { type: 'application/x-www-form-urlencoded', body: form.toString() };
}
export interface SlackWire {
 call(method: SlackMethod, body: Record<string, unknown>, signal?: AbortSignal, valid?: () => boolean): Promise<unknown>;
 socket(url: string, valid: () => boolean): WebSocket;
}
export function slackError(code: string, retryAfterMs?: number): ChatTransportError {
 const kind = ['invalid_auth', 'not_authed', 'token_revoked', 'account_inactive'].includes(code) ? 'auth'
  : code === 'too_many_connections' ? 'conflict'
  : code === 'ratelimited' ? 'rate_limited'
  : ['channel_not_found', 'not_in_channel', 'is_archived'].includes(code) ? 'gone'
  : ['network', 'internal_error', 'service_unavailable', 'request_timeout', 'fatal_error'].includes(code) ? 'transient' : 'blocked';
 return new ChatTransportError({ kind, ...(kind === 'rate_limited' ? { retryAfterMs: retryAfterMs ?? 5000 } : {}) });
}
/** Resolving credentials is deliberately live; the authorization fence follows that await. */
export function createSlackWire(resolve: () => Promise<string>, options: { fetch?: typeof fetch; socket?: (url: string) => WebSocket } = {}): SlackWire {
 return {
  async call(method, body, signal, valid = () => true) {
   const credentials = decodeSlackCredentials(await resolve());
   if (signal?.aborted || !valid()) throw slackError('blocked');
   try {
    const request = encode(method, body);
    const response = await (options.fetch ?? fetch)(`https://slack.com/api/${method}`, {
     method: 'POST', redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(15000), ...(signal ? [signal] : [])]),
     headers: { Authorization: `Bearer ${method === 'apps.connections.open' ? credentials.appToken : credentials.botToken}`, 'Content-Type': request.type }, body: request.body,
    });
    if (response.status === 429) { const seconds = Number(response.headers.get('retry-after')); throw slackError('ratelimited', Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 3600) * 1000 : 5000); }
    if (!response.ok) throw slackError(response.status === 401 ? 'invalid_auth' : response.status >= 500 ? 'network' : 'blocked');
    const result = await response.json() as { ok?: boolean; error?: string };
    if (result.ok !== true) throw slackError(typeof result.error === 'string' ? result.error : 'blocked');
    return result;
   } catch (error) { if (error instanceof ChatTransportError) throw error; throw slackError('network'); }
  },
  socket(url, valid) {
   const parsed = new URL(url);
   if (parsed.protocol !== 'wss:' || !parsed.hostname.endsWith('.slack.com') || parsed.username || parsed.password || (parsed.port && parsed.port !== '443') || !valid()) throw slackError('blocked');
   return options.socket ? options.socket(url) : new WebSocket(url, { handshakeTimeout: 15000, maxPayload: 1024 * 1024, followRedirects: false });
  },
 };
}
