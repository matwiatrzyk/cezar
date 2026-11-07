import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { ChatTransportError } from '../chat/provider.ts'
import { bundledWorkerFrameSchema, type BundledHostFrame, type BundledWorkerFrame } from './protocol.ts'
import { encodeFrame, MAX_FRAME_BYTES } from './rpc.ts'
import { fromBundledFailure, toBundledFailure } from './bundled-errors.ts'
import type { BundledProviderManifest } from './bundled-catalog.ts'

type Health = Extract<BundledWorkerFrame, { type: 'health' }>['state']
type HostMethod = Extract<BundledWorkerFrame, { type: 'hostRequest' }>['method']
type Operation = Extract<BundledHostFrame, { type: 'call' }>['operation']

export type BundledProviderContext = {
  /** Package root used to resolve the catalog's provider-relative entry. */
  packageRoot: string
  /** Copied into the start frame. Never a host object; Slack refresh tokens and secrets stay out. */
  config: Record<string, string>
  /** Narrow host services (accept, credential checks, Slack rotation, Discord native commands). */
  onHostRequest(method: HostMethod, params: unknown, signal: AbortSignal): Promise<unknown>
  onHealth?(state: Health): void
  /** Unexpected exit only; every pending call is already rejected. */
  onExit?(error: Error): void
  log?(line: string): void
  /** Test seam: Node flags for the child (loader hooks for fake endpoints). */
  execArgv?: readonly string[]
  env?: NodeJS.ProcessEnv
  readyTimeoutMs?: number
  callTimeoutMs?: number
  stopTimeoutMs?: number
}
export type BundledCallOptions = { signal?: AbortSignal; valid?: () => boolean; timeoutMs?: number }
export type BundledProviderHandle = {
  readonly providerId: 'slack' | 'discord'
  readonly generation: string
  readonly process: ChildProcessWithoutNullStreams
  readonly alive: boolean
  call(operation: Operation, input?: unknown, options?: BundledCallOptions): Promise<unknown>
  connect(): void
  disconnect(): void
  stop(): Promise<void>
}

// Network-relevant variables only: never PATH, HOME, credentials or NODE_OPTIONS (#F10).
const FORWARDED_ENV = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS', 'NODE_USE_ENV_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR']
export function bundledWorkerEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = { NODE_ENV: 'production' }
  for (const key of FORWARDED_ENV) { const value = env[key]; if (typeof value === 'string') out[key] = value }
  return out
}

const READY_TIMEOUT_MS = 10_000, CALL_TIMEOUT_MS = 60_000, STOP_TIMEOUT_MS = 3_000, FENCE_POLL_MS = 100
const HOST_REQUEST_CAP = 128, STDERR_LINES_PER_MINUTE = 50

