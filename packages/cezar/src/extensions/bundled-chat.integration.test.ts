// F11: build the REAL worker artifacts (build-bundled-chat + inline-contract), spawn them through
// the host owner, and drive them against fake Slack and Discord endpoints on loopback. A loader
// hook (execArgv only; the worker env stays allowlisted) points slack.com/discord.com at them.
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { WebSocketServer, type WebSocket } from 'ws'
import { BundledChatOwner } from './bundled-host.ts'
import { loadBundledProviderCatalog, type BundledProviderManifest } from './bundled-catalog.ts'
import { encodeDiscordCredentials } from '../chat/providers/discord/index.ts'
import type { ChatConnectionOptions, ChatHealth, ReceiveJournal } from '../chat/connection.ts'
import type { ChatEvent, ChatTransport } from '../chat/provider.ts'

const packageRoot = resolve(import.meta.dirname, '..', '..')
// Inside node_modules so the bare runtime deps (zod, ws, undici) resolve exactly as when installed.
const root = join(packageRoot, 'node_modules', '.cache', `cezar-bundled-it-${randomUUID().slice(0, 8)}`)
const dist = join(root, 'dist')
const require_ = createRequire(import.meta.url)

type Recorded = { method: string; path: string; auth: string | undefined; body: string }
const requests: Recorded[] = []
const servers: Array<Server | WebSocketServer> = []
let httpPort = 0, slackWsPort = 0, discordWsPort = 0
let slackSockets: WebSocket[] = [], discordSockets: WebSocket[] = []
const acks: string[] = []
let catalog: readonly BundledProviderManifest[] = []
let execArgv: string[] = []

const body = (request: IncomingMessage) => new Promise<string>(done => { let text = ''; request.on('data', chunk => { text += chunk }); request.on('end', () => done(text)) })
const json = (value: unknown) => JSON.stringify(value)
const listen = (server: Server) => new Promise<number>(done => server.listen(0, '127.0.0.1', () => done((server.address() as { port: number }).port)))
const until = async (check: () => boolean, ms = 10_000) => { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw new Error('timed out'); await new Promise(r => setTimeout(r, 20)) } }
const alive = (pid: number | undefined) => { if (!pid) return false; try { process.kill(pid, 0); return true } catch { return false } }

const BOT = '222222222222222222', DM = '333333333333333333', USER = '444444444444444444'
async function fakeEndpoints() {
  const http = createServer(async (request, response) => {
    const text = await body(request)
    const path = request.url ?? ''
    requests.push({ method: request.method ?? '', path, auth: request.headers.authorization, body: text })
    response.setHeader('content-type', 'application/json')
    // Slack Web API
    if (path === '/api/auth.test') return response.end(json({ ok: true, team_id: 'T1', user_id: 'U1' }))
    if (path === '/api/apps.connections.open') return response.end(json({ ok: true, url: 'wss://wss-primary.slack.com/link/?ticket=1' }))
    if (path === '/api/conversations.info') return response.end(json({ ok: true, channel: { id: 'D1', is_im: true, user: 'U2' } }))
    if (path === '/api/chat.postMessage') return response.end(json({ ok: true, channel: 'D1', ts: '1800000000.000009' }))
    // Discord REST
    if (path === '/api/v10/users/@me') return response.end(json({ id: BOT, username: 'cezar', bot: true }))
    if (path === '/api/v10/gateway/bot') return response.end(json({ url: 'wss://gateway.discord.gg', shards: 1, session_start_limit: { remaining: 1000, reset_after: 1000 } }))
    if (path === `/api/v10/channels/${DM}` && request.method === 'GET') return response.end(json({ id: DM, type: 1, recipients: [{ id: USER }] }))
    if (path === `/api/v10/channels/${DM}/messages`) return response.end(json({ id: '555555555555555555', channel_id: DM }))
    if (path.startsWith('/api/v10/applications/')) return response.end(json([]))
    response.statusCode = 404; response.end(json({ ok: false, error: 'not_found' }))
  })
  servers.push(http); httpPort = await listen(http)
  const slack = new WebSocketServer({ host: '127.0.0.1', port: 0 }); servers.push(slack)
  await new Promise(done => slack.once('listening', done)); slackWsPort = (slack.address() as { port: number }).port
  slack.on('connection', socket => {
    slackSockets.push(socket)
    socket.on('message', data => { const value = JSON.parse(String(data)) as { envelope_id?: string }; if (value.envelope_id) acks.push(value.envelope_id) })
    socket.send(json({ type: 'hello' }))
  })
  const discord = new WebSocketServer({ host: '127.0.0.1', port: 0 }); servers.push(discord)
  await new Promise(done => discord.once('listening', done)); discordWsPort = (discord.address() as { port: number }).port
  discord.on('connection', socket => {
    discordSockets.push(socket)
    socket.on('message', data => {
      const frame = JSON.parse(String(data)) as { op: number }
      if (frame.op === 2) socket.send(json({ op: 0, s: 1, t: 'READY', d: { session_id: 's1', resume_gateway_url: 'wss://gateway.discord.gg', user: { id: BOT, username: 'cezar', bot: true } } }))
      if (frame.op === 1) socket.send(json({ op: 11 }))
    })
    socket.send(json({ op: 10, d: { heartbeat_interval: 45_000 } }))
  })
}

