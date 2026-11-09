import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createSlackAdapter, slackRequest } from '../dist/adapter.js'

const creds = { appToken: 'xapp-' + 'A'.repeat(20), botToken: 'xoxb-' + 'B'.repeat(20) }
const op = { signal: new AbortController().signal, assertActive: async () => {} }
const rows = [
  { envelope_id: 'e1', type: 'events_api', event_id: 'ev1', payload: { team_id: 'T1', authorizations: [{ user_id: 'U1', is_bot: true }], event: { type: 'message', channel: 'C1', user: 'U2', ts: '1800000000.000001', channel_type: 'channel', text: '<@U1> hello' } } },
]
test('Slack adapter uses mocked API and normalizes a Socket Mode message', async () => {
  const calls = []
  const request = async (method, body) => {
    calls.push([method, body])
    if (method === 'auth.test') return { ok: true, team_id: 'T1', user_id: 'U1', user: 'cezar' }
    if (method === 'apps.connections.open') return { ok: true, url: 'wss://slack.com/socket' }
    if (method === 'conversations.info') return { ok: true, channel: { id: 'C1', is_im: false, is_member: true } }
    if (method === 'chat.postMessage') return { ok: true, channel: 'C1', ts: '1800000001.000001' }
    if (method === 'conversations.members') return { ok: true, members: ['U2'] }
    return { ok: true }
  }
  const adapter = createSlackAdapter(creds, request)
  assert.deepEqual(await adapter.identify(op), { id: 'T1:U1', username: 'cezar', discoveryUrl: 'https://api.slack.com/apps' })
  assert.deepEqual(await adapter.send('group:T1:U1:C1', { text: 'hello' }, op), { chatId: 'group:T1:U1:C1', messageId: '1800000001.000001' })
  assert.equal(await adapter.isMember('group:T1:U1:C1', 'U2', op), true)
  assert.ok(calls.some(([method]) => method === 'chat.postMessage'))
  await adapter.dispose()
})

test('credentials and destination identity fail closed', () => {
  assert.throws(() => createSlackAdapter({ appToken: 'bad', botToken: 'bad' }), /Chat transport: auth/)
})

test('Slack API transport rejects private DNS answers before dialing', async () => {
  let dialed = false
  const request = slackRequest(creds, { lookup: async () => [{ address: '127.0.0.1', family: 4 }], request: async () => { dialed = true; throw new Error('must not dial') } })
  await assert.rejects(request('auth.test', {}, op), /Chat transport: blocked/)
  assert.equal(dialed, false)
})
