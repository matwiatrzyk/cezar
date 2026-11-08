import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { ChatTransportError } from '../chat/provider.ts'
import { bundledWorkerFrameSchema, type BundledHostFrame, type BundledWorkerFrame } from './protocol.ts'
import { fromBundledFailure, toBundledFailure } from './bundled-errors.ts'
import type { BundledProviderManifest } from './bundled-catalog.ts'
import { spawnWorkerProcess } from './worker-process.ts'

type Health = Extract<BundledWorkerFrame, { type: 'health' }>['state']
type HostMethod = Extract<BundledWorkerFrame, { type: 'hostRequest' }>['method']
type HostRequestFrame = Extract<BundledWorkerFrame, { type: 'hostRequest' }>
type Operation = Extract<BundledHostFrame, { type: 'call' }>['operation']

export type BundledProviderContext = {
  /** Package root used to resolve the catalog's provider-relative entry. */
  packageRoot: string
  /** Copied into the start frame. Never a host object; Slack refresh tokens and secrets stay out. */
  config: Record<string, string>
  /** Narrow host services (accept, credential checks, Slack rotation, Discord native commands). */
  onHostRequest(method: HostMethod, params: unknown, signal: AbortSignal): Promise<unknown>
  onHealth?(state: Health): void
  /** An unexpected exit of a READY worker; every pending call is already rejected. A worker that
   *  dies during the start handshake only rejects `startBundledProvider` (H1). */
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
  readonly providerId: 'slack' | 'discord' | 'telegram'
  readonly generation: string
  readonly process: ChildProcessWithoutNullStreams
  readonly alive: boolean
  call(operation: Operation, input?: unknown, options?: BundledCallOptions): Promise<unknown>
  connect(): void
  disconnect(): void
  stop(): Promise<void>
}

const READY_TIMEOUT_MS = 10_000
const CALL_TIMEOUT_MS = 60_000
const STOP_TIMEOUT_MS = 3_000
const FENCE_POLL_MS = 100
const HOST_REQUEST_CAP = 128

type Pending = { resolve(value: unknown): void; reject(error: Error): void }
const transient = () => new ChatTransportError({ kind: 'transient' })
const blocked = () => new ChatTransportError({ kind: 'blocked' })