function loaderHooks() {
  const hooks = join(root, 'hooks.mjs'), preload = join(root, 'preload.mjs'), wsShim = join(root, 'ws-shim.mjs'), undiciShim = join(root, 'undici-shim.mjs')
  const rewrite = `const rewrite = url => String(url)
    .replace(/^https:\\/\\/slack\\.com\\//, 'http://127.0.0.1:${httpPort}/')
    .replace(/^https:\\/\\/discord\\.com\\//, 'http://127.0.0.1:${httpPort}/')
    .replace(/^wss:\\/\\/wss-primary\\.slack\\.com\\//, 'ws://127.0.0.1:${slackWsPort}/')
    .replace(/^wss:\\/\\/gateway\\.discord\\.gg\\//, 'ws://127.0.0.1:${discordWsPort}/');`
  const realWs = pathToFileURL(join(require_.resolve('ws/package.json'), '..', 'wrapper.mjs')).href
  const realUndici = pathToFileURL(require_.resolve('undici')).href
  writeFileSync(wsShim, `import Real from ${json(realWs)};\n${rewrite}\nexport class WebSocket extends Real { constructor(url, ...rest) { super(rewrite(url), ...rest) } }\nexport default WebSocket;\nexport { WebSocketServer } from ${json(realWs)};\n`)
  writeFileSync(undiciShim, `import * as real from ${json(realUndici)};\n${rewrite}\nexport const fetch = (url, init) => real.fetch(rewrite(url), init);\n`)
  writeFileSync(hooks, `export async function resolve(specifier, context, next) {\n if (specifier === 'ws') return { url: ${json(pathToFileURL(wsShim).href)}, shortCircuit: true };\n if (specifier === 'undici') return { url: ${json(pathToFileURL(undiciShim).href)}, shortCircuit: true };\n return next(specifier, context);\n}\n`)
  writeFileSync(preload, `import { register } from 'node:module';\nregister(${json(pathToFileURL(hooks).href)});\n${rewrite}\nconst real = globalThis.fetch; globalThis.fetch = (url, init) => real(rewrite(url), init);\n`)
  return ['--import', pathToFileURL(preload).href]
}

beforeAll(async () => {
  mkdirSync(root, { recursive: true })
  // The real artifact pipeline: bundle, then postbuild's contract fold. The digest must survive it (#F1).
  execFileSync(process.execPath, [join(packageRoot, 'scripts', 'build-bundled-chat.mjs'), '--dist', dist], { stdio: 'pipe' })
  execFileSync(process.execPath, [join(packageRoot, 'scripts', 'inline-contract.mjs'), '--dist', dist], { stdio: 'pipe' })
  catalog = await loadBundledProviderCatalog(root)
  await fakeEndpoints()
  execArgv = loaderHooks()
}, 120_000)
afterAll(async () => {
  for (const socket of [...slackSockets, ...discordSockets]) socket.terminate()
  for (const server of servers) await new Promise(done => server.close(() => done(undefined)))
  rmSync(root, { recursive: true, force: true })
}, 30_000)

