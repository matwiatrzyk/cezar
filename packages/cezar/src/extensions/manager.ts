import { pinArtifact } from './artifact-leases.ts'
import { withLifecycleFileLock } from '../worktree-lifecycle/store.ts'
import { existsSync } from 'node:fs'
import { realpath, rm, mkdir } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import {
  chatCredentialsSchema,
  DEFAULT_EXTENSION_LOCATION,
  extensionCapabilitySchema,
  extensionFormSchema,
  extensionPanelSchema,
  validateExtensionForm,
  type ExtensionCapability,
  type ExtensionChatProvider,
  type ExtensionForm,
  type ExtensionPanel,
  type ExtensionPlacement,
  type ExtensionPlacementLocation,
  type ExtensionRecord,
  type ExtensionTaskProposal,
} from '@open-mercato/cezar-contract'
import { ChatTransportError } from '../chat/provider.ts'
import { registerChatExtension } from '../chat/registry.ts'
import { cezarHomeDir } from '../paths.ts'
import { loadWorkspaceConfig } from '../workspace/config.ts'
import { SecretStore } from '../workspace/secrets.ts'
import { ChatExtensionBridge, extensionChatDescriptor } from './chat-bridge.ts'
import { ExtensionHostContext, type ExtensionContextDeps } from './context.ts'
import { extensionSecretNames } from './data.ts'
import { ExtensionHost } from './host.ts'
import { artifactIntegrity, ExtensionInstaller, isPackageSource, sourceIdentity, type PreparedInstall } from './installer.ts'
import { requireExtensionPermission } from './permissions.ts'
import { extensionChatCallSchema } from './protocol.ts'
import { ExtensionStore } from './store.ts'
import { snapshotExtensionState } from './updates.ts'
import { RestartBudget, type RestartBudgetOptions } from './worker-process.ts'

/** A manifest without `capabilities` is unrestricted at runtime, so it is compared as holding all. */
const effectiveCapabilities = (manifest: ExtensionRecord['manifest']): readonly ExtensionCapability[] =>
  manifest.capabilities ?? extensionCapabilitySchema.options

/** A project's approval covers the installed artifact it names, or a later update that asks for
 *  nothing more — so a project that was not open during an update keeps its consent too. */
function approved(approval: ExtensionRecord | undefined, record: ExtensionRecord): boolean {
  if (!approval?.enabled) return false
  const same = approval.integrity === record.integrity && approval.installedAt === record.installedAt
  return same || keepsConsent(approval, record)
}

type ConsentInput = Pick<ExtensionRecord, 'manifest' | 'source'>

const addedPermissions = (old: ConsentInput | undefined, next: ConsentInput) =>
  next.manifest.permissions.filter(permission => !old?.manifest.permissions.includes(permission))

const addedCapabilities = (old: ConsentInput | undefined, next: ConsentInput) => {
  const before = old ? effectiveCapabilities(old.manifest) : []
  return effectiveCapabilities(next.manifest).filter(capability => !before.includes(capability))
}

/** An update keeps a project's approval only when it comes from the same source and asks for
 *  nothing the approved version lacked. */
export function keepsConsent(old: (ConsentInput & { enabled: boolean }) | undefined, next: ConsentInput): boolean {
  if (!old?.enabled) return false
  return sourceIdentity(old.source) === sourceIdentity(next.source)
    && addedPermissions(old, next).length === 0
    && addedCapabilities(old, next).length === 0
}

const declaredCommands = (manifest: ExtensionRecord['manifest']) => [...manifest.actions, ...(manifest.contributes?.commands ?? [])]
const declaredPanels = (manifest: ExtensionRecord['manifest']) => [...manifest.panels, ...(manifest.contributes?.panels ?? [])]
const errorMessage = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback

/** A stored chat credential that does not parse is a permanent fault, never a transient retry (M3). */
function parseChatCredential(credential: string): Record<string, string> {
  try {
    return chatCredentialsSchema.parse(JSON.parse(credential))
  } catch {
    throw new ChatTransportError({ kind: 'auth' })
  }
}

