import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
// The adapters import undici from packages/cezar, not from the repository root.
const require = createRequire(new URL('../../cezar/package.json', import.meta.url))
if (!require('undici/package.json').version.startsWith('6.')) throw new Error('Fixture requires locally installed Undici 6')
if (!process.env.LD_PRELOAD?.includes('netguard')) throw new Error('Run the browser fixture under the loopback netguard')
import { createSlackWire } from '../../cezar/src/chat/providers/slack/client.ts'
import { SlackTokenRotation, slackRotationStorage } from '../../cezar/src/chat/providers/slack/rotation.ts'
import { slackWireFixture } from './slack-wire-fixture.mjs'
import { discordWireFixture } from './discord-wire-fixture.mjs'
const provider = process.env.FIXTURE_PROVIDER
if (!['slack', 'discord'].includes(provider)) throw new Error('Choose a simulated provider')
const root = mkdtempSync(join(tmpdir(), 'cezar-' + provider + '-browser-'))
for (const key of Object.keys(process.env)) if (key.startsWith('CEZ_')) delete process.env[key]
Object.assign(process.env, { CEZ_HOME: join(root, '.home'), CEZ_DRY_RUN: '1', CEZ_WEBHOOKS: '1', CEZ_CHAT_INBOUND: '1', CEZ_NO_BANNER: '1', CEZ_SKILLS_AUTO_UPDATE: '0', CEZ_AUTOMATIONS: '0', CEZ_TELEMETRY: '0' })
execFileSync('git', ['init', '-q'], { cwd: root, timeout: 5000 })
const [{ WebhookCoordinator }, { RunStore }, { RunManager }, { startServer }, { registerProject }] = await Promise.all([
 import('../../cezar/src/webhooks/coordinator.ts'), import('../../cezar/src/runs/store.ts'), import('../../cezar/src/workflows/run.ts'), import('../../cezar/src/server/server.ts'), import('../../cezar/src/workspace/projects.ts'),
])
const wire = await (provider === 'slack' ? slackWireFixture() : discordWireFixture())
const project = await registerProject(root)
let server, webhooks, store, seedId, calls = 0, failSend = false, renewals = 0
async function boot(seed = false) {
 store = RunStore.open(join(root, '.ai/cezar'))
 const manager = new RunManager(store, root)
 webhooks = new WebhookCoordinator({ mode: () => 'local', ports: () => [], projects: async () => [{ ...project, status: 'ready' }], // Exercise actual bot delivery; only the agent runner uses CEZ_DRY_RUN.
  dryRun: false,
  slackWire: resolve => process.env.FIXTURE_ROTATING === '1' ? createSlackWire(resolve, {
   socket: wire.socket,
   rotation: new SlackTokenRotation(slackRotationStorage({ kind: 'project', projectId: project.id, root }), async (_url, init) => {
    const form = new URLSearchParams(init.body);
    if (form.get('client_id') !== '123.456' || form.get('client_secret') !== 'a'.repeat(32)) throw new Error('Bad renewal credentials');
    renewals++;
    return new Response(JSON.stringify({ ok: true, token_type: 'app_level', access_token: 'xoxe.xapp-renewed-token', refresh_token: 'xoxe-renewed-refresh', expires_in: 43200 }));
   }),
   fetch: async (url, init) => {
    const method = String(url).split('/').at(-1);
    if (method === 'apps.connections.open' && init.headers.Authorization !== 'Bearer xoxe.xapp-renewed-token') throw new Error('Unrenewed app token');
    const body = init.headers['Content-Type'].includes('application/json') ? JSON.parse(init.body) : Object.fromEntries(new URLSearchParams(init.body));
    return new Response(JSON.stringify({ ok: true, ...await wire.call(method, body, init.signal) }));
   },
  }) : ({ socket: wire.socket, call: async (...args) => { calls++; if (failSend && args[0] === 'chat.postMessage') throw new Error('Simulated delivery failure'); return wire.call(...args) } }),
  discordOptions: resolve => ({ token: resolve, socket: wire.socket, request: async (...args) => { calls++; if (failSend && args[0] === 'POST' && args[1].includes('/messages')) throw new Error('Simulated delivery failure'); return wire.request(...args) } }),
 })
 const service = await webhooks.get(project.id, root, true)
 if (seed) {
  const { receiver } = await service.create({ name: 'Existing webhook', format: provider + '.v1', url: provider === 'slack' ? 'https://hooks.slack.com/services/T1/B1/fixture' : 'https://discord.com/api/webhooks/100000000000000001/' + 'x'.repeat(68), profile: 'standard', graceSeconds: 0 })
  seedId = receiver.id
 }
 server = startServer({ repoRoot: root, bootProjectId: project.id, store, manager, webhooks, version: 'fixture' }, Number(process.env.PORT))
 // /restart answers only once the new server accepts connections, or the spec's reload races it.
 if (!server.listening) await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject) })
}
await boot(true)
const controls = createServer(async (req, res) => {
 try {
  let raw = ''; for await (const chunk of req) raw += chunk
  const input = raw ? JSON.parse(raw) : {}
  if (req.method === 'POST') {
   if (req.url === '/reply') {
    const receipt = wire.sent.find(m => (m.channel === 'C1' || m.channel_id === '100000000000000004') && (m.text ?? m.content ?? '').includes(input.runId))
    if (!receipt) throw new Error('No correlated group receipt')
    wire.message(input.text, true, receipt)
   }
   if (req.url === '/message') wire.message(input.text, input.group)
   if (req.url === '/confirm') {
    const message = wire.sent.find(m => (m.text ?? m.content ?? '').startsWith('Start a new task?'))
    if (!message) throw new Error('No preview')
    const value = provider === 'slack' ? message.blocks.flatMap(b => b.elements ?? []).find(b => b.text?.text === 'Confirm').value : message.components.flatMap(b => b.components).find(b => b.label === 'Confirm').custom_id
    wire.button(message, value)
   }
   if (req.url === '/fail-send') failSend = input.value
   if (req.url === '/restart') { await server.shutdownLifecycle(); await webhooks.dispose(); server.closeAllConnections(); await boot() }
   if (req.url === '/finish') { const run = store.listRuns().find(r => r.task.includes('deterministic fixture')); if (!run) throw new Error('No task'); store.updateRun(run.id, { status: 'done', completionReason: 'completed', finishedAt: new Date().toISOString() }) }
  }
  res.setHeader('Content-Type', 'application/json')
  const service = (await webhooks.get(project.id, root, true))[provider]
  const snapshot = JSON.stringify({ runs: store.listRuns(), events: store.listRuns().flatMap(run => store.readEvents(run.id).map(event => ({ ...event, runId: run.id }))), states: [...service.bots.values()].map(bot => bot.state.snapshot()), pairings: [...service.pairings.sessions.values()], seedId, calls, renewals, sent: wire.sent, callbacks: wire.callbacks, inbound: (await webhooks.get(project.id, root, true))[provider].list() })
  // Local synthetic evidence only. Never use this harness with platform credentials.
  writeFileSync(join(tmpdir(), provider + '-browser-' + process.env.PORT + '.json'), snapshot)
  res.end(snapshot)
 } catch (error) { res.statusCode = 500; res.end(JSON.stringify({ error: String(error) })) }
})
controls.listen(Number(process.env.PORT) + 1, '127.0.0.1')
let closing = false
async function close() {
 if (closing) return; closing = true
 controls.close()
 await server.shutdownLifecycle(); server.closeAllConnections(); await webhooks.dispose(); await wire.close()
 rmSync(root, { recursive: true, force: true }); process.exit(0)
}
process.on('SIGTERM', () => void close()); process.on('SIGINT', () => void close())