// A failed assertion must not leave a worker running until vitest exits (stop() is idempotent).
const owners: BundledChatOwner[] = []
const track = (owner: BundledChatOwner) => { owners.push(owner); return owner }
afterEach(async () => { await Promise.all(owners.splice(0).map(owner => owner.stop())) }, 30_000)

const journal = {} as ReceiveJournal
function harness() {
  const events: ChatEvent[] = [], health: ChatHealth['state'][] = []
  const options: ChatConnectionOptions = {
    accept: async event => { events.push(event) }, process: async () => {}, needed: () => true,
    assertCredentials: async () => {}, onHealth: value => { health.push(value.state) },
    nativeCommands: { tasks: async () => [{ name: 'Fix the bug', value: 'run-1' }] },
  }
  const compatStarts: string[] = []
  const compatibility = {
    guarded() { return compatibility },
    connect: () => ({ start: () => { compatStarts.push('start') }, stop: async () => {}, health: () => ({ state: 'polling' as const }) }),
  } as unknown as ChatTransport
  return { events, health, options, compatibility, compatStarts }
}
const manifest = (id: string) => catalog.find(item => item.id === id)!
const slackMessage = (envelope: string, ts: string) => json({ envelope_id: envelope, type: 'events_api', payload: { team_id: 'T1', event_id: `Ev${envelope}`, authorizations: [{ user_id: 'U1', is_bot: true }], event: { type: 'message', user: 'U2', channel: 'D1', channel_type: 'im', ts, text: 'hello' } } })
const nowTs = (offset = 0) => `${Math.floor(Date.now() / 1000) + offset}.000001`

