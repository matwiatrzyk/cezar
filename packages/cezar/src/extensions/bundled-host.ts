// Host owner of one bundled chat worker (spec 2026-11-07-bundled-chat-workers): a
// ChatTransport facade over the worker, restart with bounded backoff on a crash, and a per-provider
// fall-back to the in-process compatibility transport once restarts are exhausted.
import { z } from 'zod'
import { inputUpdateSchema } from '../chat/events.ts'
import { chatIdentitySchema, chatIdSchema, chatReceiptSchema } from '@open-mercato/cezar-contract'
import { ChatTransportError, chatEventSchema, type ChatTransport } from '../chat/provider.ts'
import type { ChatConnection, ChatConnectionOptions, ChatHealth, ReceiveJournal } from '../chat/connection.ts'
import { startBundledProvider, type BundledProviderContext, type BundledProviderHandle } from './bundled-runtime.ts'
import type { BundledProviderManifest } from './bundled-catalog.ts'
import { RestartBudget } from './worker-process.ts'

export interface BundledChatOwnerOptions {
  manifest: BundledProviderManifest
  packageRoot: string
  /** Worker start configuration; re-read on every (re)spawn. */
  config(): Promise<Record<string, string>>
  /** The in-process adapter: the fall-back owner, never started alongside a live worker. */
  compatibility: ChatTransport
  /** Slack only: rotate one access token with host-held refresh credentials. */
  rotate?(kind: 'app' | 'bot', signal: AbortSignal): Promise<string>
  log?(line: string): void
  /** Consecutive crashes (each within a minute of its spawn) tolerated before falling back. */
  maxRestarts?: number
  restartDelayMs?(attempt: number): number
  worker?: Pick<BundledProviderContext, 'execArgv' | 'env' | 'readyTimeoutMs' | 'callTimeoutMs' | 'stopTimeoutMs'>
}
type Live = { journal: ReceiveJournal; options: ChatConnectionOptions; now?: () => number }
type Operation = Parameters<BundledProviderHandle['call']>[0]

const nativeInput = z.object({ query: z.string().max(128), chatId: z.string().max(512), userId: z.string().max(256) }).strict()
const rotateInput = z.object({ kind: z.enum(['app', 'bot']) }).strict()
const acceptInput = z.object({ event: z.unknown() }).strict()
// Worker answers are untrusted IPC: parse them like the extension bridge does (L1, review e2c47b12).
// `.loose()`: validate the fields the host relies on without stripping provider extras.
const identityResult = chatIdentitySchema.loose()
const receiptResult = chatReceiptSchema.loose()
const inspectResult = z.object({ id: chatIdSchema, kind: z.enum(['private', 'group']), eligible: z.boolean() }).loose()
const memberResult = z.boolean().optional()
const blocked = () => new ChatTransportError({ kind: 'blocked' })

export class BundledChatOwner {
  private worker?: BundledProviderHandle
  /** Identity of the current spawn attempt: an exit or failure from any other attempt is stale (H1). */
  private attempt?: object
  private live?: Live
  private fallback?: ChatConnection
  private state: ChatHealth = { state: 'stopped' }
  private stopped = false
  private spawnedAt = 0
  private timer?: ReturnType<typeof setTimeout>
  private respawning?: Promise<void>
  private readonly restarts: RestartBudget
  mode: 'worker' | 'compatibility' = 'worker'

  private constructor(private readonly options: BundledChatOwnerOptions) {
    this.restarts = new RestartBudget({
      maxRestarts: options.maxRestarts ?? 3,
      ...(options.restartDelayMs ? { delayMs: options.restartDelayMs } : {}),
    })
  }

  /** Resolves with a ready worker, or rejects so the caller keeps the compatibility owner. */
  static async activate(options: BundledChatOwnerOptions): Promise<BundledChatOwner> {
    const owner = new BundledChatOwner(options)
    try {
      await owner.spawn()
    } catch (error) {
      // Nobody holds this owner: it must never respawn a worker on its own (H1).
      owner.stopped = true
      throw error
    }
    return owner
  }

  get pid(): number | undefined { return this.worker?.process.pid }
  private get id() { return this.options.manifest.id }

