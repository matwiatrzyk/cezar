import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
const root = mkdtempSync(join(tmpdir(), 'cezar-telegram-inbound-e2e-'))
for (const key of Object.keys(process.env)) if (key.startsWith('CEZ_')) delete process.env[key]
Object.assign(process.env, { CEZ_HOME: join(root, '.home'), CEZ_DRY_RUN: '1', CEZ_WEBHOOKS: '1', CEZ_CHAT_INBOUND: '1', CEZ_NO_BANNER: '1', CEZ_SKILLS_AUTO_UPDATE: '0', CEZ_AUTOMATIONS: '0', CEZ_TELEMETRY: '0' })
execFileSync('git', ['init', '-q'], { cwd: root })
const [{ WebhookCoordinator }, { RunStore }, { RunManager }, { startServer }, { registerProject }] = await Promise.all([
  import('../../cezar/src/webhooks/coordinator.ts'), import('../../cezar/src/runs/store.ts'), import('../../cezar/src/workflows/run.ts'), import('../../cezar/src/server/server.ts'), import('../../cezar/src/workspace/projects.ts'),
])
const project = await registerProject(root), store = RunStore.open(join(root, '.ai/cezar')), manager = new RunManager(store, root)
let wake, sequence = 1
const updates = []
const fakeCall = async (method, body, signal) => {
  if (method === 'getMe') return { id: 123456, username: 'fixture_bot', first_name: 'Fixture bot' }
  if (method === 'getUpdates') {
    if (!updates.length) await new Promise(resolve => {
      const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve() }
      const timer = setTimeout(done, 500)
      wake = done
      signal?.addEventListener('abort', done, { once: true })
    })
    return updates.splice(0)
  }
  if (method === 'sendMessage') return { message_id: ++sequence, chat: { id: Number(body.chat_id) } }
  return true
}
const webhooks = new WebhookCoordinator({ mode: () => 'local', ports: () => [], projects: async () => [{ ...project, status: 'ready' }], dryRun: true, telegramCall: () => fakeCall })
const service = await webhooks.get(project.id, root, true)
const { receiver } = await service.create({ name: 'Telegram inbound fixture', format: 'telegram.v1', url: `https://api.telegram.org/bot123456:${'x'.repeat(35)}/sendMessage`, telegramChatId: '456', profile: 'standard', graceSeconds: 0 })
await service.test(receiver.id, { expectedRevision: receiver.revision, deliveryRevision: receiver.deliveryRevision, operationId: 'fixture-test' })
await service.tick()
await service.activate(receiver.id, service.list().receivers[0].revision)
// Simulation is fixture-local: pairing creates a Telegram update, never a real network request.
const create = service.telegram.pairings.create.bind(service.telegram.pairings)
service.telegram.pairings.create = (...args) => {
  const result = create(...args), code = new URL(result.deepLink).searchParams.get('start')
  updates.push({ update_id: ++sequence, message: { message_id: sequence, date: Math.ceil(Date.now() / 1000), chat: { id: 456, type: 'private' }, from: { id: 456, is_bot: false, first_name: 'Fixture person' }, text: `/start ${code}`, entities: [{ type: 'bot_command', offset: 0, length: 6 }] } })
  wake?.(); return result
}
const server = startServer({ repoRoot: root, bootProjectId: project.id, store, manager, webhooks, version: 'test' }, Number(process.env.PORT))
let closing = false
async function close() {
  if (closing) return; closing = true
  await server.shutdownLifecycle(); await webhooks.dispose(); store.flush()
  rmSync(root, { recursive: true, force: true }); process.exit(0)
}
process.on('SIGTERM', () => void close()); process.on('SIGINT', () => void close())
