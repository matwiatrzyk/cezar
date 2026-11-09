import test from 'node:test'
import assert from 'node:assert/strict'
import { discordRequest, createDiscordAdapter } from '../dist/adapter.js'
import { parseChat } from '../dist/identity.js'
test('rejects private DNS answers', async () => { await assert.rejects(discordRequest('x'.repeat(60), { lookup: async () => [{ address: '127.0.0.1', family: 4 }] })('GET', '/users/@me'), e => e.failure?.kind === 'blocked') })
test('canonical chat ids reject extra and malformed segments', () => {
 assert.throws(() => parseChat('discord:dm:12345678901234567:extra'))
 assert.throws(() => parseChat('discord:guild:12345678901234567'))
 assert.throws(() => parseChat('discord:guild:12345678901234567:01234567890123456'))
 assert.equal(parseChat('discord:guild:12345678901234567:22345678901234567').kind, 'group')
})
test('REST gateway discovery rejects a non-Discord websocket host', async () => {
 const request = async (_method, path) => path === '/gateway/bot' ? { url: 'wss://evil.example/' } : {}
 const adapter = createDiscordAdapter({ token: 'x' }, request)
 await assert.rejects(adapter.receive(null), e => e.failure?.kind === 'blocked')
})