  private log(line: string) {
    const write = this.options.log ?? (value => console.warn(value))
    write(`[chat] bundled ${this.id} worker: ${line}`)
  }

  private get running() { return !this.stopped && this.mode === 'worker' }

  /** Start one worker as the current attempt; it becomes `this.worker` only if still current. */
  private async spawn(): Promise<void> {
    const attempt = {}
    this.attempt = attempt
    this.spawnedAt = Date.now()
    const worker = await startBundledProvider(this.options.manifest, {
      ...this.options.worker,
      packageRoot: this.options.packageRoot,
      config: await this.options.config(),
      log: line => this.log(line),
      onHealth: state => this.health({ state }),
      onExit: error => this.crashed(error, attempt),
      onHostRequest: (method, params, signal) => this.serve(method, params, signal),
    })
    if (this.attempt !== attempt || this.stopped || this.mode !== 'worker') {
      await worker.stop()
      return
    }
    this.worker = worker
  }

  private health(value: ChatHealth) {
    this.state = value.state === 'polling' ? { ...value, lastSuccessfulPollAt: Date.now() } : value
    if (this.live && this.mode === 'worker') this.live.options.onHealth(this.state)
  }

  private async serve(method: string, params: unknown, signal: AbortSignal): Promise<unknown> {
    const live = this.live
    if (method === 'rotate') {
      if (!this.options.rotate) throw new ChatTransportError({ kind: 'auth' })
      return { token: await this.options.rotate(rotateInput.parse(params).kind, signal) }
    }
    if (!live || this.stopped) throw blocked()
    if (signal.aborted || !live.options.needed()) throw blocked()
    switch (method) {
      case 'process': {
        if (this.id !== 'telegram') throw blocked()
        const input = z.object({update: inputUpdateSchema, epoch:z.string().uuid()}).strict().parse(params)
        await live.options.process(input.update, input.epoch)
        // Never acknowledge processing before quiet journal outcomes are durable.
        await live.journal.flush()
        return undefined
      }
      case 'journal': {
        if (this.id !== 'telegram') throw blocked()
        const input = z.object({operation:z.enum(['recover','assertReady','prepareReceive','snapshot','duplicate','finish','touch','flush']),args:z.array(z.unknown()).max(2)}).strict().parse(params)
        const noArgs = () => z.tuple([]).parse(input.args)
        const pair = () => z.tuple([z.string().uuid(),z.number().int().nonnegative().safe()]).parse(input.args)
        switch (input.operation) {
          case 'recover': noArgs(); await live.journal.recover(); break
          case 'assertReady': noArgs(); await live.journal.assertReady(); break
          case 'prepareReceive': { const [now, idle] = z.tuple([z.number().nonnegative(),z.number().nonnegative().nullable()]).parse(input.args); await live.journal.prepareReceive(now, idle ?? undefined); break }
          case 'snapshot': { noArgs(); const {epoch,nextOffset}=await live.journal.snapshot(); return {epoch,nextOffset} }
          case 'duplicate': return live.journal.duplicate(...pair())
          case 'finish': await live.journal.finish(...pair()); break
          case 'touch': await live.journal.touch(z.tuple([z.number().nonnegative()]).parse(input.args)[0]); break
          case 'flush': noArgs(); await live.journal.flush(); break
        }
        return undefined
      }
      case 'assertCredentials':
        await live.options.assertCredentials()
        return undefined
      case 'accept':
        await live.options.accept(chatEventSchema.parse(acceptInput.parse(params).event))
        return undefined
      case 'nativeTasks': {
        const input = nativeInput.parse(params)
        return await live.options.nativeCommands?.tasks(input.query, input.chatId, input.userId) ?? []
      }
    }
    throw blocked()
  }