type ManagerDeps = Pick<ExtensionContextDeps, 'listTasks' | 'getTask' | 'proposeTask' | 'events' | 'secrets' | 'log'> & {
  home?: string
  /** Restart policy for a worker that dies after activation (defaults: 3 rapid crashes, 1 s backoff doubling). */
  restarts?: RestartBudgetOptions
}
type InvokeResult = { ok: boolean; message?: string; proposals?: ExtensionTaskProposal[] }
type Restart = { budget: RestartBudget; startedAt: number; timer?: ReturnType<typeof setTimeout> }
/** The task a `task`-located panel or command is opened for (V1.1). The id is checked against
 *  THIS project's store before any worker sees it; a caller's project id is never consulted. */
export type TaskCallOptions = { runId?: string }
/** The run a caller named is not in this project — an HTTP 404, never a worker call. */
export class ExtensionRunNotFoundError extends Error {
  constructor() { super('run not found') }
}

/** Installed artifacts are global; approval binds one project to an exact artifact. */
export class ExtensionManager {
  private static readonly listeners = new Set<() => void>()
  private static readonly instances = new Set<ExtensionManager>()
  private static readonly catalogMutations = new Map<string, Promise<unknown>>()

  static subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private static changed() {
    for (const listener of this.listeners) {
      try { listener() } catch { /* optional view */ }
    }
  }

