#!/usr/bin/env node
// Standalone recipe, Node >=20. One process and one signing-key trust domain per store.
import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { open, readFile, rename, mkdir, lstat, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const RETAIN_MS = 72 * 60 * 60 * 1000;
const MAX_IDS = 50000;
const MAX_STORE_BYTES = 8 * 1024 * 1024;

export function verify(raw, headers, secrets, now = Date.now()) {
  const id = headers['webhook-id']; const timestamp = headers['webhook-timestamp']; const signature = headers['webhook-signature'];
  if (!Buffer.isBuffer(raw) || raw.length > 65536 || typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id) ||
    typeof timestamp !== 'string' || !/^\d{1,12}$/.test(timestamp) || Math.abs(now / 1000 - Number(timestamp)) > 300 ||
    typeof signature !== 'string' || signature.length > 1024 || !Array.isArray(secrets) || secrets.length < 1 || secrets.length > 2) return false;
  let valid = false;
  for (const secret of secrets) {
    if (typeof secret !== 'string' || !/^whsec_[A-Za-z0-9+/]{43}=$/.test(secret)) continue;
    const key = Buffer.from(secret.slice(6), 'base64'); if (key.length !== 32 || key.toString('base64') !== secret.slice(6)) continue;
    const expected = createHmac('sha256', key).update(`${id}.${timestamp}.`).update(raw).digest();
    for (const part of signature.split(' ')) if (/^v1,[A-Za-z0-9+/]{43}=$/.test(part)) {
      const received = Buffer.from(part.slice(3), 'base64');
      if (received.length === expected.length && timingSafeEqual(received, expected)) valid = true;
    }
  }
  return valid;
}

