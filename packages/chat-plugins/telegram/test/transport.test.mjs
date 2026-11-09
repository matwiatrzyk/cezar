import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'
import { telegramRequest } from '../dist/adapter.js'

const token = `123456:${'A'.repeat(24)}`
test('transport validates and pins public DNS while bounding the streamed response', async () => {
  let connect
  const call = telegramRequest(token, {
    lookup: async () => [{ address: '8.8.8.8', family: 4 }],
    request: async (_url, options) => {
      connect = options.dispatcher[Object.getOwnPropertySymbols(options.dispatcher).find(symbol => String(symbol).includes('options'))]?.connect
      return { statusCode: 200, body: Readable.from([JSON.stringify({ ok: true, result: { id: 1 } })]) }
    },
  })
  assert.deepEqual(await call('getMe', {}), { id: 1 })
  assert.ok(connect === undefined || typeof connect === 'object')

  const blocked = telegramRequest(token, { lookup: async () => [{ address: '127.0.0.1', family: 4 }], request: async () => assert.fail('wire called') })
  await assert.rejects(blocked('getMe', {}), error => error.failure?.kind === 'blocked')

  const controller = new AbortController()
  const stalled = telegramRequest(token, { lookup: async () => new Promise(() => {}), request: async () => assert.fail('wire called') })
  const pending = stalled('getMe', {}, { signal: controller.signal, assertActive: async () => {} })
  await new Promise(resolve => setImmediate(resolve))
  controller.abort()
  await assert.rejects(pending, error => error.failure?.kind === 'blocked')

  const oversized = telegramRequest(token, { lookup: async () => [{ address: '8.8.8.8', family: 4 }],
    request: async () => ({ statusCode: 200, body: Readable.from([Buffer.alloc(1024 * 1024), Buffer.from('x')]) }) })
  await assert.rejects(oversized('getMe', {}), error => error.failure?.kind === 'blocked')
})