  private readonly unsubscribeEvents: (() => void) | undefined
  private readonly host = new ExtensionHost()
  private readonly chatCleanups = new Map<string, (() => Promise<void>)[]>()
  private readonly proposals = new Map<string, { extensionId: string; items: ExtensionTaskProposal[] }>()
  private readonly failures = new Map<string, string>()
  private readonly starting = new Map<string, Promise<void>>()
  private readonly stopping = new Map<string, Promise<void>>()
  private readonly restarts = new Map<string, Restart>()
  private readonly previewTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly artifacts = new Map<string, string>()
  private readonly pins = new Map<string, () => Promise<void>>()
  private reconcileTimer?: ReturnType<typeof setInterval>
  private readonly contexts = new Map<string, ExtensionHostContext>()
  private readonly prepared = new Map<string, { value: PreparedInstall; expiresAt: number }>()
  private readonly installer: ExtensionInstaller
  private readonly catalog: ExtensionStore
  private readonly approvals: ExtensionStore
  private readonly home: string
  private readonly secrets: SecretStore
  private closed = false
  private mutations: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly dataDir: string,
    private readonly projectId: string,
    private readonly projectRoot: string,
    private readonly deps: ManagerDeps = {},
  ) {
    this.home = deps.home ?? cezarHomeDir()
    this.secrets = deps.secrets ?? new SecretStore({ ...process.env, CEZ_HOME: this.home })
    this.installer = new ExtensionInstaller(this.home)
    this.catalog = new ExtensionStore(join(this.home, 'extensions', 'registry.json'))
    this.approvals = new ExtensionStore(join(dataDir, 'extensions', 'registry.json'))
    ExtensionManager.instances.add(this)
    this.unsubscribeEvents = deps.events?.subscribe(() => ExtensionManager.changed())
  }

  private serialize<T>(operation: () => Promise<T>, notify = true): Promise<T> {
    const previous = ExtensionManager.catalogMutations.get(this.home) ?? Promise.resolve()
    const result = previous.then(async () => {
      if (this.closed) throw new Error('extension manager is closed')
      await mkdir(join(this.home, 'extensions'), { recursive: true, mode: 0o700 })
      return withLifecycleFileLock(join(this.home, 'extensions', '.manager.lock'), operation)
    })
    this.mutations = result.catch(() => undefined).finally(() => { if (notify) ExtensionManager.changed() })
    ExtensionManager.catalogMutations.set(this.home, this.mutations)
    return result
  }

  private peers() {
    return [...ExtensionManager.instances].filter(manager => manager.home === this.home && !manager.closed)
  }

  private status(id: string): NonNullable<ExtensionRecord['status']> {
    if (this.restarts.get(id)?.timer) return 'starting'
    if (this.failures.has(id)) return 'failed'
    if (this.starting.has(id)) return 'starting'
    if (this.contexts.has(id)) return 'running'
    return 'disabled'
  }

  async list(): Promise<ExtensionRecord[]> {
    return this.serialize(async () => { await this.reconcile(); return this.records() }, false)
  }

  /** Reconcile quiet receivers too: no UI read is required to retire a revoked worker.
   * Calls and list projections also reconcile under the cross-process mutation lock. */
  private watchCatalog() {
    if (this.reconcileTimer || this.closed) return
    let checking = false
    this.reconcileTimer = setInterval(() => {
      if (checking || this.closed) return
      checking = true
      void this.serialize(() => this.reconcile(), false).catch(() => undefined).finally(() => { checking = false })
    }, 500)
    this.reconcileTimer.unref()
  }

  private artifactKey(record: ExtensionRecord) { return JSON.stringify([record.integrity, record.manifest.version, record.installedAt]) }

  private async reconcile() {
    const records = await this.records()
    const retired = new Set<string>()
    let changed = false
    for (const id of this.contexts.keys()) {
      const record = records.find(item => item.manifest.id === id)
      if (!record?.enabled || this.artifacts.get(id) !== this.artifactKey(record)) {
        await this.stop(id)
        retired.add(id)
      }
    }
    for (const record of records) {
      if (!record.enabled || this.contexts.has(record.manifest.id) || this.failures.has(record.manifest.id) || this.restarts.get(record.manifest.id)?.timer) continue
      await this.start(record).catch(() => undefined)
      changed = true
    }
    if (retired.size || changed) ExtensionManager.changed()
    for (const id of retired) {
      await this.installer.pruneArtifacts(id, records.find(record => record.manifest.id === id)?.integrity).catch(() => undefined)
    }
  }

  private async records(): Promise<ExtensionRecord[]> {
    const [installed, approvals] = await Promise.all([this.catalog.list(), this.approvals.list()])
    return installed.map(record => {
      const id = record.manifest.id
      const status = this.status(id)
      const error = status === 'failed' ? this.failures.get(id) : undefined
      const approval = approvals.find(item => item.manifest.id === id)
      return { ...record, status, ...(error ? { error } : {}), enabled: !!record.integrity && approved(approval, record) }
    })
  }

  async installed(): Promise<ExtensionRecord[]> { return this.catalog.list() }

  async prepareUpdate(id: string) {
    const record = (await this.catalog.list()).find(item => item.manifest.id === id)
    if (!record) throw new Error('extension not found')
    const preview = await this.prepare(record.source)
    if (preview.manifest.id !== id) {
      await this.discard(preview.preparedId)
      throw new Error('extension id changed during update')
    }
    return preview
  }

  async install(source: string): Promise<ExtensionRecord> {
    return this.commit((await this.prepare(source)).preparedId)
  }

  async prepare(source: string) {
    if (this.closed) throw new Error('extension manager is closed')
    for (const [id, preview] of this.prepared) {
      if (preview.expiresAt >= Date.now()) continue
      this.prepared.delete(id)
      await this.installer.discardInstall(preview.value)
    }
    if (this.prepared.size >= 10) throw new Error('too many pending extension previews')
    const local = resolve(this.projectRoot, source)
    const value = await this.installer.prepareInstall(!isPackageSource(source) && existsSync(local) ? local : source)
    if (this.closed) {
      await this.installer.discardInstall(value)
      throw new Error('extension manager is closed')
    }
    const previous = (await this.catalog.list()).find(record => record.manifest.id === value.id)
    const next = { manifest: value.manifest, source: value.source }
    const replaces = previous ? {
      version: previous.manifest.version,
      sourceChanged: sourceIdentity(previous.source) !== sourceIdentity(value.source),
      keepsConsent: keepsConsent({ ...previous, enabled: true }, next),
      enabledProjects: await this.enabledProjects(previous),
    } : undefined
    const preparedId = randomUUID()
    this.prepared.set(preparedId, { value, expiresAt: Date.now() + 10 * 60_000 })
    const timer = setTimeout(() => { void this.discard(preparedId).catch(() => undefined) }, 10 * 60_000)
    timer.unref()
    this.previewTimers.set(preparedId, timer)
    return {
      preparedId,
      manifest: value.manifest,
      addedPermissions: addedPermissions(previous, next),
      addedCapabilities: addedCapabilities(previous, next),
      ...(replaces ? { replaces } : {}),
    }
  }

  /** Every project cezar knows (open peers and registered ones), keyed by data directory. */
  private async knownProjects() {
    const projects = new Map(this.peers().map(manager => [manager.dataDir, {
      root: manager.projectRoot, id: manager.projectId, dataDir: manager.dataDir, secrets: manager.secrets,
    }]))
    for (const project of (await loadWorkspaceConfig(join(this.home, 'config.json'))).projects ?? []) {
      const dataDir = join(project.root, '.ai/cezar')
      if (!projects.has(dataDir)) projects.set(dataDir, { root: project.root, id: project.id, dataDir, secrets: this.secrets })
    }
    return [...projects.values()]
  }

  /** How many projects currently run `record` under an approval — what an update would affect. */
  private async enabledProjects(record: ExtensionRecord): Promise<number> {
    let count = 0
    for (const project of await this.knownProjects()) {
      const approvals = await new ExtensionStore(join(project.dataDir, 'extensions', 'registry.json')).list().catch(() => [])
      if (approved(approvals.find(item => item.manifest.id === record.manifest.id), record)) count++
    }
    return count
  }

  commit(preparedId: string): Promise<ExtensionRecord> {
    return this.serialize(async () => {
      const preview = this.prepared.get(preparedId)
      if (!preview || preview.expiresAt < Date.now()) throw new Error('extension install preview expired')
      clearTimeout(this.previewTimers.get(preparedId))
      this.previewTimers.delete(preparedId)
      this.prepared.delete(preparedId)
      const old = (await this.records()).find(record => record.manifest.id === preview.value.id)
      const installed = await this.installer.commitInstall(preview.value).finally(() => this.installer.discardInstall(preview.value))
      const record: ExtensionRecord = {
        manifest: installed.manifest,
        source: installed.source,
        installedAt: new Date().toISOString(),
        integrity: installed.integrity,
        enabled: false,
      }
      const id = record.manifest.id
      const affected = await Promise.all(this.peers().map(async manager => ({
        manager,
        old: (await manager.records()).find(item => item.manifest.id === id),
        snapshot: undefined as Awaited<ReturnType<typeof snapshotExtensionState>> | undefined,
        restoreSecrets: undefined as (() => Promise<void>) | undefined,
      })))
      try {
        for (const item of affected) {
          await item.manager.stop(id)
          if (!item.old) continue
          item.restoreSecrets = await item.manager.snapshotSecrets(id)
          item.snapshot = await snapshotExtensionState(join(item.manager.dataDir, 'extensions', id))
        }
        for (const { manager, old } of affected) {
          if (!keepsConsent(old, record)) continue
          manager.failures.delete(id)
          await manager.start(record)
        }
        await this.catalog.update(records => [...records.filter(item => item.manifest.id !== id), record])
        for (const { manager, old } of affected) await manager.approve({ ...record, enabled: keepsConsent(old, record) })
        for (const item of affected) await item.snapshot?.discard()
        await this.installer.pruneArtifacts(id, record.integrity).catch(() => undefined)
        return (await this.records()).find(item => item.manifest.id === id)!
      } catch (error) {
        for (const item of affected) await item.manager.stop(id)
        await this.catalog.update(records => [
          ...records.filter(item => item.manifest.id !== id),
          ...(old ? [{ ...old, enabled: false }] : []),
        ])
        for (const item of affected) {
          await item.restoreSecrets?.()
          await item.snapshot?.restore()
          if (item.old) await item.manager.approve(item.old)
          else await item.manager.approvals.update(records => records.filter(entry => entry.manifest.id !== id))
          if (item.old?.enabled && !item.manager.closed) {
            item.manager.failures.delete(id)
            await item.manager.start(item.old)
          }
        }
        throw error
      }
    })
  }

  private async snapshotSecrets(id: string): Promise<() => Promise<void>> {
    const scope = { kind: 'project' as const, projectId: this.projectId, root: this.projectRoot }
    const names = await extensionSecretNames(this.dataDir, id)
    const snapshot = await this.secrets.read(scope)
    if (names.length && snapshot.skipped) throw new Error('extension secrets are unavailable; cannot safely snapshot this update')
    return async () => {
      for (const name of await extensionSecretNames(this.dataDir, id)) {
        const previous = names.includes(name) ? snapshot.values[name] : undefined
        if (previous) await this.secrets.set(scope, name, previous.value, previous.audiences)
        else await this.secrets.unset(scope, name)
      }
    }
  }

  private approve(record: ExtensionRecord) {
    return this.approvals.update(records => [...records.filter(item => item.manifest.id !== record.manifest.id), record])
  }

  uninstall(id: string, removeData = false): Promise<boolean> {
    return this.serialize(async () => {
      const found = (await this.catalog.list()).some(item => item.manifest.id === id)
      for (const peer of this.peers()) await peer.stop(id)
      await this.catalog.update(records => records.filter(item => item.manifest.id !== id))
      await this.installer.pruneArtifacts(id).catch(() => undefined)
      const projects = await this.knownProjects()
      // Every registered project forgets its approval, so a later reinstall asks again everywhere.
      for (const project of projects) {
        await new ExtensionStore(join(project.dataDir, 'extensions', 'registry.json'))
          .update(records => records.filter(item => item.manifest.id !== id))
          .catch(() => undefined)
      }
      if (removeData) {
        for (const project of projects) {
          const scope = { kind: 'project' as const, projectId: project.id, root: project.root }
          for (const name of await extensionSecretNames(project.dataDir, id)) await project.secrets.unset(scope, name)
          await rm(join(project.dataDir, 'extensions', id), { recursive: true, force: true })
        }
      }
      return found
    })
  }

  setEnabled(id: string, enabled: boolean, integrity?: string): Promise<ExtensionRecord | undefined> {
    return this.serialize(async () => {
      const record = (await this.records()).find(item => item.manifest.id === id)
      if (!record) return undefined
      if (enabled && integrity !== undefined && integrity !== record.integrity) {
        throw new Error('extension artifact changed; review its permissions again')
      }
      // An explicit choice replaces any pending automatic restart and its crash count.
      this.cancelRestart(id)
      this.restarts.delete(id)
      this.failures.delete(id)
      if (enabled) await this.start(record)
      else await this.stop(id)
      const next = { ...record, enabled }
      await this.approve(next)
      return next
    })
  }

  private cancelRestart(id: string) {
    const restart = this.restarts.get(id)
    if (!restart?.timer) return
    clearTimeout(restart.timer)
    restart.timer = undefined
  }

  private stop(id: string): Promise<void> {
    this.cancelRestart(id)
    const existing = this.stopping.get(id)
    if (existing) return existing
    for (const [key, queue] of this.proposals) {
      if (queue.extensionId === id) this.proposals.delete(key)
    }
    this.contexts.get(id)?.disable()
    this.contexts.delete(id)
    this.artifacts.delete(id)
    const cleanups = this.chatCleanups.get(id) ?? []
    this.chatCleanups.delete(id)
    const stopping = (async () => {
      await this.host.deactivate(id)
      for (const cleanup of cleanups) await cleanup()
      const release = this.pins.get(id)
      this.pins.delete(id)
      await release?.()

    })()
    this.stopping.set(id, stopping)
    void stopping.finally(() => { if (this.stopping.get(id) === stopping) this.stopping.delete(id) }).catch(() => undefined)
    return stopping
  }

  private async start(record: ExtensionRecord): Promise<void> {
    const id = record.manifest.id
    const existing = this.starting.get(id)
    if (existing) return existing
    const failure = this.failures.get(id)
    if (failure) throw new Error(failure)
    const starting = this.activate(record)
    this.starting.set(id, starting)
    try {
      await starting
    } catch (error) {
      this.failures.set(id, error instanceof Error ? error.message.slice(0, 500) : 'Extension failed')
      throw error
    } finally {
      if (this.starting.get(id) === starting) this.starting.delete(id)
    }
  }

  /** A worker died after activation: restart it with bounded backoff, then leave it visibly failed. */
  private crashed(record: ExtensionRecord, message: string) {
    const id = record.manifest.id
    this.failures.set(id, message)
    const restart = this.restarts.get(id)
    void this.stop(id).catch(() => undefined).finally(() => {
      // An explicit enable/disable/update during teardown replaced this restart record.
      if (!restart || this.closed || this.restarts.get(id) !== restart) return ExtensionManager.changed()
      const next = restart.budget.crashed(restart.startedAt)
      if (!next) {
        this.deps.log?.('error', `worker failed repeatedly; restarts exhausted (${message})`, id)
        return ExtensionManager.changed()
      }
      this.deps.log?.('error', `worker exited (${message}); restarting (attempt ${next.attempt})`, id)
      restart.timer = setTimeout(() => {
        restart.timer = undefined
        if (this.closed || this.restarts.get(id) !== restart) return
        this.failures.delete(id)
        // A failed re-activation is final and visible; only a crash after activation retries.
        void this.serialize(async () => {
          const current = (await this.records()).find(item => item.manifest.id === id && item.enabled)
          if (current) await this.start(current)
          else await this.stop(id)
        }).catch(() => undefined)
      }, next.delayMs)
      restart.timer.unref()
      ExtensionManager.changed()
    })
  }

  private async activate(record: ExtensionRecord): Promise<void> {
    const id = record.manifest.id
    await this.stopping.get(id)
    if (this.closed) throw new Error('extension manager is closed')
    if (this.contexts.has(id)) return
    if (!record.integrity) throw new Error('reinstall this extension to create an immutable artifact')
    const digest = createHash('sha256').update(record.integrity).digest('hex')
    const root = await realpath(join(this.home, 'extensions', 'artifacts', id, record.manifest.version, digest))
    if (await artifactIntegrity(root) !== record.integrity) throw new Error('installed extension artifact changed; reinstall and review it')
    const entry = await realpath(resolve(root, record.manifest.entry))
    const rel = relative(root, entry)
    const escapes = rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)
    if (escapes) throw new Error('extension entry must stay inside its installed directory')
    if (this.closed) throw new Error('extension manager is closed')

    const release = await pinArtifact(this.home, id, digest, root)
    this.pins.set(id, release)
    this.artifacts.set(id, this.artifactKey(record))
    this.watchCatalog()
    const context = this.createContext(record)
    this.contexts.set(id, context)
    let restart = this.restarts.get(id)
    if (!restart) {
      restart = { budget: new RestartBudget(this.deps.restarts), startedAt: 0 }
      this.restarts.set(id, restart)
    }
    restart.startedAt = Date.now()
    try {
      await this.host.activate({
        id,
        manifest: record.manifest,
        entry,
        projectId: this.projectId,
        sanitize: value => context.redact(value),
        onFailure: error => {
          context.disable()
          this.contexts.delete(id)
          this.artifacts.delete(id)
          this.pins.delete(id)
          void release()
          this.crashed(record, context.redact(error.message).slice(0, 500))
        },
        dispatch: (method, params, signal, invocationId) => context.dispatch(method, params, signal, invocationId),
        ...(record.manifest.permissions.includes('project.read')
          ? { subscribe: (listener: (event: unknown) => void) => context.subscribe(listener) }
          : {}),
      })
    } catch (error) {
      context.disable()
      this.contexts.delete(id)
      this.artifacts.delete(id)
      this.pins.delete(id)
      await release()
      const message = context.redact(errorMessage(error, 'Extension activation failed'))
      this.failures.set(id, message.slice(0, 500))
      throw new Error(message)
    }
    const cleanups: (() => Promise<void>)[] = []
    this.chatCleanups.set(id, cleanups)
    try {
      for (const declaration of record.manifest.contributes?.chatProviders ?? []) {
        cleanups.push(await this.registerChat(record, declaration, context))
      }
    } catch (error) {
      await this.stop(id)
      throw error
    }
  }

  private createContext(record: ExtensionRecord): ExtensionHostContext {
    const id = record.manifest.id
    return new ExtensionHostContext({
      ...this.deps,
      secrets: this.secrets,
      dataDir: this.dataDir,
      projectId: this.projectId,
      projectRoot: this.projectRoot,
      extensionId: id,
      permissions: record.manifest.permissions,
      proposeTask: async (proposal, invocationId) => {
        if (this.closed || !this.contexts.has(id)) throw new Error('extension stopped')
        const queue = invocationId ? this.proposals.get(invocationId) : undefined
        if (!queue || queue.extensionId !== id) throw new Error('Task proposals require an active command invocation')
        if (queue.items.length >= 10) throw new Error('too many pending task proposals')
        queue.items.push(proposal)
        return { proposalId: randomUUID(), accepted: false }
      },
    })
  }

  private async assertCurrent(record: ExtensionRecord) {
    const current = (await this.records()).find(item => item.manifest.id === record.manifest.id)
    if (this.closed || !current?.enabled || this.artifactKey(current) !== this.artifactKey(record)) throw new ChatTransportError({kind:'blocked'})
  }

  private registerChat(record: ExtensionRecord, declaration: ExtensionChatProvider, context: ExtensionHostContext) {
    const id = record.manifest.id
    const descriptor = extensionChatDescriptor(id, declaration)
    const invoke = async (credential: string, operation: string, input: unknown, options: import('./host.ts').ExtensionCallOptions) => {
      const credentials = parseChatCredential(credential)
      for (const field of declaration.credentials) {
        const value = credentials[field.name]
        if (field.secret && value) context.rememberSecret(value)
      }
      try {
        const call = extensionChatCallSchema.parse({ providerId: declaration.id, credential, operation, input })
        return context.redact(await this.host.chat(id, call, {...options, authorize: () => this.assertCurrent(record)}))
      } catch (error) {
        if (error && typeof error === 'object' && 'failure' in error) throw error
        throw new Error(context.redact(errorMessage(error, 'Chat operation failed')))
      }
    }
    return registerChatExtension(this.projectRoot, descriptor, (credential, valid = () => true) =>
      new ChatExtensionBridge(
        (operation, input, options) => invoke(credential, operation, input, options),
        () => !this.closed && this.contexts.get(id) === context && valid(),
      ))
  }

  restore(): Promise<void> {
    this.watchCatalog()
    return this.serialize(async () => {
      for (const record of await this.records()) {
        if (!record.enabled) continue
        // A failed activation stays visible; only a crash after activation restarts on its own.
        try { await this.start(record) } catch { /* recorded in failures */ }
      }
    })
  }

  async discard(preparedId: string): Promise<void> {
    const preview = this.prepared.get(preparedId)
    this.prepared.delete(preparedId)
    clearTimeout(this.previewTimers.get(preparedId))
    this.previewTimers.delete(preparedId)
    if (preview) await this.installer.discardInstall(preview.value)
  }

  private async enabled(id: string): Promise<ExtensionRecord> {
    const record = (await this.list()).find(item => item.manifest.id === id && item.enabled)
    if (!record) {
      await this.stop(id)
      throw new Error('extension is not enabled')
    }
    if (!this.contexts.has(id)) throw new Error(this.failures.get(id) ?? 'extension is not running; enable or retry it')
    return record
  }

  /** Enabled extensions' contributions for one surface, with the `settings` default applied.
   *  An extension with nothing at `location` is left out. Running or not: a failed worker is
   *  listed with its status so the surface can say so instead of going blank. */
  async placements(location: ExtensionPlacementLocation): Promise<ExtensionPlacement[]> {
    const placements: ExtensionPlacement[] = []
    for (const record of await this.list()) {
      if (!record.enabled) continue
      const panels = declaredPanels(record.manifest)
        .map(panel => ({ id: panel.id, title: panel.title, location: panel.location ?? DEFAULT_EXTENSION_LOCATION }))
        .filter(panel => panel.location === location)
      const commands = declaredCommands(record.manifest)
        .map(command => ({ id: command.id, title: command.label, location: command.location ?? DEFAULT_EXTENSION_LOCATION }))
        .filter(command => command.location === location)
      if (!panels.length && !commands.length) continue
      placements.push({
        extensionId: record.manifest.id, name: record.manifest.name, status: this.status(record.manifest.id),
        ...(record.error ? { error: record.error } : {}), panels, commands,
      })
    }
    return placements
  }

  /** A named run must exist in THIS project's store, whatever the contribution's location; it is
   *  handed to the worker only for a `task`-located one (V1.1: sidebar/palette get no task). */
  private async taskContext(location: string | undefined, runId: string | undefined): Promise<string | undefined> {
    if (runId === undefined) return undefined
    if (!await this.deps.getTask?.(runId)) throw new ExtensionRunNotFoundError()
    return (location ?? DEFAULT_EXTENSION_LOCATION) === 'task' ? runId : undefined
  }

  async panel(id: string, panelId: string, options: TaskCallOptions = {}): Promise<ExtensionPanel | undefined> {
    const record = await this.enabled(id)
    const declaration = declaredPanels(record.manifest).find(panel => panel.id === panelId)
    if (!declaration) return undefined
    const runId = await this.taskContext(declaration.location, options.runId)
    const raw = await this.host.panel(id, panelId, runId).catch((error: unknown) => {
      // The IPC frame cap is the worker's wording; the card promises this one (spec V1.1).
      if (error instanceof Error && /exceeds 1 MiB/.test(error.message)) throw new Error('Panel too large')
      throw error
    })
    const panel = extensionPanelSchema.parse(this.contexts.get(id)!.redact(raw))
    if (panel.id !== panelId) throw new Error('extension panel identity changed')
    const commands = declaredCommands(record.manifest)
    if (panel.actions.some(action => !commands.some(command => command.id === action.id))) {
      throw new Error('extension panel references an undeclared command')
    }
    return panel
  }

  async forms(id: string): Promise<ExtensionForm[]> {
    const record = await this.enabled(id)
    const commands = declaredCommands(record.manifest)
    const result: ExtensionForm[] = []
    for (const declaration of record.manifest.contributes?.forms ?? []) {
      const form = extensionFormSchema.parse(this.contexts.get(id)!.redact(await this.host.form(id, declaration.id)))
      if (form.id !== declaration.id || !commands.some(command => command.id === form.commandId)) {
        throw new Error('undeclared form command')
      }
      if (form.commandId !== declaration.commandId || JSON.stringify(form.fields) !== JSON.stringify(declaration.fields)) {
        throw new Error('extension form fields changed from the approved declaration')
      }
      if (form.values) {
        for (const field of form.fields) if (field.type === 'password') delete form.values[field.key]
      }
      result.push(form)
    }
    return result
  }

  async invoke(id: string, actionId: string, input?: Record<string, unknown>, options: TaskCallOptions = {}): Promise<InvokeResult> {
    const record = await this.enabled(id)
    const action = declaredCommands(record.manifest).find(item => item.id === actionId)
    if (!action) throw new Error('extension action is not declared')
    if (action.permission) requireExtensionPermission(record.manifest.permissions, action.permission)
    const runId = await this.taskContext(action.location, options.runId)
    const forms = (record.manifest.contributes?.forms ?? []).filter(form => form.commandId === actionId)
    for (const form of forms) input = validateExtensionForm(form, input ?? {})
    const context = this.contexts.get(id)!
    for (const form of forms) {
      for (const field of form.fields) {
        const value = input?.[field.key]
        if (field.type === 'password' && typeof value === 'string') context.rememberSecret(value)
      }
    }
    const invocationId = randomUUID()
    const queue = { extensionId: id, items: [] as ExtensionTaskProposal[] }
    this.proposals.set(invocationId, queue)
    try {
      const result = context.redact(await this.host.invoke(id, actionId, input, invocationId, runId))
      const message = result && typeof result === 'object' && 'message' in result ? result.message : undefined
      const proposals = context.redact(queue.items)
      return { ok: true, ...(proposals.length ? { proposals } : {}), ...(typeof message === 'string' ? { message } : {}) }
    } catch (error) {
      throw new Error(context.redact(errorMessage(error, 'Extension command failed')))
    } finally {
      this.proposals.delete(invocationId)
    }
  }

  async close(): Promise<void> {
    this.closed = true
    clearInterval(this.reconcileTimer)
    this.unsubscribeEvents?.()
    for (const id of this.restarts.keys()) this.cancelRestart(id)
    for (const context of this.contexts.values()) context.disable()
    await ExtensionManager.catalogMutations.get(this.home)
    const ids = new Set([...this.contexts.keys(), ...this.chatCleanups.keys(), ...this.stopping.keys()])
    await Promise.all([...ids].map(id => this.stop(id)))
    await Promise.all([...this.prepared.values()].map(preview => this.installer.discardInstall(preview.value)))
    this.prepared.clear()
    for (const timer of this.previewTimers.values()) clearTimeout(timer)
    this.previewTimers.clear()
    ExtensionManager.instances.delete(this)
    if (!this.peers().length) ExtensionManager.catalogMutations.delete(this.home)
  }
}