describe('bundled chat workers — real built artifacts', () => {
  it('ships a catalog whose integrity matches the files after postbuild', () => {
    expect(catalog.map(item => item.id).sort()).toEqual(['discord', 'slack', 'telegram'])
  })

  it('Slack: activates, identifies before connect, receives with ACK, sends, rotates via the host, restarts after a crash without duplicates, stops cleanly', async () => {
    const h = harness(), rotations: string[] = [], logs: string[] = []
    const owner = track(await BundledChatOwner.activate({
      manifest: manifest('slack'), packageRoot: root, compatibility: h.compatibility, log: line => { logs.push(line) },
      // An xoxe. bot token: the worker holds no refresh token or secret and must ask the host (#F5).
      config: async () => ({ appToken: 'xapp-1-A111-111-aaaaaaaaaaaa', botToken: 'xoxe.xoxb-1-initial-token-aaaa' }),
      rotate: async kind => { rotations.push(kind); return 'xoxe.xoxb-1-rotated-token-bbbb' },
      restartDelayMs: () => 50, worker: { execArgv },
    }))
    const transport = owner.transport(() => true)
    // Identify BEFORE any connect used to hang forever (#F2).
    await expect(transport.identify()).resolves.toEqual({ id: 'T1:U1', username: 'T1:U1' })
    expect(rotations).toContain('bot')
    expect(requests.find(r => r.path === '/api/auth.test')?.auth).toBe('Bearer xoxe.xoxb-1-rotated-token-bbbb')

    const connection = transport.connect(journal, h.options)
    connection.start()
    await until(() => slackSockets.length === 1 && h.health.includes('polling'))
    expect(connection.health().state).toBe('polling')
    const first = slackSockets[0]!
    first.send(slackMessage('env-1', nowTs(2)))
    // The socket is kept after `open`, so the envelope is ACKed and accepted (#F4).
    await until(() => h.events.length === 1)
    expect(acks).toContain('env-1')
    expect(h.events[0]).toMatchObject({ kind: 'message', id: expect.stringMatching(/^msg:D1:/), text: 'hello' })

    await expect(transport.send('private:T1:U1:D1', { text: 'reply' })).resolves.toEqual({ chatId: 'private:T1:U1:D1', messageId: '1800000000.000009' })
    expect(requests.some(r => r.path === '/api/chat.postMessage' && r.body.includes('reply'))).toBe(true)

    // Crash: pending calls fail fast, the owner respawns, reconnects, and the old generation is fenced.
    const pid = owner.pid!
    process.kill(pid, 'SIGKILL')
    await until(() => !alive(pid))
    await until(() => owner.pid !== undefined && owner.pid !== pid && slackSockets.length === 2, 15_000)
    await until(() => h.health.at(-1) === 'polling')
    slackSockets[1]!.send(slackMessage('env-2', nowTs(5)))
    await until(() => h.events.length === 2)
    expect(new Set(h.events.map(event => event.id)).size).toBe(2)
    // The crash is in the server log, not swallowed.
    expect(logs.some(line => /exited .*restarting \(attempt 1\)/.test(line))).toBe(true)
    expect(h.compatStarts).toEqual([])

    const last = owner.pid
    await connection.stop()
    await owner.stop()
    expect(alive(last)).toBe(false)
  }, 60_000)

  it('Discord: activates, connects the Gateway, receives, answers native commands, sends, and stops with no leaked process', async () => {
    const h = harness()
    const owner = track(await BundledChatOwner.activate({
      manifest: manifest('discord'), packageRoot: root, compatibility: h.compatibility, log: () => {},
      config: async () => ({ token: encodeDiscordCredentials({ token: 'MTIzNDU2Nzg5MDEyMzQ1Njc4.GaBcDe.abcdefghijklmnopqrstuvwxyz012345' }) }),
      worker: { execArgv },
    }))
    const transport = owner.transport(() => true)
    await expect(transport.identify()).resolves.toMatchObject({ id: BOT })
    const connection = transport.connect(journal, h.options)
    connection.start()
    await until(() => discordSockets.length === 1 && h.health.includes('polling'))
    discordSockets[0]!.send(json({ op: 0, s: 2, t: 'MESSAGE_CREATE', d: { id: '666666666666666666', channel_id: DM, author: { id: USER, username: 'alice' }, content: 'hello discord', timestamp: new Date().toISOString() } }))
    await until(() => h.events.length === 1)
    expect(h.events[0]).toMatchObject({ kind: 'message', id: 'message:666666666666666666', text: 'hello discord' })
    // Autocomplete reaches the host's nativeCommands through a bounded request (#F7).
    discordSockets[0]!.send(json({ op: 0, s: 3, t: 'INTERACTION_CREATE', d: { id: '777777777777777777', application_id: BOT, type: 4, token: 'tok', channel_id: DM, user: { id: USER, username: 'alice' }, data: { name: 'tasks', options: [{ name: 'task', value: 'fix', focused: true }] } } }))
    await until(() => requests.some(r => r.path.startsWith('/api/v10/interactions/777777777777777777/')))
    expect(requests.find(r => r.path.startsWith('/api/v10/interactions/777777777777777777/'))!.body).toContain('run-1')
    await expect(transport.send(`discord:dm:${DM}`, { text: 'reply' })).resolves.toMatchObject({ chatId: `discord:dm:${DM}` })
    const pid = owner.pid
    await connection.stop()
    await owner.stop()
    expect(alive(pid)).toBe(false)
  }, 60_000)

  it('falls back to the in-process adapter once restarts are exhausted, never running both', async () => {
    const h = harness()
    const owner = track(await BundledChatOwner.activate({
      manifest: manifest('slack'), packageRoot: root, compatibility: h.compatibility, log: () => {},
      config: async () => ({ appToken: 'xapp-1-A111-111-aaaaaaaaaaaa', botToken: 'xoxb-1-plain-token-aaaa' }),
      maxRestarts: 0, worker: { execArgv },
    }))
    const connection = owner.transport(() => true).connect(journal, h.options)
    connection.start()
    const pid = owner.pid!
    process.kill(pid, 'SIGKILL')
    await until(() => h.compatStarts.length === 1)
    expect(owner.mode).toBe('compatibility')
    expect(alive(pid)).toBe(false)
    expect(owner.pid).toBeUndefined()
    await connection.stop(); await owner.stop()
  }, 30_000)
})
