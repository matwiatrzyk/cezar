import { extensionSecretNames } from './data.ts'
import { SecretStore } from '../workspace/secrets.ts'
import { loadWorkspaceConfig } from '../workspace/config.ts'
import { registerChatExtension } from '../chat/registry.ts'
import { ChatExtensionBridge, extensionChatDescriptor } from './chat-bridge.ts'
import { extensionChatCallSchema } from '@open-mercato/cezar-contract'
import { existsSync } from 'node:fs'
import { realpath, rm } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { validateExtensionForm, extensionFormSchema, type ExtensionForm, type ExtensionTaskProposal, extensionPanelSchema, type ExtensionPanel, type ExtensionRecord } from '@open-mercato/cezar-contract'
import { cezarHomeDir } from '../paths.ts'
import { ExtensionHost } from './host.ts'
import { ExtensionHostContext, type ExtensionContextDeps } from './context.ts'
import { artifactIntegrity, ExtensionInstaller, isPackageSource, type PreparedInstall } from './installer.ts'
import { ExtensionStore } from './store.ts'
import { snapshotExtensionState } from './updates.ts'
import { requireExtensionPermission } from './permissions.ts'
import { extensionCapabilitySchema, type ExtensionCapability } from '@open-mercato/cezar-contract'

/** A manifest without `capabilities` is unrestricted at runtime, so it is compared as holding all. */
const effectiveCapabilities = (manifest: ExtensionRecord['manifest']): readonly ExtensionCapability[] => manifest.capabilities ?? extensionCapabilitySchema.options
/** An update keeps a project's approval only when it asks for nothing the approved version lacked. */
export function keepsConsent(old: ExtensionRecord | undefined, next: ExtensionRecord): boolean {
  if (!old?.enabled) return false
  const capabilities = effectiveCapabilities(old.manifest)
  return next.manifest.permissions.every(permission => old.manifest.permissions.includes(permission))
    && effectiveCapabilities(next.manifest).every(capability => capabilities.includes(capability))
}

type ManagerDeps = Pick<ExtensionContextDeps, 'listTasks' | 'proposeTask' | 'events' | 'secrets' | 'log'> & { home?: string }

