import { pinArtifact } from './artifact-leases.ts'
import { withLifecycleFileLock } from '../worktree-lifecycle/store.ts'
import { existsSync } from 'node:fs'
import { realpath, rm, mkdir, readFile } from 'node:fs/promises'
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
  type ExtensionInventoryItem,
  type ExtensionUninstallImpact,
  type ExtensionTaskProposal,
} from '@open-mercato/cezar-contract'
import { SlackTokenRotation, slackRotationStorage } from '../chat/providers/slack/rotation.ts'
import { decodeSlackCredentials } from '../chat/providers/slack/identity.ts'
import { ChatTransportError } from '../chat/provider.ts'
import { bundledPackageRoot } from './bundled-catalog.ts'
import { loadChatDeliveryCatalog, type ChatDeliveryArtifact } from './delivery-catalog.ts'
import { registerChatExtension, registerDeliveredChatSlot, setChatAdapterEnabled, hasChatSelectionOwner } from '../chat/registry.ts'
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

export const SUPPORTED_EXTENSION_HOST_FEATURES = new Set(['chat.receive.eventless-checkpoints', 'chat.receive.session.v1', 'chat.credentials.slack-rotation.v1', 'chat.native-task-choices.v1', 'chat.presentation.v1'])
export function assertExtensionHostFeatures(manifest: ExtensionRecord['manifest']): void {
  const missing = (manifest.requiredHostFeatures ?? []).filter(feature => !SUPPORTED_EXTENSION_HOST_FEATURES.has(feature))
  if (missing.length) throw new Error(`unsupported required host feature: ${missing.join(', ')}`)
}

/** A project's approval covers the installed artifact it names, or a later update that asks for
 *  nothing more — so a project that was not open during an update keeps its consent too. */
function approved(approval: ExtensionRecord | undefined, record: ExtensionRecord): boolean {
  if (!approval?.enabled) return false
  const same = approval.integrity === record.integrity && approval.installedAt === record.installedAt
  return same || keepsConsent(approval, record)
}