export function summarize(event) {
  if (event.type === 'webhook.test') return 'cezar is connected · test notification';
  const data = event.data ?? {};
  const labels = { 'task.attention_required': 'Agent is waiting for you', 'task.review_ready': 'Ready for review',
    'task.finished': 'Finished', 'task.failed': data.disposition === 'scheduled' ? `Paused — resumes at ${data.autoResumeAt}` : 'Failed', 'task.cancelled': 'Cancelled' };
  if (!labels[event.type] || !event.task || !event.source) throw new Error('Unsupported event');
  const details = event.type === 'task.finished' ? ` · ${data.resolution ?? 'unknown'}` :
    event.type === 'task.attention_required' ? ` · since ${data.since ?? event.occurredAt}${data.questions?.[0]?.question ? ` · ${data.questions[0].question}` : ''}` :
    event.type === 'task.failed' && data.message ? ` · ${data.message}` : '';
  // Keep all recipes single-line and bounded. Minimal has no inferred title/question/details.
  return `${labels[event.type]} · ${event.source.projectId} · ${event.task.id}${event.task.title ? ` · ${event.task.title}` : ''}${details}`.replace(/[\r\n\u0000-\u001f]/g, ' ').slice(0, 1500);
}
export function chatPayload(summary, target) {
  if (target === 'discord') return { content: summary, allowed_mentions: { parse: [] } };
  if (target !== 'slack') throw new Error('Choose slack or discord');
  return { text: summary.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'), mrkdwn: false, link_names: false, unfurl_links: false, unfurl_media: false };
}

/** Atomic completion writes are serialized across IDs; a failed write never updates memory. */
export async function openCompletedStore(file, { now = Date.now } = {}) {
  file = resolve(file); await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  let entries = new Map();
  try {
    const info = await lstat(file); if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_STORE_BYTES) throw new Error('Invalid completion store');
    const value = JSON.parse(await readFile(file, 'utf8'));
    if (value.version !== 1 || !Array.isArray(value.completed) || value.completed.length > MAX_IDS) throw new Error('Invalid completion store');
    for (const row of value.completed) {
      if (!Array.isArray(row) || row.length !== 2 || !/^[A-Za-z0-9_-]{1,128}$/.test(row[0]) || !Number.isSafeInteger(row[1])) throw new Error('Invalid completion record');
      entries.set(row[0], row[1]);
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let writes = Promise.resolve();
  return {
    has: id => entries.has(id) && entries.get(id) >= now() - RETAIN_MS,
    complete(id) {
      const result = writes.then(async () => {
        const next = new Map([...entries].filter(([, at]) => at >= now() - RETAIN_MS)); next.set(id, now());
        if (next.size > MAX_IDS) throw new Error('Completion capacity exhausted');
        const bytes = JSON.stringify({ version: 1, completed: [...next] });
        if (Buffer.byteLength(bytes) > MAX_STORE_BYTES) throw new Error('Completion capacity exhausted');
        const temporary = `${file}.${randomUUID()}.tmp`; let handle;
        try {
          handle = await open(temporary, 'wx', 0o600); await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = undefined;
          await rename(temporary, file);
          const directory = await open(dirname(file), 'r'); try { await directory.sync(); } finally { await directory.close(); }
          entries = next;
        } finally { await handle?.close(); await unlink(temporary).catch(() => {}); }
      });
      writes = result.catch(() => {}); return result;
    },
  };
}

/** post must honor its AbortSignal; the CLI provides a bounded fetch implementation. */
export function createRelay({ secrets, store, post, now = Date.now }) {
  const inFlight = new Map();
  return async ({ raw, headers }) => {
    if (!verify(raw, headers, secrets, now())) return 401;
    let event; let summary;
    try { event = JSON.parse(raw.toString('utf8')); if (event.id !== headers['webhook-id'] || event.schemaVersion !== 1) return 400; summary = summarize(event); } catch { return 400; }
    if (store.has(event.id)) return 204;
    if (inFlight.has(event.id)) return inFlight.get(event.id);
    if (inFlight.size >= 32) return 503;
    const work = (async () => {
      try {
        await post(summary, AbortSignal.timeout(7000));
        await store.complete(event.id);
        return 204;
      } catch { return 503; }
    })();
    inFlight.set(event.id, work);
    try { return await work; } finally { inFlight.delete(event.id); }
  };
}

async function main() {
  const secret = process.env.WEBHOOK_SECRET; const previous = process.env.WEBHOOK_PREVIOUS_SECRET;
  const target = process.env.CHAT_TARGET; const destination = process.env.CHAT_WEBHOOK_URL;
  const file = resolve(process.env.COMPLETED_STORE ?? './relay-state/completed.json');
  if (!secret || !destination || !['slack', 'discord'].includes(target)) throw new Error('Set WEBHOOK_SECRET, CHAT_TARGET and CHAT_WEBHOOK_URL');
  const url = new URL(destination); if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('Use an HTTPS chat webhook URL');
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const lock = await open(`${file}.lock`, 'wx', 0o600); // Fail closed if another process or an unreconciled crash owns this store.
  await lock.writeFile(String(process.pid)); await lock.sync();
  const release = async () => { await lock.close(); await unlink(`${file}.lock`); };
  try {
    const store = await openCompletedStore(file);
    const handle = createRelay({ secrets: [secret, ...(previous ? [previous] : [])], store, post: async (summary, signal) => {
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(chatPayload(summary, target)), signal, redirect: 'error' });
      await response.body?.cancel(); if (!response.ok) throw new Error('Chat delivery failed');
    } });
    const server = createServer(async (req, res) => {
      if (req.method !== 'POST' || req.url !== '/webhook') { res.writeHead(404).end(); return; }
      try {
        const chunks = []; let length = 0;
        for await (const chunk of req) { length += chunk.length; if (length > 65536) { res.writeHead(413).end(); return; } chunks.push(chunk); }
        const status = await handle({ raw: Buffer.concat(chunks), headers: req.headers }); res.writeHead(status).end();
      } catch { if (!res.headersSent) res.writeHead(503); res.end(); }
    });
    server.requestTimeout = 9000; server.headersTimeout = 9000;
    server.listen(Number(process.env.RELAY_PORT ?? '8788'), '127.0.0.1');
    let closing = false;
    const stop = () => { if (closing) return; closing = true; server.close(() => { void release().then(() => process.exit(0)); }); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    server.once('error', () => { void release().finally(() => process.exit(1)); });
  } catch (error) { await release(); throw error; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { process.stderr.write('Relay could not start; check configuration and exclusive completion-store ownership.\n'); process.exitCode = 1; });
}