/** Installed artifacts are global; approval binds one project to an exact artifact. */
export class ExtensionManager {
  private static readonly listeners = new Set<() => void>()
  static subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private static changed() { for (const listener of this.listeners) { try { listener() } catch { /* optional view */ } } }
  private readonly unsubscribeEvents: (() => void) | undefined
  private static readonly instances = new Set<ExtensionManager>()
  private static readonly catalogMutations = new Map<string, Promise<unknown>>()
  private readonly host = new ExtensionHost()
  private readonly chatCleanups = new Map<string, (() => Promise<void>)[]>()
  private readonly proposals = new Map<string, { extensionId: string; items: ExtensionTaskProposal[] }>()
  private readonly failures = new Map<string, string>()
  private readonly starting = new Map<string, Promise<void>>()
  private readonly stopping = new Map<string, Promise<void>>()
  private readonly previewTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly contexts = new Map<string, ExtensionHostContext>()
  private readonly prepared = new Map<string, { value: PreparedInstall; expiresAt: number }>()
  private readonly installer: ExtensionInstaller
  private readonly catalog: ExtensionStore
  private readonly approvals: ExtensionStore
  private readonly home: string
  private readonly secrets: SecretStore
  private closed = false
  private mutations: Promise<unknown> = Promise.resolve()
  constructor(private readonly dataDir: string, private readonly projectId: string, private readonly projectRoot: string, private readonly deps: ManagerDeps = {}) {
    this.home = deps.home ?? cezarHomeDir()
    this.secrets = deps.secrets ?? new SecretStore({ ...process.env, CEZ_HOME: this.home })
    this.installer = new ExtensionInstaller(this.home)
    this.catalog = new ExtensionStore(join(this.home, 'extensions', 'registry.json'))
    this.approvals = new ExtensionStore(join(dataDir, 'extensions', 'registry.json'))
    ExtensionManager.instances.add(this)
    this.unsubscribeEvents = deps.events?.subscribe(() => ExtensionManager.changed())
  }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = (ExtensionManager.catalogMutations.get(this.home) ?? Promise.resolve()).then(() => { if (this.closed) throw Error('extension manager is closed'); return operation() })
    this.mutations = result.catch(() => undefined).finally(() => ExtensionManager.changed())
    ExtensionManager.catalogMutations.set(this.home, this.mutations)
    return result
  }
  private peers() { return [...ExtensionManager.instances].filter(manager => manager.home === this.home && !manager.closed) }
  async list(): Promise<ExtensionRecord[]> {
    const [installed, approvals] = await Promise.all([this.catalog.list(), this.approvals.list()])
    return installed.map(record => ({ ...record, status: this.failures.has(record.manifest.id) ? 'failed' as const : this.starting.has(record.manifest.id) ? 'starting' as const : this.contexts.has(record.manifest.id) ? 'running' as const : 'disabled' as const, ...(this.failures.has(record.manifest.id) ? { error: this.failures.get(record.manifest.id)! } : {}), enabled: !!record.integrity && approvals.some(item => item.manifest.id === record.manifest.id && item.integrity === record.integrity && item.installedAt === record.installedAt && item.enabled) }))
  }
  async installed(): Promise<ExtensionRecord[]> { return this.catalog.list() }
  async prepareUpdate(id: string) {
    const record = (await this.catalog.list()).find(item => item.manifest.id === id)
    if (!record) throw Error('extension not found')
    const preview = await this.prepare(record.source)
    if (preview.manifest.id !== id) { await this.discard(preview.preparedId); throw Error('extension id changed during update') }
    return preview
  }
  async install(source: string): Promise<ExtensionRecord> { return this.commit((await this.prepare(source)).preparedId) }
  async prepare(source: string) {
    if (this.closed) throw Error('extension manager is closed')
    for (const [id, preview] of this.prepared) if (preview.expiresAt < Date.now()) { this.prepared.delete(id); await this.installer.discardInstall(preview.value) }
    if (this.prepared.size >= 10) throw Error('too many pending extension previews')
    const local = resolve(this.projectRoot, source)
    const value = await this.installer.prepareInstall(!isPackageSource(source) && existsSync(local) ? local : source)
    if (this.closed) { await this.installer.discardInstall(value); throw Error('extension manager is closed') }
    const previous = (await this.list()).find(record => record.manifest.id === value.id)
    const preparedId = randomUUID()
    this.prepared.set(preparedId, { value, expiresAt: Date.now() + 10 * 60_000 })
    const timer = setTimeout(() => { void this.discard(preparedId).catch(() => undefined) }, 10 * 60_000)
    timer.unref()
    this.previewTimers.set(preparedId, timer)
    return { preparedId, manifest: value.manifest, addedPermissions: value.manifest.permissions.filter(permission => !previous?.manifest.permissions.includes(permission)) }
  }
  commit(preparedId: string): Promise<ExtensionRecord> {
    return this.serialize(async () => {
      const preview = this.prepared.get(preparedId)
      if (!preview || preview.expiresAt < Date.now()) throw Error('extension install preview expired')
      clearTimeout(this.previewTimers.get(preparedId)); this.previewTimers.delete(preparedId)
      this.prepared.delete(preparedId)
      const old = (await this.list()).find(record => record.manifest.id === preview.value.id)
      const installed = await this.installer.commitInstall(preview.value).finally(() => this.installer.discardInstall(preview.value))
      const record: ExtensionRecord = { manifest: installed.manifest, source: installed.source, installedAt: new Date().toISOString(), integrity: installed.integrity, enabled: false }
      const affected = await Promise.all(this.peers().map(async manager => ({
        manager, old: (await manager.list()).find(item => item.manifest.id === record.manifest.id),
        snapshot: undefined as Awaited<ReturnType<typeof snapshotExtensionState>> | undefined,
        restoreSecrets: undefined as (() => Promise<void>) | undefined,
      })))
      try {
        for (const item of affected) {
          await item.manager.stop(record.manifest.id)
          if (item.old) { item.restoreSecrets = await item.manager.snapshotSecrets(record.manifest.id); item.snapshot = await snapshotExtensionState(join(item.manager.dataDir, 'extensions', record.manifest.id)) }
        }
        for (const { manager, old } of affected) {
          const resume = keepsConsent(old, record)
          if (resume) { manager.failures.delete(record.manifest.id); await manager.start(record) }
        }
        await this.catalog.update(records => [...records.filter(item => item.manifest.id !== record.manifest.id), record])
        for (const { manager, old } of affected) {
          const enabled = keepsConsent(old, record)
          await manager.approve({ ...record, enabled })
        }
        for (const item of affected) await item.snapshot?.discard()
        return (await this.list()).find(item => item.manifest.id === record.manifest.id)!
      } catch (error) {
        for (const item of affected) await item.manager.stop(record.manifest.id)
        await this.catalog.update(records => [
          ...records.filter(item => item.manifest.id !== record.manifest.id),
          ...(old ? [{ ...old, enabled: false }] : []),
        ])
        for (const item of affected) {
          await item.restoreSecrets?.()
          await item.snapshot?.restore()
          if (item.old) await item.manager.approve(item.old)
          else await item.manager.approvals.update(records => records.filter(item => item.manifest.id !== record.manifest.id))
          if (item.old?.enabled && !item.manager.closed) { item.manager.failures.delete(record.manifest.id); await item.manager.start(item.old) }
        }
        throw error
      }
    })
  }
  private async snapshotSecrets(id: string): Promise<() => Promise<void>> {
    const scope = { kind: 'project' as const, projectId: this.projectId, root: this.projectRoot }
    const names = await extensionSecretNames(this.dataDir, id)
    const snapshot = await this.secrets.read(scope)
    if (names.length && snapshot.skipped) throw Error('extension secrets are unavailable; cannot safely snapshot this update')
    return async () => {
      for (const name of await extensionSecretNames(this.dataDir, id)) {
        const previous = names.includes(name) ? snapshot.values[name] : undefined
        if (previous) await this.secrets.set(scope, name, previous.value, previous.audiences)
        else await this.secrets.unset(scope, name)
      }
    }
  }
  private approve(record: ExtensionRecord) { return this.approvals.update(records => [...records.filter(item => item.manifest.id !== record.manifest.id), record]) }
  uninstall(id: string, removeData = false): Promise<boolean> {
    return this.serialize(async () => {
      const found = (await this.catalog.list()).some(item => item.manifest.id === id)
      for (const peer of this.peers()) await peer.stop(id)
      await this.catalog.update(records => records.filter(item => item.manifest.id !== id))
      for (const peer of this.peers()) await peer.approvals.update(records => records.filter(item => item.manifest.id !== id))
      if (removeData) {
        const projects = new Map(this.peers().map(manager => [manager.projectRoot, { root: manager.projectRoot, id: manager.projectId, dataDir: manager.dataDir, secrets: manager.secrets }]))
        for (const project of (await loadWorkspaceConfig(join(this.home, 'config.json'))).projects ?? []) if (!projects.has(project.root)) projects.set(project.root, { root: project.root, id: project.id, dataDir: join(project.root, '.ai/cezar'), secrets: this.secrets })
        for (const project of projects.values()) {
          for (const name of await extensionSecretNames(project.dataDir, id)) await project.secrets.unset({ kind: 'project', projectId: project.id, root: project.root }, name)
          await rm(join(project.dataDir, 'extensions', id), { recursive: true, force: true })
        }
      }
      return found
    })
  }
  setEnabled(id: string, enabled: boolean, integrity?: string): Promise<ExtensionRecord | undefined> {
    return this.serialize(async () => {
      const record = (await this.list()).find(item => item.manifest.id === id)
      if (!record) return undefined
      if (enabled && integrity !== undefined && integrity !== record.integrity) throw Error('extension artifact changed; review its permissions again')
      this.failures.delete(id)
      if (enabled) await this.start(record); else await this.stop(id)
      const next = { ...record, enabled }; await this.approve(next); return next
    })
  }
  private stop(id: string): Promise<void> {
    const existing = this.stopping.get(id)
    if (existing) return existing
    for (const [key, queue] of this.proposals) if (queue.extensionId === id) this.proposals.delete(key); this.contexts.get(id)?.disable(); this.contexts.delete(id)
    const cleanups = this.chatCleanups.get(id) ?? []
    this.chatCleanups.delete(id)
    const stopping = (async () => { await this.host.deactivate(id); for (const cleanup of cleanups) await cleanup() })()
    this.stopping.set(id, stopping)
    void stopping.finally(() => { if (this.stopping.get(id) === stopping) this.stopping.delete(id) }).catch(() => undefined)
    return stopping
  }
  private async start(record: ExtensionRecord): Promise<void> {
    const id = record.manifest.id
    const existing = this.starting.get(id)
    if (existing) return existing
    if (this.failures.has(id)) throw Error(this.failures.get(id))
    const starting = this.activate(record)
    this.starting.set(id, starting)
    try { await starting } catch (error) { this.failures.set(id, error instanceof Error ? error.message.slice(0, 500) : 'Extension failed'); throw error } finally { if (this.starting.get(id) === starting) this.starting.delete(id) }
  }
  private async activate(record: ExtensionRecord): Promise<void> {
    await this.stopping.get(record.manifest.id)
    if (this.closed) throw Error('extension manager is closed')
    if (this.contexts.has(record.manifest.id)) return
    if (!record.integrity) throw Error('reinstall this extension to create an immutable artifact')
    const digest = createHash('sha256').update(record.integrity).digest('hex')
    const root = await realpath(join(this.home, 'extensions', 'artifacts', record.manifest.id, record.manifest.version, digest))
    if (await artifactIntegrity(root) !== record.integrity) throw Error('installed extension artifact changed; reinstall and review it')
    const entry = await realpath(resolve(root, record.manifest.entry))
    const rel = relative(root, entry)
    if (rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) throw Error('extension entry must stay inside its installed directory')
    if (this.closed) throw Error('extension manager is closed')
    const context = new ExtensionHostContext({ ...this.deps, secrets: this.secrets, dataDir: this.dataDir, projectId: this.projectId, projectRoot: this.projectRoot, extensionId: record.manifest.id, proposeTask: async (proposal, invocationId) => {
      if (this.closed || !this.contexts.has(record.manifest.id)) throw Error('extension stopped')
      const queue = invocationId ? this.proposals.get(invocationId) : undefined
      if (!queue || queue.extensionId !== record.manifest.id) throw Error('Task proposals require an active command invocation')
      if (queue.items.length >= 10) throw Error('too many pending task proposals')
      queue.items.push(proposal)
      return { proposalId: randomUUID(), accepted: false }
    }, permissions: record.manifest.permissions })
    this.contexts.set(record.manifest.id, context)
    try { await this.host.activate({ id: record.manifest.id, manifest: record.manifest, entry, projectId: this.projectId, sanitize: value => context.redact(value), onFailure: error => { context.disable(); this.contexts.delete(record.manifest.id); this.failures.set(record.manifest.id, context.redact(error.message).slice(0, 500)); void this.stop(record.manifest.id).catch(() => undefined).finally(() => ExtensionManager.changed()) }, dispatch: (method, params, signal, invocationId) => context.dispatch(method, params, signal, invocationId), ...(record.manifest.permissions.includes('project.read') ? { subscribe: (listener: (event: unknown) => void) => context.subscribe(listener) } : {}) }) }
    catch (error) { context.disable(); this.contexts.delete(record.manifest.id); const message = context.redact(error instanceof Error ? error.message : 'Extension activation failed'); this.failures.set(record.manifest.id, message.slice(0, 500)); throw Error(message) }
    const cleanups: (() => Promise<void>)[] = []
    this.chatCleanups.set(record.manifest.id, cleanups)
    try {
      for (const declaration of record.manifest.contributes?.chatProviders ?? []) {
        const descriptor = extensionChatDescriptor(record.manifest.id, declaration)
        cleanups.push(await registerChatExtension(this.projectRoot, descriptor, (credential, valid = () => true) =>
          new ChatExtensionBridge(async (operation, input) => {
            const credentials = JSON.parse(credential) as Record<string, string>
            for (const field of declaration.credentials) if (field.secret && credentials[field.name]) context.rememberSecret(credentials[field.name]!)
            try { return context.redact(await this.host.chat(record.manifest.id, extensionChatCallSchema.parse({ providerId: declaration.id, credential, operation, input }))) }
            catch (error) { if (error && typeof error === 'object' && 'failure' in error) throw error; throw Error(context.redact(error instanceof Error ? error.message : 'Chat operation failed')) }
          }, () => !this.closed && this.contexts.get(record.manifest.id) === context && valid())))
      }
    } catch (error) { await this.stop(record.manifest.id); throw error }
  }
  restore(): Promise<void> { return this.serialize(async () => {
    for (const record of await this.list()) if (record.enabled) {
      try { await this.start(record) } catch { /* Failure is visible; never retry automatically. */ }
    }
  }) }
  async discard(preparedId: string): Promise<void> {
    const preview = this.prepared.get(preparedId)
    this.prepared.delete(preparedId)
    clearTimeout(this.previewTimers.get(preparedId)); this.previewTimers.delete(preparedId)
    if (preview) await this.installer.discardInstall(preview.value)
  }
  private async enabled(id: string): Promise<ExtensionRecord> {
    const record = (await this.list()).find(item => item.manifest.id === id && item.enabled)
    if (!record) { await this.stop(id); throw Error('extension is not enabled') }
    if (!this.contexts.has(id)) throw Error(this.failures.get(id) ?? 'extension is not running; enable or retry it')
    return record
  }
  async panel(id: string, panelId: string): Promise<ExtensionPanel | undefined> {
    const record = await this.enabled(id)
    if (![...record.manifest.panels, ...(record.manifest.contributes?.panels ?? [])].some(panel => panel.id === panelId)) return undefined
    const panel = extensionPanelSchema.parse(this.contexts.get(id)!.redact(await this.host.panel(id, panelId)))
    if (panel.id !== panelId) throw Error('extension panel identity changed')
    const commands = [...record.manifest.actions, ...(record.manifest.contributes?.commands ?? [])]
    if (panel.actions.some(action => !commands.some(command => command.id === action.id))) throw Error('extension panel references an undeclared command')
    return panel
  }
  async panels(): Promise<ExtensionPanel[]> {
    const result: ExtensionPanel[] = []
    for (const record of await this.list()) if (record.enabled) for (const declaration of [...record.manifest.panels, ...(record.manifest.contributes?.panels ?? [])]) {
      const panel = await this.panel(record.manifest.id, declaration.id); if (panel) result.push(panel)
    }
    return result
  }
  async forms(id: string): Promise<ExtensionForm[]> {
    const record = await this.enabled(id)
    const result: ExtensionForm[] = []
    for (const declaration of record.manifest.contributes?.forms ?? []) {
      const form = extensionFormSchema.parse(this.contexts.get(id)!.redact(await this.host.form(id, declaration.id)))
      if (form.id !== declaration.id || ![...record.manifest.actions, ...(record.manifest.contributes?.commands ?? [])].some(command => command.id === form.commandId)) throw Error('undeclared form command')
      if (form.commandId !== declaration.commandId || JSON.stringify(form.fields) !== JSON.stringify(declaration.fields)) throw Error('extension form fields changed from the approved declaration')
      if (form.values) for (const field of form.fields) if (field.type === 'password') delete form.values[field.key]
      result.push(form)
    }
    return result
  }
  async invoke(id: string, actionId: string, input?: Record<string, unknown>): Promise<{ ok: boolean; message?: string; proposals?: ExtensionTaskProposal[] }> {
    const record = await this.enabled(id)
    const action = [...record.manifest.actions, ...(record.manifest.contributes?.commands ?? [])].find(action => action.id === actionId)
    if (!action) throw Error('extension action is not declared')
    if (action.permission) requireExtensionPermission(record.manifest.permissions, action.permission)
    for (const form of record.manifest.contributes?.forms ?? []) if (form.commandId === actionId) input = validateExtensionForm(form, input ?? {})
    const context = this.contexts.get(id)!
    for (const form of record.manifest.contributes?.forms ?? []) if (form.commandId === actionId) for (const field of form.fields) {
      const value = input?.[field.key]
      if (field.type === 'password' && typeof value === 'string') context.rememberSecret(value)
    }
    const invocationId = randomUUID()
    const queue = { extensionId: id, items: [] as ExtensionTaskProposal[] }
    this.proposals.set(invocationId, queue)
    try {
      const result = context.redact(await this.host.invoke(id, actionId, input, invocationId))
      const message = result && typeof result === 'object' && 'message' in result ? result.message : undefined
      const proposals = context.redact(queue.items)
      return { ok: true, ...(proposals.length ? { proposals } : {}), ...(typeof message === 'string' ? { message } : {}) }
    } catch (error) { throw Error(context.redact(error instanceof Error ? error.message : 'Extension command failed')) }
    finally { this.proposals.delete(invocationId) }
  }

  async close(): Promise<void> {
    this.closed = true
    this.unsubscribeEvents?.()
    for (const context of this.contexts.values()) context.disable()
    await ExtensionManager.catalogMutations.get(this.home)
    await Promise.all([...new Set([...this.contexts.keys(), ...this.chatCleanups.keys(), ...this.stopping.keys()])].map(id => this.stop(id)))
    await Promise.all([...this.prepared.values()].map(preview => this.installer.discardInstall(preview.value)))
    this.prepared.clear()
    for (const timer of this.previewTimers.values()) clearTimeout(timer)
    this.previewTimers.clear()
    ExtensionManager.instances.delete(this)
    if (!this.peers().length) ExtensionManager.catalogMutations.delete(this.home)
  }
}