const isDeliveredApproval = (record: ExtensionRecord): boolean => record.source === 'bundled' && !!record.integrity && record.installedAt === record.integrity

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
    && (next.manifest.contributes?.chatProviders ?? []).every(provider => !provider.credentialProfile || old.manifest.contributes?.chatProviders?.some(prior => prior.id === provider.id && prior.credentialProfile === provider.credentialProfile))
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
  deliveryPackageRoot?: string
  workerExecArgv?: readonly string[]
  trustedChatInProcess?: boolean
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
  private readonly host: ExtensionHost
  private readonly chatCleanups = new Map<string, (() => Promise<void>)[]>()
  private readonly proposals = new Map<string, { extensionId: string; items: ExtensionTaskProposal[] }>()
  private readonly failures = new Map<string, string>()
  private readonly starting = new Map<string, Promise<void>>()
  private readonly stopping = new Map<string, Promise<void>>()
  private readonly restarts = new Map<string, Restart>()
  private readonly previewTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly delivered = new Map<string, {artifact:ChatDeliveryArtifact; record:ExtensionRecord; registration:Awaited<ReturnType<typeof registerDeliveredChatSlot>>}>()
  private deliveryMutations: Promise<unknown> = Promise.resolve()
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
  private restoreWarned = false
  private mutations: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly dataDir: string,
    private readonly projectId: string,
    private readonly projectRoot: string,
    private readonly deps: ManagerDeps = {},
  ) {
    this.host = new ExtensionHost(deps.workerExecArgv)
    this.home = deps.home ?? cezarHomeDir()
    this.secrets = deps.secrets ?? new SecretStore({ ...process.env, CEZ_HOME: this.home })
    this.installer = new ExtensionInstaller(this.home)
    this.catalog = new ExtensionStore(join(this.home, 'extensions', 'registry.json'))
    this.approvals = new ExtensionStore(join(dataDir, 'extensions', 'registry.json'))
    ExtensionManager.instances.add(this)
    this.unsubscribeEvents = deps.events?.subscribe(() => ExtensionManager.changed())
  }

  private serialize<T>(operation: () => Promise<T>, notify = true, empty?: () => T): Promise<T> {
    const previous = ExtensionManager.catalogMutations.get(this.home) ?? Promise.resolve()
    const result = previous.then(async () => {
      if (this.closed) throw new Error('extension manager is closed')
      // Empty passive operations still join the queue so reads wait for retirement/pruning.
      if (empty && !this.contexts.size && !(await this.catalog.list()).length) return empty()
      await mkdir(join(this.home, 'extensions'), { recursive: true, mode: 0o700 })
      return withLifecycleFileLock(join(this.home, 'extensions', '.manager.lock'), operation)
    })
    this.mutations = result.catch(() => undefined).finally(() => { if (notify) ExtensionManager.changed() })
    ExtensionManager.catalogMutations.set(this.home, this.mutations)
    return result
  }

  /** Shipped selections are project-owned and never require a writable global home. */
  private serializeDelivery<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.deliveryMutations.then(async () => {
      if (this.closed) throw new Error('extension manager is closed')
      await mkdir(join(this.dataDir, 'extensions'), { recursive:true, mode:0o700 })
      return withLifecycleFileLock(join(this.dataDir, 'extensions', '.delivery.lock'), operation)
    })
    this.deliveryMutations = result.catch(() => undefined).finally(() => ExtensionManager.changed())
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
    if (this.closed) return this.records()
    if (this.delivered.size && !(await this.catalog.list()).length) { await this.deliveryMutations; return this.records() }
    try {
      return await this.serialize(async () => { await this.reconcile(); return this.records() }, false, () => [])
    } catch (error) {
      if (!this.closed && !this.storageUnavailable(error)) throw error
      await this.stopForUnavailableStorage()
      return this.records()
    }
  }

  private storageUnavailable(error: unknown): boolean {
    return ['EACCES', 'EPERM', 'EROFS', 'ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException)?.code ?? '')
  }

  private async stopForUnavailableStorage() {
    // No unlocked reconciliation: leases and artifact identity remain mandatory.
    for (const id of this.restarts.keys()) this.cancelRestart(id)
    await Promise.all([...this.contexts.keys()].map(id => this.stop(id)))
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
    return [...this.delivered.values()].map(item => { const approval=approvals.find(record=>record.manifest.id===item.record.manifest.id);return {...item.record,enabled:approval ? approval.source==='bundled' && approval.enabled : item.record.enabled,status:this.status(item.record.manifest.id)} }).concat(installed.filter(record=>!this.delivered.has(record.manifest.id)).map(record => {
      const id = record.manifest.id
      const status = this.status(id)
      const error = status === 'failed' ? this.failures.get(id) : undefined
      const approval = approvals.find(item => item.manifest.id === id)
      return { ...record, status, ...(error ? { error } : {}), enabled: !!record.integrity && approved(approval, record) }
    }))
  }

  async installed(): Promise<ExtensionRecord[]> { return this.catalog.list() }

  /** Metadata reads never reconcile, create leases or activate extension code. */
  async inventory(unavailable?: 'flag-disabled' | 'hosted'): Promise<ExtensionInventoryItem[]> {
    const [installed, saved, shipped] = await Promise.all([
      this.catalog.list(), this.approvals.list(),
      loadChatDeliveryCatalog(this.deps.deliveryPackageRoot).catch(() => []),
    ])
    const records = new Map(saved.map(record => [record.manifest.id,record]))
    const deliveryRecords = new Set<string>()
    const deliveries = new Map(shipped.map(artifact => [artifact.extensionId,artifact]))
    for (const artifact of shipped) {
      // An explicit installed selection is never replaced by a host update.
      const prior = records.get(artifact.extensionId)
      if (!prior || isDeliveredApproval(prior)) {
        deliveryRecords.add(artifact.extensionId)
        records.set(artifact.extensionId, {
        manifest: artifact.manifest, source: 'bundled', installedAt: artifact.integrity,
        integrity: artifact.integrity, enabled: prior?.enabled ?? true,
      })
      }
    }
    for (const record of installed) { records.set(record.manifest.id,record); deliveryRecords.delete(record.manifest.id) }
    let hostVersion = 'unknown'
    if (shipped.length) {
      try {
        const pkg = JSON.parse(await readFile(join(this.deps.deliveryPackageRoot ?? bundledPackageRoot(),'package.json'),'utf8')) as {version?:unknown}
        if (typeof pkg.version === 'string') hostVersion = pkg.version
      } catch { /* Missing release metadata must not start code or fail discovery. */ }
    }
    return [...records.values()].map(record => {
      const artifact = deliveryRecords.has(record.manifest.id) ? deliveries.get(record.manifest.id) : undefined
      const present = !!artifact || installed.some(item => item.manifest.id === record.manifest.id)
      const approval = saved.find(item => item.manifest.id === record.manifest.id)
      const enabled = present && (artifact ? record.enabled : approved(approval,record))
      const incompatible = (record.manifest.requiredHostFeatures ?? []).some(feature => !SUPPORTED_EXTENSION_HOST_FEATURES.has(feature))
      const source = record.source
      const kind = isPackageSource(source) ? 'npm' as const : /\.(tgz|tar\.gz)$/i.test(source) ? 'tarball' as const : 'folder' as const
      const availability = unavailable === 'hosted' || (unavailable === 'flag-disabled' && !artifact) ? unavailable : undefined
      return {record:{...record,enabled,status:this.status(record.manifest.id)},
        provenance: artifact ? {kind:'bundled' as const,hostVersion,integrity:artifact.integrity} : {kind,source},
        availability: availability ?? (!present ? 'missing' : incompatible ? 'incompatible' : !enabled ? 'disabled' : this.failures.has(record.manifest.id) ? 'failed' : 'available'),
        selectedVersion:record.manifest.version,
        management: {
          enable: present && !enabled && !incompatible && !availability,
          disable: present && enabled && !availability,
          update: present && !artifact && !availability,
          uninstall: present && !artifact && !availability,
        },
        providers:(record.manifest.contributes?.chatProviders ?? []).map(provider => ({id:artifact ? artifact.provider : `${record.manifest.id}/${provider.id}`,label:provider.label})),
      }
    })
  }

  async uninstallImpact(extensionId: string): Promise<ExtensionUninstallImpact> {
    const config = await loadWorkspaceConfig(join(this.home, 'config.json'))
    const registered = config.projects ?? []
    const projects = await this.knownProjects()
    const impact: ExtensionUninstallImpact['projects'] = []
    const approvals: {projectId:string; record:ExtensionRecord}[] = []
    for (const project of projects) {
      const records = await new ExtensionStore(join(project.dataDir,'extensions','registry.json')).list()
      const record = records.find(item => item.manifest.id === extensionId && !isDeliveredApproval(item))
      if (record) approvals.push({projectId:project.id,record})
      if (record) impact.push({projectId:project.id,name:registered.find(row=>row.id===project.id)?.name || project.id,enabled:record.enabled,providers:(record.manifest.contributes?.chatProviders ?? []).map(provider => `${extensionId}/${provider.id}`)})
    }
    impact.sort((a,b) => a.projectId.localeCompare(b.projectId))
    const record = (await this.catalog.list()).find(item => item.manifest.id === extensionId)
    const revision = createHash('sha256').update(JSON.stringify({record,projects:impact,approvals:approvals.sort((a,b)=>a.projectId.localeCompare(b.projectId))})).digest('hex')
    return {extensionId,scope:'all-projects',revision,projects:impact,retainsConnectionData:true}
  }


  async prepareUpdate(id: string) {
    if (await this.canManageDelivered(id)) throw Error('Shipped adapters are updated with the host')
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
      const old = (await this.catalog.list()).find(record => record.manifest.id === preview.value.id)
      const installed = await this.installer.commitInstall(preview.value).finally(() => this.installer.discardInstall(preview.value))
      const record: ExtensionRecord = {
        manifest: installed.manifest,
        source: installed.source,
        installedAt: new Date().toISOString(),
        integrity: installed.integrity,
        enabled: false,
      }
      const id = record.manifest.id
      const shippedPeers = this.peers().filter(manager => manager.delivered.has(id))
      for (const peer of shippedPeers) await peer.serializeDelivery(async () => {
        const selected = (await peer.records()).find(item => item.manifest.id === id)
        if (selected) await peer.approve(selected)
      })
      const affected = await Promise.all(this.peers().filter(manager => !manager.delivered.has(id)).map(async manager => ({
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
        // Publish authorization before activation can start a receive loop. The cross-process
        // mutation lock excludes peer reconciliation until activation succeeds or rollback finishes.
        await this.catalog.update(records => [...records.filter(item => item.manifest.id !== id), record])
        for (const { manager, old } of affected) await manager.approve({ ...record, enabled: keepsConsent(old, record) })
        for (const { manager, old } of affected) {
          if (!keepsConsent(old, record)) continue
          manager.failures.delete(id)
          await manager.start(record)
        }
        for (const item of affected) await item.snapshot?.discard()
        await this.installer.pruneArtifacts(id, record.integrity).catch(() => undefined)
        return this.delivered.has(id) ? record : (await this.records()).find(item => item.manifest.id === id)!
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

  async uninstall(id: string, removeData = false, impactRevision?: string): Promise<boolean> {
    if (await this.canManageDelivered(id)) throw Error('Shipped adapters cannot be uninstalled; disable them for this project')
    return this.serialize(async () => {
      // Validate under the same cross-process lock as enable, update and uninstall.
      if (impactRevision !== undefined && (await this.uninstallImpact(id)).revision !== impactRevision) {
        throw new Error('uninstall impact changed; review the affected projects again')
      }
      const found = (await this.catalog.list()).some(item => item.manifest.id === id)
      for (const peer of this.peers()) if (!peer.delivered.has(id)) await peer.stop(id)
      await this.catalog.update(records => records.filter(item => item.manifest.id !== id))
      await this.installer.pruneArtifacts(id).catch(() => undefined)
      const projects = await this.knownProjects()
      // Retain declarations for saved connections, but revoke approval everywhere; reinstall never resumes code.
      for (const project of projects) {
        await new ExtensionStore(join(project.dataDir, 'extensions', 'registry.json'))
          .update(records => records.map(item => item.manifest.id === id && !isDeliveredApproval(item) ? {...item,enabled:false} : item))
          .catch(() => undefined)
      }
      if (removeData) {
        for (const project of projects) {
          const selected = (await new ExtensionStore(join(project.dataDir,'extensions','registry.json')).list()).find(item => item.manifest.id === id)
          if (selected && isDeliveredApproval(selected)) continue
          const scope = { kind: 'project' as const, projectId: project.id, root: project.root }
          for (const name of await extensionSecretNames(project.dataDir, id)) await project.secrets.unset(scope, name)
          await rm(join(project.dataDir, 'extensions', id), { recursive: true, force: true })
        }
      }
      return found
    })
  }

  /** Read-only authorization for the flag-off shipped-code exception. */
  async canManageDelivered(id: string): Promise<boolean> {
    if ((await this.catalog.list()).some(record => record.manifest.id === id)) return false
    const prior = (await this.approvals.list()).find(record => record.manifest.id === id)
    if (prior && !isDeliveredApproval(prior)) return false
    return (await loadChatDeliveryCatalog(this.deps.deliveryPackageRoot).catch(() => [])).some(item => item.extensionId === id)
  }

  private async changeDeliveredConsent(provider: ChatDeliveryArtifact['provider'], enabled: boolean): Promise<void> {
    if (hasChatSelectionOwner(this.projectRoot)) return setChatAdapterEnabled(this.projectRoot, provider, enabled)
    // Acquire the ordinary state owner without starting any receive/send work. This
    // preserves legacy native consent as well as the project extension approval.
    const [{WebhookService}, {WebhookScheduler}] = await Promise.all([import('../webhooks/service.ts'), import('../webhooks/scheduler.ts')])
    const owner = await WebhookService.open({root:this.projectRoot,dataDir:this.dataDir,projectId:this.projectId,mode:'local',serverPorts:()=>[],scheduler:new WebhookScheduler(),chatManagementOnly:true})
    try { await setChatAdapterEnabled(this.projectRoot, provider, enabled) }
    finally { await owner?.dispose() }
  }

  async setEnabled(id: string, enabled: boolean, integrity?: string, policy: { shippedOnly?: boolean } = {}): Promise<ExtensionRecord | undefined> {
    // Global catalog first, project selection second: installation uses the same order.
    // Cached declarations are not authority over a newer durable selection.
    const operation = async () => {
      const installed = (await this.catalog.list()).find(record => record.manifest.id === id)
      const selected = (await this.approvals.list()).find(record => record.manifest.id === id)
      const artifact = (await loadChatDeliveryCatalog(this.deps.deliveryPackageRoot).catch(() => [])).find(item => item.extensionId === id)
      const foreign = selected && !isDeliveredApproval(selected)
      if (policy.shippedOnly && (installed || foreign || !artifact)) throw Error('Shipped chat selection changed; review the current selection')
      if (this.delivered.has(id) && (foreign || !artifact)) throw Error('Chat selection changed; cached shipped declaration is no longer authoritative')
      if (artifact && this.delivered.has(id) && this.delivered.get(id)!.artifact.integrity !== artifact.integrity) throw Error('Shipped artifact changed during session')
      if (!this.delivered.has(id) && !installed && artifact && !foreign) await this.declareDelivery(artifact.provider)
      const record = (await this.records()).find(item => item.manifest.id === id)
      if (!record) return undefined
      if (enabled && integrity !== undefined && integrity !== record.integrity) {
        throw new Error('extension artifact changed; review its permissions again')
      }
      // An explicit choice replaces any pending automatic restart and its crash count.
      this.cancelRestart(id)
      this.restarts.delete(id)
      this.failures.delete(id)
      const next = { ...record, enabled }
      try {
        // Retire receive guards before making revocation visible to host service
        // authorization. Otherwise an in-flight session treats intentional disable
        // as a fatal protocol failure and persists fatalStop across re-enable.
        const delivery = this.delivered.get(id);
        if (delivery && record.enabled !== enabled) await this.changeDeliveredConsent(delivery.artifact.provider, enabled);
        if (!enabled) await this.stop(id)
        await this.approve(next)
        if (enabled) await this.start(next)
      } catch (error) {
        await this.approve(record)
        const delivery = this.delivered.get(id)
        if (delivery && record.enabled !== enabled) await this.changeDeliveredConsent(delivery.artifact.provider, record.enabled)
        if (!enabled && record.enabled) await this.start(record)
        throw error
      }
      return next
    }
    return this.serialize(() => this.serializeDelivery(operation))
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
        const restartOperation = async () => {
          const current = (await this.records()).find(item => item.manifest.id === id && item.enabled)
          if (current) await this.start(current)
          else await this.stop(id)
        }
        void (this.delivered.has(id) ? this.serializeDelivery(restartOperation) : this.serialize(restartOperation)).catch(() => undefined)
      }, next.delayMs)
      restart.timer.unref()
      ExtensionManager.changed()
    })
  }

  /** Verify and declare the canonical identity without starting executable code. */
  async declareDeliveredChat(provider: ChatDeliveryArtifact['provider']): Promise<void> {
    await this.serializeDelivery(async () => { await this.declareDelivery(provider) })
  }

  private async declareDelivery(provider: ChatDeliveryArtifact['provider']): Promise<string> {
    const artifact = (await loadChatDeliveryCatalog(this.deps.deliveryPackageRoot)).find(item => item.provider === provider)
    if (!artifact) throw Error('Shipped chat artifact unavailable')
    const id = artifact.manifest.id
    const approval = (await this.approvals.list()).find(record => record.manifest.id === id)
    if ((await this.catalog.list()).some(record => record.manifest.id === id) && !this.delivered.has(id) && !(approval && isDeliveredApproval(approval))) throw Error('Installed chat selection requires explicit resolution')
    const existing = this.delivered.get(id)
    if (existing && existing.artifact.integrity !== artifact.integrity) throw Error('Shipped artifact changed during session')
    if (!existing) this.delivered.set(id, {
      artifact,
      registration: await registerDeliveredChatSlot(this.projectRoot, artifact, () => this.startDeliveredChat(provider)),
      record: { manifest: artifact.manifest, source: 'bundled', installedAt: artifact.integrity, integrity: artifact.integrity, enabled: true },
    })
    return id
  }

  /** Explicit lifecycle entry used by configured native chat, never by metadata reads. */
  async startDeliveredChat(provider: ChatDeliveryArtifact['provider']): Promise<void> {
    return this.serializeDelivery(async () => {
      const id = await this.declareDelivery(provider)
      const record = (await this.records()).find(item => item.manifest.id === id)!
      if (record.enabled) await this.start(record)
    })
  }

  private async activate(record: ExtensionRecord): Promise<void> {
    const id = record.manifest.id
    assertExtensionHostFeatures(record.manifest)
    await this.stopping.get(id)
    if (this.closed) throw new Error('extension manager is closed')
    if (this.contexts.has(id)) return
    if (!record.integrity) throw new Error('reinstall this extension to create an immutable artifact')
    const digest = createHash('sha256').update(record.integrity).digest('hex')
    const delivered = this.delivered.get(id)?.artifact
    const root = await realpath(delivered?.root ?? join(this.home, 'extensions', 'artifacts', id, record.manifest.version, digest))
    if (await artifactIntegrity(root) !== record.integrity) throw new Error('installed extension artifact changed; reinstall and review it')
    const entry = await realpath(resolve(root, record.manifest.entry))
    const rel = relative(root, entry)
    const escapes = rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)
    if (escapes) throw new Error('extension entry must stay inside its installed directory')
    if (this.closed) throw new Error('extension manager is closed')

    // Distribution artifacts are immutable and not owned/pruned by ExtensionInstaller.
    // They require no writable home or synthetic install/approval record.
    const release = delivered ? async () => {} : await pinArtifact(this.home, id, digest, root)
    this.pins.set(id, release)
    this.artifacts.set(id, this.artifactKey(record))
    if (!delivered) this.watchCatalog()
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
        ...(delivered && this.deps.trustedChatInProcess ? { trustedInProcess: delivered } : {}),
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
    if (this.closed || !current?.enabled || this.artifactKey(current) !== this.artifactKey(record)) {
      // Revocation may come from another process between reconciler ticks.
      // Invalidate this generation synchronously, then drain outside the host
      // service call (awaiting its own teardown here would deadlock).
      if (this.artifacts.get(record.manifest.id) === this.artifactKey(record)) {
        void this.stop(record.manifest.id).catch(() => undefined)
      }
      throw new ChatTransportError({kind:'blocked'})
    }
  }

  private registerChat(record: ExtensionRecord, declaration: ExtensionChatProvider, context: ExtensionHostContext) {
    const id = record.manifest.id
    const descriptor = extensionChatDescriptor(id, declaration)
    const artifact = this.delivered.get(id)?.artifact
    const bindings = new Map<string,{revision:string;handle:string;ready:Promise<unknown>}>()
    const rotation = new SlackTokenRotation(slackRotationStorage({kind:'project',projectId:this.projectId,root:this.projectRoot},this.secrets,this.home))
    const invoke = async (botHandle: string, credential: string, operation: string, input: unknown, options: import('./host.ts').ExtensionCallOptions) => {
      const workerCredential = artifact && artifact.provider !== 'slack' ? JSON.stringify({token:credential}) : credential
      const credentials = parseChatCredential(workerCredential)
      for (const field of declaration.credentials) {
        const value = credentials[field.name]
        if (field.secret && value) context.rememberSecret(value)
      }
      try {
        const safeCredential = declaration.credentialProfile ? '{}' : workerCredential
        const service = async (method: string, input: unknown) => {
          await this.assertCurrent(record)
          if (options.signal?.aborted || options.valid?.() === false) throw new ChatTransportError({kind:'blocked'})
          if (method === 'accessToken') {
            if (declaration.credentialProfile !== 'slack-oauth-v1' || !input || typeof input !== 'object' || !('slot' in input) || (input.slot !== 'app' && input.slot !== 'bot') || Object.keys(input).length !== 1) throw new ChatTransportError({kind:'blocked'})
            const token = await rotation.token(decodeSlackCredentials(credential), input.slot, options.signal, options.valid)
            context.rememberSecret(token)
            await this.assertCurrent(record)
            if (options.signal?.aborted || options.valid?.() === false) throw new ChatTransportError({kind:'blocked'})
            return token
          }
          if (!options.service) throw new ChatTransportError({kind:'blocked'})
          return options.service(method,input)
        }
        const call = extensionChatCallSchema.parse({ providerId: declaration.id, botHandle, ...(declaration.credentialProfile ? {credentialProfile:declaration.credentialProfile} : {}), credential:safeCredential, operation, input })
        return context.redact(await (operation === 'receiveSession'
          ? this.host.receiveSession(id, call, {...options, service, authorize: () => this.assertCurrent(record)})
          : this.host.chat(id, call, {...options, service, authorize: () => this.assertCurrent(record)})))
      } catch (error) {
        if (error && typeof error === 'object' && 'failure' in error) throw error
        throw new Error(context.redact(errorMessage(error, 'Chat operation failed')))
      }
    }
    const register: typeof registerChatExtension = artifact
      ? async (_scope,_descriptor,factory) => { const registration=this.delivered.get(id)!.registration;await registration.setTransport(factory);return () => registration.setTransport(undefined) }
      : registerChatExtension
    return register(this.projectRoot, descriptor, (credential, valid = () => true, binding) => {
      let selected = binding ? bindings.get(binding.id) : undefined
      if (!selected || selected.revision !== binding?.revision) {
        const prior = selected
        selected = {revision:binding?.revision ?? '',handle:randomUUID(),ready:prior
          ? prior.ready.then(() => this.host.chat(id,{providerId:declaration.id,botHandle:prior.handle,credential:'{}',operation:'retire',input:{}},{authorize:()=>this.assertCurrent(record)}))
          : Promise.resolve()}
        void selected.ready.catch(() => undefined)
        if (binding) bindings.set(binding.id,selected)
      }
      const botHandle = selected.handle
      const bindingCurrent = () => !binding || bindings.get(binding.id) === selected
      return new ChatExtensionBridge(
        async (operation, input, options) => {
          await selected.ready
          if (binding) return invoke(botHandle, credential, operation, input, options)
          // Setup operations have no durable bot binding. Their adapter belongs to
          // this call only, including its full receive session, and is always retired.
          const temporary = randomUUID()
          try { return await invoke(temporary, credential, operation, input, options) }
          finally {
            await this.host.chat(id,{providerId:declaration.id,botHandle:temporary,credential:'{}',operation:'retire',input:{}}).catch(() => undefined)
          }
        },
        () => !this.closed && this.contexts.get(id) === context && bindingCurrent() && valid(),
        declaration.receiveModel, !artifact && descriptor.id.includes('/'),
        artifact?.provider === 'telegram' ? 'telegram-html' : artifact?.provider === 'slack' ? 'slack-mrkdwn' : undefined,
      )
    })
  }

  async restore(): Promise<void> {
    if (this.closed) return
    try {
      await this.serialize(async () => {
        const records = await this.records()
        if (records.length) this.watchCatalog()
        for (const record of records) {
          if (!record.enabled) continue
          // A failed activation stays visible; only a crash after activation restarts on its own.
          try { await this.start(record) } catch { /* recorded in failures */ }
        }
      }, true, () => undefined)
    } catch {
      await this.stopForUnavailableStorage()
      if (!this.closed && !this.restoreWarned) {
        this.restoreWarned = true
        const message = 'Extensions unavailable: could not restore from local storage'
        if (this.deps.log) this.deps.log('error', message, 'extensions')
        else console.warn(message)
      }
    }
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
    await this.deliveryMutations
    const ids = new Set([...this.contexts.keys(), ...this.chatCleanups.keys(), ...this.stopping.keys()])
    await Promise.all([...ids].map(id => this.stop(id)))
    for (const item of this.delivered.values()) await item.registration.dispose()
    this.delivered.clear()
    await Promise.all([...this.prepared.values()].map(preview => this.installer.discardInstall(preview.value)))
    this.prepared.clear()
    for (const timer of this.previewTimers.values()) clearTimeout(timer)
    this.previewTimers.clear()
    ExtensionManager.instances.delete(this)
    if (!this.peers().length) ExtensionManager.catalogMutations.delete(this.home)
  }
}
