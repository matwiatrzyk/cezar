import { ChatTransportError } from '../../provider.ts';
export type DiscordRequest = (method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown, signal?: AbortSignal, valid?: () => boolean) => Promise<unknown>;
// Discord limits per bucket and major parameter; only a global limit holds every route.
const major = (path: string) => /^\/(?:channels|guilds|webhooks|interactions)\/\d+/.exec(path)?.[0] ?? '';
const route = (method: string, path: string) => {
 const head = major(path), rest = path.slice(head.length).replace(/\/\d+/g, '/:id');
 return `${method} ${head}${head.startsWith('/interactions') ? rest.replace(/^\/[^/]+/, '/:token') : rest}`;
};
const remember = <V>(map: Map<string, V>, key: string, value: V) => { map.delete(key); map.set(key, value); if (map.size > 512) map.delete(map.keys().next().value!); };
// Eviction must not free a live cooldown while expired ones remain; else the soonest to expire goes.
const cool = (map: Map<string, number>, key: string, until: number) => {
 map.delete(key); map.set(key, until); if (map.size <= 512) return;
 const at = Date.now(); for (const [k, v] of map) if (v <= at) map.delete(k);
 if (map.size > 512) map.delete([...map].reduce((a, b) => (b[1] < a[1] ? b : a))[0]);
};
export function discordRequest(credential: string | (() => Promise<string>), valid: () => boolean = () => true): DiscordRequest {
 let globalUntil = 0;
 const buckets = new Map<string, string>(), cooldowns = new Map<string, number>();
 return async (method, path, body, signal, authorization) => {
  const at = route(method, path), key = () => `${buckets.get(at) ?? at}|${major(path)}`;
  // A cooldown stored under the route before its bucket hash was learned still applies.
  const until = (k: string) => { const t = cooldowns.get(k) ?? 0; if (t && t <= Date.now()) cooldowns.delete(k); return t; };
  let token: string; try { token = typeof credential === 'string' ? credential : await credential(); } catch (error) { if (error instanceof ChatTransportError) throw error; throw new ChatTransportError({ kind: 'auth' }); }
  if (!valid() || authorization?.() === false || signal?.aborted) throw new ChatTransportError({ kind: 'blocked' });
  const wait = Math.max(globalUntil, until(`${at}|${major(path)}`), until(key()));
  if (Date.now() < wait) throw new ChatTransportError({ kind: 'rate_limited', retryAfterMs: wait - Date.now() });
  try {
   const { fetch } = await import('undici');
   // Loading the client yields: the receiver or action may have been revoked meanwhile.
   if (!valid() || authorization?.() === false || signal?.aborted) throw new ChatTransportError({ kind: 'blocked' });
   const response = await fetch(`https://discord.com/api/v10${path}`, { method, headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000), redirect: 'error' });
   const reader = response.body?.getReader(); let text = '';
   if (reader) { const decoder = new TextDecoder(); let bytes = 0; try { for (;;) { const part = await reader.read(); if (part.done) break; bytes += part.value.byteLength; if (bytes > 1024 * 1024) { await reader.cancel(); throw new ChatTransportError({ kind: 'blocked' }); } text += decoder.decode(part.value, { stream: true }); } text += decoder.decode(); } finally { reader.releaseLock(); } }
   let data: unknown; try { data = text ? JSON.parse(text) : undefined } catch { throw new ChatTransportError({ kind: method === 'GET' ? 'transient' : 'blocked' }) }
   const bucket = response.headers.get('x-ratelimit-bucket'); if (bucket && /^[\w-]{1,128}$/.test(bucket)) remember(buckets, at, bucket);
   const reset = Number(response.headers.get('x-ratelimit-reset-after')) * 1000;
   if (response.headers.get('x-ratelimit-remaining') === '0' && reset > 0 && Number.isFinite(reset)) cool(cooldowns, key(), Date.now() + reset);
   if (response.status === 429) {
    const limit = data as { retry_after?: unknown; global?: unknown } | undefined;
    const seconds = Number(limit?.retry_after ?? response.headers.get('retry-after'));
    const retryAfterMs = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 5000;
    if (limit?.global === true || response.headers.get('x-ratelimit-global') === 'true') globalUntil = Date.now() + retryAfterMs;
    else cool(cooldowns, key(), Date.now() + retryAfterMs);
    throw new ChatTransportError({ kind: 'rate_limited', retryAfterMs });
   }
   if (!response.ok) throw new ChatTransportError({ kind: response.status === 401 ? 'auth' : response.status === 404 ? 'gone' : response.status === 403 ? 'blocked' : response.status >= 500 && method === 'GET' ? 'transient' : 'blocked' });
   return data;
  } catch (error) { if (error instanceof ChatTransportError) throw error; throw new ChatTransportError({ kind: method === 'GET' ? 'transient' : 'blocked' }); }
 };
}
