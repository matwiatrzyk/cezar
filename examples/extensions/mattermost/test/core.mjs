// Repository-only integration: the real adapter + core normalizer/conversation/actions.
// The task-creation boundary is recorded; no paid agent or Mattermost server is started.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fixture, id, post } from './fixture.mjs'
import { ChatInbox } from '../../../../packages/cezar/src/chat/inbox.ts'
import { ChatActions } from '../../../../packages/cezar/src/chat/actions.ts'
import { ChatConversation } from '../../../../packages/cezar/src/chat/conversation.ts'
import { freshState, InboundStateStore } from '../../../../packages/cezar/src/chat/state.ts'
import { extensionChatDescriptor } from '../../../../packages/cezar/src/extensions/chat-bridge.ts'
import { readFile } from 'node:fs/promises'

const manifest = JSON.parse(await readFile(new URL('../cezar-extension.json', import.meta.url)))
async function setup() {
  const x = await fixture(), root = await mkdtemp(join(tmpdir(), 'mattermost-core-'))
  const oldHome = process.env.CEZ_HOME
  process.env.CEZ_HOME = join(root, 'home')
  let clock = x.now; const generation = randomUUID()
  const initial = freshState(id('b'), { projectId: 'project', installationId: 'instance', root, generation: randomUUID() }, 'open-mercato.mattermost/chat')
  initial.receivers.push({ receiverId: 'receiver', chatId: x.chat, enabled: true, generation, acceptAfter: 0, deliveryRevision: 1, credentialFingerprint: 'a'.repeat(64) })
  initial.grants.push({ id: randomUUID(), receiverId: 'receiver', chatId: x.chat, userId: id('u'), label: 'Person', permissions: ['respond', 'start'], capability: 'task_control', generation: randomUUID(), enableGeneration: generation, approvedAt: 0 })
  let disk = structuredClone(initial)
  const state = new InboundStateStore(initial, { assertOwner() {}, async write(next) { disk = structuredClone(next) }, now: () => clock })
  const receiver = { id: 'receiver', format: 'open-mercato.mattermost/chat.v1', state: 'active', lastTest: 'success', profile: 'standard', events: ['task.attention_required'], chatId: x.chat, deliveryRevision: 1, chatSecret: { sha256: 'a'.repeat(64) } }
  const presentation = extensionChatDescriptor(manifest.id, manifest.contributes.chatProviders[0]).presentation
  const effects = [], sends = []
  const reply = (chat, text, valid, sent, buttons, replyTo) => {
    if (valid()) sends.push(x.adapter.send(chat, { text, buttons, replyTo }).then(receipt => sent?.(receipt)))
  }
  const actions = new ChatActions({ botId: id('b'), state, presentation, session: x.adapter, now: () => clock, reply() {} })
  const conversation = new ChatConversation({ botId: id('b'), username: 'bot', state, presentation, now: () => clock,
    receiver: () => receiver, receivers: () => [receiver], context: async () => ({ id: 'project', root, store: { listRuns: () => [] } }),
    episode() {}, reply, actions,
    async createTask(_project, text, source, check) {
      assert.equal(check(), undefined)
      assert.equal(disk.journal.at(-1).state, 'claimed')
      effects.push(text)
      return { created: true, runId: source.runId }
    },
  })
  const inbox = new ChatInbox(state, (update, epoch) => update.button ? actions.process(update, epoch) : conversation.process(update, epoch))
  let after = null, next = 1
  async function receive(message, extra = {}) {
    const incoming = post(next++, { message, ...extra })
    x.posts.push(incoming)
    for (let attempt = 0; attempt < 8; attempt++) {
      const rows = await x.adapter.receive(after)
      for (const row of rows) { await inbox.accept(row.event); after = row.sequence }
      await Promise.all(sends)
      if (rows.some(row => row.event.id === incoming.id)) return
    }
    assert.fail('incoming post not received')
  }
  await receive('cezar task implement the authorized fix')
  assert.equal(effects.length, 0, 'request must only preview')
  const command = x.sent.find(row => row.message.includes('Confirm:'))?.message.match(/Confirm: `([^`]+)`/)?.[1]
  assert.ok(command, 'real core preview must expose a usable confirmation')
  return { ...x, effects, receive, command, actions, state, advance(ms) { clock += ms },
    async close() { await x.close(); await rm(root, { recursive: true, force: true }); if (oldHome === undefined) delete process.env.CEZ_HOME; else process.env.CEZ_HOME = oldHome } }
}

test('request → generated text → receive → core: other person/chat rejected, valid confirmation starts once', async () => {
  const x = await setup()
  try {
    await x.receive(x.command, { user_id: id('other') })
    await x.receive(x.command, { channel_id: id('g') })
    assert.equal(x.effects.length, 0)
    await x.receive(x.command)
    assert.deepEqual(x.effects, ['implement the authorized fix'])
    await x.receive(x.command)
    assert.equal(x.effects.length, 1)
  } finally { await x.close() }
})
for (const reason of ['expiry', 'core restart', 'worker restart', 'revocation']) {
  test('generated control cannot authorize after ' + reason, async () => {
    const x = await setup()
    try {
      if (reason === 'expiry') x.advance(120_000)
      if (reason === 'core restart') x.actions.clear()
      if (reason === 'worker restart') await x.restart()
      if (reason === 'revocation') await x.state.change(state => { state.grants = [] })
      await x.receive(x.command)
      assert.equal(x.effects.length, 0)
    } finally { await x.close() }
  })
}

test('generated Cancel choice declines the core task preview', async () => {
  const x = await setup()
  try {
    const command = x.sent.find(row => row.message.includes('Cancel:')).message.match(/Cancel: `([^`]+)`/)[1]
    await x.receive(command)
    assert.equal(x.effects.length, 0)
    assert.ok(x.state.snapshot().journal.some(row => row.reason === 'declined'))
    await x.receive(x.command)
    assert.equal(x.effects.length, 0, 'Cancel consumes its sibling Confirm capability')
  } finally { await x.close() }
})

for (const gap of [0, 101]) {
  test(`earlier Cancel wins over Confirm in one catch-up (${gap} intervening posts)`, async () => {
    const x = await setup()
    try {
      const cancel = x.sent.find(row => row.message.includes('Cancel:')).message.match(/Cancel: `([^`]+)`/)[1]
      x.posts.push(post(900, { message: cancel, create_at: x.now }))
      x.posts.push(...Array.from({ length: gap }, (_, n) => post(1000 + n, { message: 'ignored', user_id: id('b'), create_at: x.now + 1 })))
      await x.receive(x.command, { create_at: x.now + 2 })
      assert.equal(x.effects.length, 0, 'earlier Cancel must consume capability before later Confirm')
      assert.ok(x.state.snapshot().journal.some(row => row.reason === 'declined'))
    } finally { await x.close() }
  })
}