  private crashed(error: Error, attempt: object) {
    if (attempt !== this.attempt) return
    this.attempt = undefined
    this.worker = undefined
    if (!this.running) return
    const next = this.restarts.crashed(this.spawnedAt)
    if (!next) {
      this.degrade(`${error.message}; restarts exhausted, using the in-process adapter`)
      return
    }
    this.log(`${error.message}; restarting (attempt ${next.attempt})`)
    this.health({ state: 'backoff' })
    clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.respawning = this.respawn()
    }, next.delayMs)
    this.timer.unref()
  }

  private async respawn() {
    if (!this.running) return
    try {
      await this.spawn()
    } catch (error) {
      if (this.attempt) this.crashed(error instanceof Error ? error : new Error('respawn failed'), this.attempt)
      return
    }
    if (this.live && this.worker) this.worker.connect()
  }

  /** Per-provider fail-open: the dead worker is gone before the in-process connection starts. */
  private async degrade(reason: string) {
    this.mode = 'compatibility'
    this.log(reason)
    const worker = this.worker
    this.worker = undefined
    await worker?.stop()
    if (this.live && !this.stopped) {
      this.fallback = this.options.compatibility.connect(this.live.journal, this.live.options, this.live.now)
      this.fallback.start()
    }
  }

  private async call(operation: Operation, input: unknown, valid: () => boolean, signal?: AbortSignal): Promise<unknown> {
    if (this.stopped || !valid() || signal?.aborted) throw blocked()
    // While a crashed worker restarts, callers see a retryable failure rather than a hang.
    if (!this.worker) throw new ChatTransportError({ kind: 'transient' })
    return this.worker.call(operation, input, { valid, ...(signal ? { signal } : {}) })
  }

  /** The runtime's transport. Each operation goes to the worker, or to compatibility after fall-back. */
  transport(valid: () => boolean): ChatTransport {
    const compat = () => this.options.compatibility.guarded(valid)
    const owner = this
    const onWorker = () => owner.mode === 'worker'
    const identify = async (signal?: AbortSignal) => {
      if (!onWorker()) return compat().identify(signal)
      try { return identityResult.parse(await owner.call('identify', {}, valid, signal)) }
      catch (error) {
        // Telegram identifies during worker connect. A failed identity means
        // this worker cannot own polling; stop it before compatibility takes
        // over, so two receive loops can never overlap.
        if (this.id !== 'telegram' || this.stopped) throw error
        await owner.degrade(`${error instanceof Error ? error.message : String(error)}; using the in-process adapter`)
        return compat().identify(signal)
      }
    }
    return {
      identify,
      inspect: async chatId => onWorker()
        ? inspectResult.parse(await owner.call('inspect', { chatId }, valid))
        : compat().inspect(chatId),
      send: async (chatId, message, signal, guard) => onWorker()
        ? receiptResult.parse(await owner.call('send', { chatId, message }, () => valid() && (!guard || guard()), signal))
        : compat().send(chatId, message, signal, guard),
      clearButtons: async (receipt, signal) => {
        if (!onWorker()) return compat().clearButtons(receipt, signal)
        await owner.call('clearButtons', receipt, valid, signal)
      },
      acknowledge: async (eventId, text, signal) => {
        if (!onWorker()) return compat().acknowledge(eventId, text, signal)
        await owner.call('acknowledge', { eventId, text }, valid, signal)
      },
      isMember: async (chatId, userId, signal) => onWorker()
        ? memberResult.parse(await owner.call('isMember', { chatId, userId }, valid, signal))
        : compat().isMember(chatId, userId, signal),
      guarded: check => owner.transport(() => valid() && check()),
      connect: (journal, options, now): ChatConnection => ({
        start() {
          if (owner.stopped || owner.live) return
          owner.live = { journal, options, ...(now ? { now } : {}) }
          if (owner.mode === 'compatibility') {
            owner.fallback = owner.options.compatibility.connect(journal, options, now)
            owner.fallback.start()
          } else owner.worker?.connect()
        },
        health: () => owner.fallback?.health() ?? owner.state,
        async stop() { await owner.disconnect() },
      }),
    }
  }

  private async disconnect() {
    this.live = undefined
    try { this.worker?.disconnect() } catch { /* gone */ }
    const fallback = this.fallback
    this.fallback = undefined
    await fallback?.stop()
    this.state = { state: 'stopped' }
  }

  /** Stops the receive connection first, then the worker (SIGTERM, then SIGKILL, bounded). */
  async stop(): Promise<void> {
    if (this.stopped) return
    await this.disconnect()
    this.stopped = true
    clearTimeout(this.timer)
    await this.respawning
    this.attempt = undefined
    const worker = this.worker
    this.worker = undefined
    await worker?.stop()
  }
}
