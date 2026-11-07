import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { ChatTransportError, type ChatTransport } from '../chat/provider.ts'
import type { ChatConnectionOptions } from '../chat/connection.ts'
import { runBundledWorker } from './bundled-worker.ts'

function worker(factory: (host: Parameters<Parameters<typeof runBundledWorker>[1]>[1]) => Partial<ChatTransport>) {
  const input = new PassThrough(), frames: Record<string, unknown>[] = [], exits: number[] = []
  runBundledWorker('slack', (_config, host) => ({ guarded() { return this }, ...factory(host) }) as ChatTransport, {
    input, write: line => { frames.push(JSON.parse(line)) }, exit: code => { exits.push(code) }, log: () => {},
  })
  const send = (frame: Record<string, unknown>) => { input.write(`${JSON.stringify({ providerId: 'slack', generation: 'g1', ...frame })}\n`) }
  return { input, frames, exits, send }
}
const until = async (check: () => boolean) => { const end = Date.now() + 2_000; while (!check()) { if (Date.now() > end) throw new Error('timed out'); await new Promise(r => setTimeout(r, 5)) } }

describe('bundled worker loop', () => {
  it('ignores everything before start and answers a call right after it (#F2)', async () => {
    const w = worker(() => ({ identify: async () => ({ id: 'T1:U1', username: 'T1:U1' }) }))
    w.send({ type: 'call', requestId: 'early', operation: 'identify', input: {} })
    w.send({ type: 'start', config: {} })
    await until(() => w.frames.some(frame => frame.type === 'ready'))
    w.send({ type: 'call', requestId: 'r1', operation: 'identify', input: {} })
    await until(() => w.frames.some(frame => frame.requestId === 'r1'))
    expect(w.frames.find(frame => frame.requestId === 'r1')).toMatchObject({ ok: true, result: { id: 'T1:U1' } })
    expect(w.frames.some(frame => frame.requestId === 'early')).toBe(false)
  })

  it('drops frames from a stale generation', async () => {
    const w = worker(() => ({ identify: async () => ({ id: 'T1:U1', username: 'x' }) }))
    w.send({ type: 'start', config: {} })
    w.input.write(`${JSON.stringify({ type: 'call', providerId: 'slack', generation: 'old', requestId: 'r', operation: 'identify', input: {} })}\n`)
    // The same call one line later on the current generation: once it is answered, the stale one was read too.
    w.send({ type: 'call', requestId: 'current', operation: 'identify', input: {} })
    await until(() => w.frames.some(frame => frame.requestId === 'current'))
    expect(w.frames.filter(frame => frame.type === 'response').map(frame => frame.requestId)).toEqual(['current'])
  })

  it('a host cancel closes the wire guard before the effect (#F8)', async () => {
    let release!: () => void, guard!: () => boolean
    const w = worker(() => ({
      guarded(check: () => boolean) { guard = check; return this as ChatTransport },
      send: async () => { await new Promise<void>(r => { release = r }); if (!guard()) throw new ChatTransportError({ kind: 'blocked' }); return { chatId: 'c', messageId: 'm' } },
    }))
    w.send({ type: 'start', config: {} })
    w.send({ type: 'call', requestId: 's', operation: 'send', input: { chatId: 'c', message: { text: 'hi' } } })
    await until(() => typeof release === 'function')
    expect(guard()).toBe(true)
    w.send({ type: 'cancel', requestId: 's' })
    await until(() => !guard())
    release()
    await until(() => w.frames.some(frame => frame.requestId === 's'))
    expect(w.frames.find(frame => frame.requestId === 's')).toMatchObject({ ok: false, error: { failure: { kind: 'blocked' } } })
  })

  it('runs the provider connection with accept, credential checks and native commands as host requests (#F7)', async () => {
    let options!: ChatConnectionOptions
    const w = worker(() => ({ connect: (_journal, value) => { options = value; return { start() {}, stop: async () => {}, health: () => ({ state: 'polling' }) } } }))
    w.send({ type: 'start', config: {} })
    w.send({ type: 'connect' })
    await until(() => options !== undefined)
    expect(options.needed()).toBe(true)
    const accepted = options.accept({ kind: 'message', id: 'm1', chat: { id: 'private:T1:U1:D1', kind: 'private' }, user: { id: 'U2', label: 'U2' }, at: 1, text: 'x', messageId: '1.1', addressed: true } as never)
    await until(() => w.frames.some(frame => frame.method === 'accept'))
    const request = w.frames.find(frame => frame.method === 'accept')!
    // Accept is awaited: the provider's backpressure holds until the host answers it, even
    // while a later host request makes a whole round trip.
    let settled = false; void accepted.then(() => { settled = true })
    const tasks = options.nativeCommands!.tasks('fix', 'chat', 'user')
    await until(() => w.frames.some(frame => frame.method === 'nativeTasks'))
    w.send({ type: 'hostResponse', requestId: w.frames.find(frame => frame.method === 'nativeTasks')!.requestId, ok: true, result: [{ name: 'Fix', value: 'run-1' }] })
    await expect(tasks).resolves.toEqual([{ name: 'Fix', value: 'run-1' }])
    expect(settled).toBe(false)
    w.send({ type: 'hostResponse', requestId: request.requestId, ok: true })
    await accepted
    const check = options.assertCredentials()
    await until(() => w.frames.some(frame => frame.method === 'assertCredentials'))
    w.send({ type: 'hostResponse', requestId: w.frames.find(frame => frame.method === 'assertCredentials')!.requestId, ok: false, error: { message: 'no', failure: { kind: 'auth' } } })
    await expect(check).rejects.toBeInstanceOf(ChatTransportError)
  })

  it('exits when the host closes stdin, so a worker never outlives its host (#F10)', async () => {
    const w = worker(() => ({}))
    w.send({ type: 'start', config: {} })
    await until(() => w.frames.some(frame => frame.type === 'ready'))
    w.input.end()
    await until(() => w.exits.length === 1)
    expect(w.exits).toEqual([0])
  })

  it('refuses a configuration the provider rejects and exits non-zero', async () => {
    const input = new PassThrough(), frames: Record<string, unknown>[] = [], exits: number[] = []
    runBundledWorker('slack', () => { throw new Error('bad config') }, { input, write: line => { frames.push(JSON.parse(line)) }, exit: code => { exits.push(code) }, log: () => {} })
    input.write(`${JSON.stringify({ type: 'start', providerId: 'slack', generation: 'g', config: {} })}\n`)
    await until(() => exits.length === 1)
    expect(exits).toEqual([1])
    expect(frames).toEqual([{ type: 'health', providerId: 'slack', generation: 'g', state: 'blocked' }])
  })
})
