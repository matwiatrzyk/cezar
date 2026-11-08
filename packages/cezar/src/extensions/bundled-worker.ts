// Worker half of the bundled chat boundary (spec 2026-11-07-bundled-chat-workers). It runs
// the SAME in-process transports and receive connections. Acceptance, Telegram journal/processing,
// credential checks, Slack rotation and Discord native-command lookups cross back to the host.
import { createInterface } from 'node:readline'
import { z } from 'zod'
import { ChatTransportError, chatEventSchema, chatMessageSchema, chatReceiptSchema, type ChatTransport } from '../chat/provider.ts'
import type { ChatConnection, ChatConnectionOptions, ReceiveJournal } from '../chat/connection.ts'
import { bundledHostFrameSchema, type BundledHostFrame } from './protocol.ts'
import { encodeFrame } from './rpc.ts'
import { fromBundledFailure, toBundledFailure } from './bundled-errors.ts'

type Method = 'accept' | 'assertCredentials' | 'rotate' | 'nativeTasks' | 'journal' | 'process'
export interface BundledWorkerHost { request(method: Method, params?: unknown, timeoutMs?: number): Promise<unknown> }
export type BundledWorkerFactory = (config: Record<string, string>, host: BundledWorkerHost) => ChatTransport
export interface BundledWorkerIo { input: NodeJS.ReadableStream; write(line: string): void; exit(code: number): void; log(line: string): void }

const chatIdInput = z.object({ chatId: z.string().min(1).max(512) }).strict()
const choices = z.array(z.object({ name: z.string().max(100), value: z.string().max(100) })).max(25)