/** Spawn one bundled worker and resolve once it has acknowledged its generation. */
export async function startBundledProvider(
  manifest: BundledProviderManifest,
  context: BundledProviderContext,
): Promise<BundledProviderHandle> {
  const providerId = manifest.id
  const generation = randomUUID()
  const entry = resolve(context.packageRoot, 'dist', 'bundled-chat', manifest.id, manifest.entry)
  const log = context.log ?? (line => console.warn(line))
  const pending = new Map<string, Pending>()
  const hosted = new Map<string, AbortController>()
  let stopping = false
  let started = false
  let sequence = 0
  let ready: { resolve(): void; reject(error: Error): void } | undefined

  const rejectAll = (error: Error) => {
    for (const request of pending.values()) request.reject(error)
    pending.clear()
    for (const controller of hosted.values()) controller.abort()
    hosted.clear()
  }

  const worker = spawnWorkerProcess({
    label: `[bundled ${providerId}]`,
    args: [...(context.execArgv ?? []), entry],
    cwd: dirname(entry),
    ...(context.env ? { env: context.env } : {}),
    log,
    forwardStderr: true,
    onFrame: raw => onFrame(raw),
    onExit: error => {
      rejectAll(stopping ? blocked() : transient())
      if (ready) {
        // Still handshaking: the start rejection is the only signal, never a crash report too.
        ready.reject(error)
        ready = undefined
        return
      }
      if (started && !stopping) context.onExit?.(error)
    },
  })

  const write = (frame: Record<string, unknown>) => {
    if (!worker.alive) throw transient()
    try { worker.write({ providerId, generation, ...frame }) } catch { throw transient() }
  }
  const tryWrite = (frame: Record<string, unknown>) => {
    try { write(frame) } catch { /* the worker is gone */ }
  }

  const answer = async (frame: HostRequestFrame) => {
    const respond = (body: Record<string, unknown>) => tryWrite({ type: 'hostResponse', requestId: frame.requestId, ...body })
    if (stopping || hosted.size >= HOST_REQUEST_CAP) {
      respond({ ok: false, error: toBundledFailure(stopping ? blocked() : transient()) })
      return
    }
    const controller = new AbortController()
    hosted.set(frame.requestId, controller)
    try {
      const result = await context.onHostRequest(frame.method, frame.params, controller.signal)
      if (hosted.delete(frame.requestId)) respond({ ok: true, ...(result === undefined ? {} : { result }) })
    } catch (error) {
      if (hosted.delete(frame.requestId)) respond({ ok: false, error: toBundledFailure(error) })
    }
  }

  function onFrame(raw: unknown) {
    const parsed = bundledWorkerFrameSchema.safeParse(raw)
    if (!parsed.success) throw new Error('invalid frame')
    const frame = parsed.data
    // A frame from another generation or provider is fenced, never delivered.
    if (frame.generation !== generation || frame.providerId !== providerId) return
    switch (frame.type) {
      case 'ready':
        ready?.resolve()
        ready = undefined
        return
      case 'health':
        if (!stopping) context.onHealth?.(frame.state)
        return
      case 'hostRequest':
        void answer(frame)
        return
      case 'response': {
        worker.answered()
        const request = pending.get(frame.requestId)
        if (!request) return
        pending.delete(frame.requestId)
        if (frame.ok) request.resolve(frame.result)
        else request.reject(fromBundledFailure(frame.error))
      }
    }
  }

  const call = (operation: Operation, input: unknown = {}, options: BundledCallOptions = {}) =>
    new Promise<unknown>((resolveCall, rejectCall) => {
      if (stopping || !worker.alive) return rejectCall(transient())
      if (options.signal?.aborted || options.valid?.() === false) return rejectCall(blocked())
      const requestId = `call-${++sequence}`
      let fence: ReturnType<typeof setInterval> | undefined
      let timer: ReturnType<typeof setTimeout> | undefined
      const settle = () => {
        clearInterval(fence)
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', onAbort)
        pending.delete(requestId)
      }
      // Cancel crosses the boundary: the worker aborts the request before its next wire effect (#F8).
      const cancel = (error: Error = blocked()) => {
        if (!pending.has(requestId)) return
        settle()
        tryWrite({ type: 'cancel', requestId })
        rejectCall(error)
      }
      const onAbort = () => cancel()
      pending.set(requestId, {
        resolve: value => { settle(); resolveCall(value) },
        reject: error => { settle(); rejectCall(error) },
      })
      options.signal?.addEventListener('abort', onAbort, { once: true })
      if (options.valid) {
        const valid = options.valid
        fence = setInterval(() => { if (!valid()) cancel() }, FENCE_POLL_MS)
        fence.unref()
      }
      timer = setTimeout(() => {
        cancel(transient())
        if (!stopping) worker.timedOut()
      }, options.timeoutMs ?? context.callTimeoutMs ?? CALL_TIMEOUT_MS)
      timer.unref()
      try { write({ type: 'call', requestId, operation, input }) } catch (error) {
        settle()
        rejectCall(error instanceof Error ? error : transient())
      }
    })

  let stopped: Promise<void> | undefined
  const handle: BundledProviderHandle = {
    providerId,
    generation,
    process: worker.child,
    get alive() { return worker.alive && !stopping },
    call,
    connect() { write({ type: 'connect' }) },
    disconnect() { write({ type: 'disconnect' }) },
    stop() {
      stopped ??= (async () => {
        stopping = true
        rejectAll(blocked())
        tryWrite({ type: 'stop' })
        await worker.stop(context.stopTimeoutMs ?? STOP_TIMEOUT_MS)
      })()
      return stopped
    },
  }

  try {
    await new Promise<void>((resolveReady, rejectReady) => {
      ready = { resolve: resolveReady, reject: rejectReady }
      const timer = setTimeout(() => {
        if (!ready) return
        ready = undefined
        rejectReady(new Error(`bundled ${providerId} worker did not become ready`))
      }, context.readyTimeoutMs ?? READY_TIMEOUT_MS)
      timer.unref()
      void worker.exited.then(() => clearTimeout(timer))
      tryWrite({ type: 'start', config: context.config })
    })
  } catch (error) {
    await handle.stop()
    throw error
  }
  // An exit between the ready frame and here was not reported; surface it as a start failure.
  if (!worker.alive) throw new Error(`bundled ${providerId} worker exited during start`)
  started = true
  return handle
}
