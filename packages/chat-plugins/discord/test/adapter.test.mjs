import test from 'node:test'
import assert from 'node:assert/strict'
import { discordRequest } from '../dist/adapter.js'
test('rejects private DNS answers', async () => { await assert.rejects(discordRequest('x'.repeat(60), { lookup: async () => [{ address: '127.0.0.1', family: 4 }] })('GET', '/users/@me'), e => e.failure?.kind === 'blocked') })