export function runBundledWorker(providerId: 'slack' | 'discord' | 'telegram', create: BundledWorkerFactory, io: BundledWorkerIo = {
  input: process.stdin, write: line => { process.stdout.write(line) }, exit: code => { process.stdout.write('', () => process.exit(code)) }, log: line => { process.stderr.write(`${line}\n`) },
}): void {
  let generation = '', transport: ChatTransport | undefined, connection: ChatConnection | undefined, connected = false, stopping = false, sequence = 0
  const calls = new Map<string, AbortController>()
  const hostCalls = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>()
  const send = (frame: Record<string, unknown>) => { if (generation) io.write(encodeFrame({ providerId, generation, ...frame })) }
  const host: BundledWorkerHost = {
    request(method, params, timeoutMs) {
      return new Promise((resolve, reject) => {
        if (stopping) { reject(new ChatTransportError({ kind: 'blocked' })); return }
        const requestId = `host-${++sequence}`
        const timer = timeoutMs ? setTimeout(() => { if (hostCalls.delete(requestId)) reject(new ChatTransportError({ kind: 'transient' })) }, timeoutMs) : undefined
        timer?.unref()
        hostCalls.set(requestId, { resolve: value => { clearTimeout(timer); resolve(value) }, reject: error => { clearTimeout(timer); reject(error) } })
        try { send({ type: 'hostRequest', requestId, method, ...(params === undefined ? {} : { params }) }) } catch (error) { hostCalls.delete(requestId); clearTimeout(timer); reject(error instanceof Error ? error : new Error('host request failed')) }
      })
    },
  }
  const journalCall = (operation: string, args: unknown[] = []) => host.request('journal', { operation, args }, 30_000)
  const hostOwnedJournal: ReceiveJournal = {
    recover: async () => { await journalCall('recover') },
    assertReady: async () => { await journalCall('assertReady') },
    prepareReceive: async (now, idleResetMs) => { await journalCall('prepareReceive', [now, idleResetMs]) },
    snapshot: async () => z.object({epoch:z.string(),nextOffset:z.number().nullable()}).parse(await journalCall('snapshot')),
    duplicate: async (epoch, sequence) => z.boolean().parse(await journalCall('duplicate', [epoch, sequence])),
    finish: async (epoch, sequence) => { await journalCall('finish', [epoch, sequence]) },
    touch: async at => { await journalCall('touch', [at]) },
    flush: async () => { await journalCall('flush') },
  }
  const options: ChatConnectionOptions = {
    accept: async event => { await host.request('accept', { event: chatEventSchema.parse(event) }) },
    process: async (update, epoch) => { await host.request('process', { update, epoch }) },
    needed: () => connected && !stopping,
    assertCredentials: async () => { await host.request('assertCredentials', undefined, 15_000) },
    onHealth: health => { if (!stopping) send({ type: 'health', state: health.state }) },
    nativeCommands: { tasks: async (query, chatId, userId) => choices.parse(await host.request('nativeTasks', { query, chatId, userId }, 2_000)) },
  }
  const disconnect = async () => {
    connected = false
    const current = connection; connection = undefined
    await current?.stop()
  }
  const shutdown = async (code: number) => {
    if (stopping) return
    stopping = true
    for (const controller of calls.values()) controller.abort()
    for (const pending of hostCalls.values()) pending.reject(new ChatTransportError({ kind: 'blocked' }))
    hostCalls.clear()
    await Promise.race([disconnect(), new Promise(resolve => { setTimeout(resolve, 2_000).unref() })]).catch(() => undefined)
    io.exit(code)
  }
  const call = async (frame: Extract<BundledHostFrame, { type: 'call' }>) => {
    const controller = new AbortController(); calls.set(frame.requestId, controller)
    const signal = controller.signal
    // Re-checked by the wire right before its effect; a host cancel or shutdown flips it (#F8).
    const guarded = transport!.guarded(() => !signal.aborted && !stopping)
    try {
      const input = frame.input
      let result: unknown
      if (frame.operation === 'identify') result = await guarded.identify(signal)
      else if (frame.operation === 'inspect') result = await guarded.inspect(chatIdInput.parse(input).chatId)
      else if (frame.operation === 'send') { const x = chatIdInput.extend({ message: chatMessageSchema.passthrough() }).parse(input); result = await guarded.send(x.chatId, x.message, signal) }
      else if (frame.operation === 'clearButtons') result = await guarded.clearButtons(chatReceiptSchema.parse(input), signal)
      else if (frame.operation === 'acknowledge') { const x = z.object({ eventId: z.string().min(1).max(256), text: z.string().max(4000) }).strict().parse(input); result = await guarded.acknowledge(x.eventId, x.text, signal) }
      else { const x = chatIdInput.extend({ userId: z.string().min(1).max(256) }).parse(input); result = await guarded.isMember(x.chatId, x.userId, signal) }
      send({ type: 'response', requestId: frame.requestId, ok: true, ...(result === undefined ? {} : { result }) })
    } catch (error) {
      send({ type: 'response', requestId: frame.requestId, ok: false, error: toBundledFailure(signal.aborted ? new ChatTransportError({ kind: 'blocked' }) : error) })
    } finally { calls.delete(frame.requestId) }
  }
  const handle = async (frame: BundledHostFrame) => {
    if (frame.providerId !== providerId) return
    if (frame.type === 'start') {
      if (generation) return
      generation = frame.generation
      try { transport = create(frame.config, host) } catch (error) {
        io.log(`bundled ${providerId} worker rejected its configuration: ${error instanceof Error ? error.message : String(error)}`)
        send({ type: 'health', state: 'blocked' }); await shutdown(1); return
      }
      send({ type: 'ready' }); return
    }
    // Before start there is no generation, so nothing else can match: the host always starts first.
    if (frame.generation !== generation || !transport) return
    if (frame.type === 'call') { if (!stopping) void call(frame); return }
    if (frame.type === 'cancel') { calls.get(frame.requestId)?.abort(); return }
    if (frame.type === 'hostResponse') {
      const pending = hostCalls.get(frame.requestId); if (!pending) return
      hostCalls.delete(frame.requestId)
      if (frame.ok) pending.resolve(frame.result); else pending.reject(fromBundledFailure(frame.error))
      return
    }
    if (frame.type === 'connect') {
      if (connection || connected || stopping) return
      connected = true
      // Every fresh worker (including automatic restarts) needs its receive identity.
      if (providerId === 'telegram') await transport.identify()
      if (stopping || !connected) return
      connection = transport.connect(hostOwnedJournal, options)
      connection.start(); return
    }
    if (frame.type === 'disconnect') { await disconnect(); return }
    await shutdown(0)
  }
  const lines = createInterface({ input: io.input, crlfDelay: Infinity })
  lines.on('line', line => {
    let frame: BundledHostFrame
    try { frame = bundledHostFrameSchema.parse(JSON.parse(line)) } catch { return }
    void handle(frame).catch(error => io.log(`bundled ${providerId} worker frame failed: ${error instanceof Error ? error.message : String(error)}`))
  })
  // The host owns this process: a closed stdin means the host is gone, so never linger (#F10 orphans).
  lines.on('close', () => { void shutdown(0) })
}