/** Spawn one bundled worker and resolve once it has acknowledged its generation. */
export async function startBundledProvider(manifest: BundledProviderManifest, context: BundledProviderContext): Promise<BundledProviderHandle> {
  const providerId = manifest.id
  const generation = randomUUID()
  const entry = resolve(context.packageRoot, 'dist', 'bundled-chat', manifest.id, manifest.entry)
  const child = spawn(process.execPath, [...(context.execArgv ?? []), entry], { cwd: dirname(entry), stdio: ['pipe', 'pipe', 'pipe'], env: bundledWorkerEnv(context.env) })
  const log = context.log ?? (line => console.warn(line))
  let alive = true, stopping = false
  let exited!: () => void
  const exit = new Promise<void>(done => { exited = done })
  const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>()
  const hosted = new Map<string, AbortController>()
  let sequence = 0
  let ready: { resolve(): void; reject(error: Error): void } | undefined

  const write = (frame: Record<string, unknown>) => {
    if (!alive || !child.stdin.writable) throw new ChatTransportError({ kind: 'transient' })
    child.stdin.write(encodeFrame({ providerId, generation, ...frame }))
  }
  const rejectAll = (error: Error) => {
    for (const request of pending.values()) request.reject(error)
    pending.clear()
    for (const controller of hosted.values()) controller.abort()
    hosted.clear()
  }
  child.stdin.on('error', () => undefined)
  // Drain stderr so a chatty worker never blocks on a full pipe; forward a capped sample.
  let window = { start: Date.now(), count: 0 }
  createInterface({ input: child.stderr, crlfDelay: Infinity }).on('line', line => {
    if (Date.now() - window.start >= 60_000) window = { start: Date.now(), count: 0 }
    if (++window.count <= STDERR_LINES_PER_MINUTE) log(`[bundled ${providerId}] ${line.slice(0, 500)}`)
  })
  const onExit = (error: Error) => {
    if (!alive) return
    alive = false
    rejectAll(stopping ? new ChatTransportError({ kind: 'blocked' }) : new ChatTransportError({ kind: 'transient' }))
    ready?.reject(error); ready = undefined
    exited()
    if (!stopping) context.onExit?.(error)
  }
  child.once('error', error => onExit(error))
  child.once('exit', (code, signal) => onExit(new Error(`bundled ${providerId} worker exited (${code ?? signal ?? 'unknown'})`)))

  const answer = async (frame: Extract<BundledWorkerFrame, { type: 'hostRequest' }>) => {
    if (stopping || hosted.size >= HOST_REQUEST_CAP) {
      try { write({ type: 'hostResponse', requestId: frame.requestId, ok: false, error: toBundledFailure(new ChatTransportError({ kind: stopping ? 'blocked' : 'transient' })) }) } catch { /* gone */ }
      return
    }
    const controller = new AbortController(); hosted.set(frame.requestId, controller)
    try {
      const result = await context.onHostRequest(frame.method, frame.params, controller.signal)
      if (hosted.delete(frame.requestId)) write({ type: 'hostResponse', requestId: frame.requestId, ok: true, ...(result === undefined ? {} : { result }) })
    } catch (error) {
      if (hosted.delete(frame.requestId)) try { write({ type: 'hostResponse', requestId: frame.requestId, ok: false, error: toBundledFailure(error) }) } catch { /* gone */ }
    }
  }
  const protocolError = (reason: string) => { log(`[bundled ${providerId}] protocol error: ${reason}; killing worker`); child.kill('SIGKILL') }
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
  lines.on('line', line => {
    if (Buffer.byteLength(line) > MAX_FRAME_BYTES) return protocolError('frame exceeds 1 MiB')
    let raw: unknown
    try { raw = JSON.parse(line) } catch { return protocolError('invalid JSON frame') }
    const parsed = bundledWorkerFrameSchema.safeParse(raw)
    if (!parsed.success) return protocolError('invalid frame')
    const frame = parsed.data
    // A frame from another generation or provider is fenced, never delivered.
    if (frame.generation !== generation || frame.providerId !== providerId) return
    if (frame.type === 'ready') { ready?.resolve(); ready = undefined; return }
    if (frame.type === 'health') { if (!stopping) context.onHealth?.(frame.state); return }
    if (frame.type === 'hostRequest') { void answer(frame); return }
    const request = pending.get(frame.requestId)
    if (!request) return
    pending.delete(frame.requestId)
    if (frame.ok) request.resolve(frame.result); else request.reject(fromBundledFailure(frame.error))
  })

  const handle: BundledProviderHandle = {
    providerId, generation, process: child,
    get alive() { return alive && !stopping },
    call(operation, input = {}, options = {}) {
      return new Promise((resolveCall, rejectCall) => {
        if (stopping || !alive || options.signal?.aborted || options.valid?.() === false) { rejectCall(new ChatTransportError({ kind: stopping || !alive ? 'transient' : 'blocked' })); return }
        const requestId = `call-${++sequence}`
        let fence: ReturnType<typeof setInterval> | undefined, timer: ReturnType<typeof setTimeout> | undefined
        const settle = () => { clearInterval(fence); clearTimeout(timer); options.signal?.removeEventListener('abort', onAbort); pending.delete(requestId) }
        // Cancel crosses the boundary: the worker aborts the request before its next wire effect (#F8).
        const cancel = (error: Error = new ChatTransportError({ kind: 'blocked' })) => {
          if (!pending.has(requestId)) return
          settle(); try { write({ type: 'cancel', requestId }) } catch { /* gone */ }
          rejectCall(error)
        }
        const onAbort = () => cancel()
        pending.set(requestId, { resolve: value => { settle(); resolveCall(value) }, reject: error => { settle(); rejectCall(error) } })
        options.signal?.addEventListener('abort', onAbort, { once: true })
        if (options.valid) { fence = setInterval(() => { if (!options.valid!()) cancel() }, FENCE_POLL_MS); fence.unref() }
        timer = setTimeout(() => cancel(new ChatTransportError({ kind: 'transient' })), options.timeoutMs ?? context.callTimeoutMs ?? CALL_TIMEOUT_MS); timer.unref()
        try { write({ type: 'call', requestId, operation, input }) } catch (error) { settle(); rejectCall(error instanceof Error ? error : new ChatTransportError({ kind: 'transient' })) }
      })
    },
    connect() { write({ type: 'connect' }) },
    disconnect() { write({ type: 'disconnect' }) },
    async stop() {
      if (stopping) return exit
      stopping = true
      rejectAll(new ChatTransportError({ kind: 'blocked' }))
      if (!alive) return exit
      try { write({ type: 'stop' }) } catch { /* gone */ }
      const wait = (ms: number) => Promise.race([exit.then(() => true), new Promise<boolean>(done => { const t = setTimeout(() => done(false), ms); t.unref() })])
      const grace = context.stopTimeoutMs ?? STOP_TIMEOUT_MS
      if (await wait(grace)) return
      child.kill('SIGTERM')
      if (await wait(2_000)) return
      child.kill('SIGKILL')
      await wait(2_000)
    },
  }

  try {
    await new Promise<void>((resolveReady, rejectReady) => {
      ready = { resolve: resolveReady, reject: rejectReady }
      const timer = setTimeout(() => { if (ready) { ready = undefined; rejectReady(new Error(`bundled ${providerId} worker did not become ready`)) } }, context.readyTimeoutMs ?? READY_TIMEOUT_MS)
      timer.unref()
      void exit.then(() => clearTimeout(timer))
      try { write({ type: 'start', config: context.config }) } catch { /* the exit handler rejects */ }
    })
  } catch (error) {
    await handle.stop()
    throw error
  }
  return handle
}
