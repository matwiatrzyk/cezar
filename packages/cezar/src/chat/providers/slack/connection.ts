import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type WebSocket from 'ws';
import { ChatTransportError } from '../../provider.ts';
import type { ChatConnection, ChatConnectionOptions, ChatHealth } from '../../connection.ts';
import type { SlackWire } from './client.ts';
import { slackError } from './client.ts';
import { normalizeSlackEnvelope, slackEnvelope } from './normalize.ts';
interface Dependencies {
 wire: SlackWire; valid(): boolean; options: ChatConnectionOptions; now?: () => number;
 identify(signal?: AbortSignal): Promise<{ id: string; username: string }>;
 inspectNative(channel: string, signal?: AbortSignal, cached?: boolean): Promise<{ id: string; kind: 'private' | 'group'; eligible: boolean }>;
 forget(channel: string): void;
}
const leaving = z.object({ payload: z.object({ event: z.object({ type: z.enum(['member_left_channel', 'channel_left', 'group_left', 'channel_archive', 'group_archive', 'channel_deleted', 'group_deleted']), channel: z.string() }) }) });
export function slackConnection(deps: Dependencies): ChatConnection {
 let state: ChatHealth = { state: 'stopped' }, running: Promise<void> | undefined, socket: WebSocket | undefined;
 const controller = new AbortController(), now = deps.now ?? Date.now;
 const alive = () => !controller.signal.aborted && deps.valid() && deps.options.needed();
 const health = (value: ChatHealth) => { state = value; deps.options.onHealth(value); };
 let pending = Promise.resolve(), queued = 0;
 let renewal: Promise<void> | undefined;
 const seen = new Set<string>();
 // A bounded high-water window rejects delayed retransmissions after the recent-ID ledger rolls over.
 let oldestAllowed = now();
 const recent: Array<{ id: string; at: number }> = [];
 async function run() {
  let attempt = 0;
  while (alive()) {
   try {
    await deps.options.assertCredentials(); if (!alive()) break;
    const me = await deps.identify(controller.signal); if (!alive()) break;
    const opened = z.object({ url: z.string() }).parse(await deps.wire.call('apps.connections.open', {}, controller.signal, alive));
    await deps.options.assertCredentials(); if (!alive()) break;
    await new Promise<void>((resolve, reject) => {
     let settled = false;
     const ws = deps.wire.socket(opened.url, alive); socket = ws;
     const finish = (error?: unknown) => { if (settled) return; settled = true; clearInterval(watchdog); controller.signal.removeEventListener('abort', abort); ws.terminate(); socket = undefined; error ? reject(error) : resolve(); };
     const abort = () => finish(); controller.signal.addEventListener('abort', abort, { once: true });
     let lastFrame = now();
     const watchdog = setInterval(() => { if (!alive()) finish(); else if (now() - lastFrame > 90000) finish(slackError('network')); else if (ws.readyState === 1) ws.ping();
      if (!settled && deps.wire.renew && !renewal && alive()) {
       renewal = deps.options.assertCredentials().then(() => deps.wire.renew!(controller.signal, alive)).catch(error => finish(error instanceof ChatTransportError ? error : slackError('blocked'))).finally(() => { renewal = undefined; });
      } }, 30000);
     watchdog.unref();
     ws.on('pong', () => { lastFrame = now(); });
     ws.on('error', () => finish(slackError('network')));
     ws.on('close', () => finish());
     ws.on('open', () => { if (!alive()) return finish(); attempt = 0; health({ state: 'polling', lastSuccessfulPollAt: now() }); });
     ws.on('message', data => {
      if (!alive()) return finish(); lastFrame = now();
      let raw: unknown; try { raw = JSON.parse(data.toString()); } catch { return; }
      const control = z.object({ type: z.string(), reason: z.string().optional() }).safeParse(raw);
      if (control.success && control.data.type === 'disconnect') return finish(control.data.reason === 'link_disabled' ? slackError('blocked') : undefined);
      const parsed = slackEnvelope.safeParse(raw); if (!parsed.success) return;
      // ACK is independent of vault/API/core latency and never includes credentials or response URLs.
      try { if (alive() && ws.readyState === 1) ws.send(JSON.stringify({ envelope_id: parsed.data.envelope_id })); } catch { return finish(slackError('network')); }
      // Redeliveries are processed: the first attempt may have been sent while this socket was down; ids deduplicate.
      const left = leaving.safeParse(parsed.data); if (left.success) deps.forget(left.data.payload.event.channel);
      if (queued >= 1000) return finish(slackError('network'));
      queued++;
      pending = pending.then(async () => {
       if (!alive()) return;
       await deps.options.assertCredentials(); if (!alive()) return;
       let event: Awaited<ReturnType<typeof normalizeSlackEnvelope>>;
       try { event = await normalizeSlackEnvelope(parsed.data, me.id, channel => deps.inspectNative(channel, controller.signal, true), now(), oldestAllowed); } catch (error) {
        // A per-channel lookup failure drops this one event; the socket stays up.
        if (error instanceof ChatTransportError && ['rate_limited', 'gone'].includes(error.failure.kind)) return;
        throw error;
       }
       if (!event || seen.has(event.id) || ('at' in event && event.at < oldestAllowed) || !alive()) return;
       await deps.options.assertCredentials(); if (!alive()) return;
       // The core's durable inbox claims before effects; failed/uncertain events are never retried here.
       seen.add(event.id); recent.push({ id: event.id, at: 'at' in event ? event.at : now() });
       if (recent.length > 1000) { const removed = recent.shift()!; seen.delete(removed.id); oldestAllowed = Math.max(oldestAllowed, removed.at + 1); }
       await deps.options.accept(event);
      }).catch(error => { if (alive()) finish(error instanceof ChatTransportError ? error : slackError('blocked')); }).finally(() => { queued--; });
     });
    });
   } catch (error) {
    if (!alive()) break;
    const failure = error instanceof ChatTransportError ? error.failure : { kind: 'blocked' as const };
    if (['auth', 'blocked', 'conflict'].includes(failure.kind)) { controller.abort(); health({ state: failure.kind === 'auth' ? 'credentials-unavailable' : failure.kind === 'conflict' ? 'conflict' : 'blocked' }); break; }
    health({ state: 'backoff' });
    try { await delay(failure.retryAfterMs ?? Math.min(30000, 1000 * 2 ** Math.min(attempt++, 5)), undefined, { signal: controller.signal }); } catch { break; }
    continue;
   }
   if (alive()) { health({ state: 'backoff' }); try { await delay(1000, undefined, { signal: controller.signal }); } catch { break; } }
  }
 }
 return {
  start() { if (!running && !controller.signal.aborted) running = run(); },
  health: () => ({ ...state }),
  async stop() { controller.abort(); socket?.terminate(); await running; await renewal; await pending; health({ state: 'stopped' }); },
 };
}
