import { existsSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { extensionPanelSchema, type ExtensionPanel, type ExtensionRecord } from '@open-mercato/cezar-contract'
import { cezarHomeDir } from '../paths.ts'
import { ExtensionHost } from './host.ts'
import { ExtensionHostContext, type ExtensionContextDeps } from './context.ts'
import { ExtensionInstaller, type PreparedInstall } from './installer.ts'
import { ExtensionStore } from './store.ts'
import { snapshotExtensionState } from './updates.ts'
import { requireExtensionPermission } from './permissions.ts'

type ManagerDeps = Pick<ExtensionContextDeps, 'listTasks' | 'proposeTask' | 'events' | 'secrets' | 'log'> & { home?: string }

/** Installed artifacts are global; approval binds one project to an exact artifact. */
export class ExtensionManager {
  private readonly host = new ExtensionHost()
  private readonly contexts = new Map<string, ExtensionHostContext>()
  private readonly prepared = new Map<string, { value: PreparedInstall; expiresAt: number }>()
  private readonly installer: ExtensionInstaller
  private readonly catalog: ExtensionStore
  private readonly approvals: ExtensionStore
  private readonly home: string
  private closed = false
  private mutations: Promise<unknown> = Promise.resolve()
  constructor(private readonly dataDir: string, private readonly projectId: string, private readonly projectRoot: string, private readonly deps: ManagerDeps = {}) {
    this.home = deps.home ?? cezarHomeDir()
    this.installer = new ExtensionInstaller(this.home)
    this.catalog = new ExtensionStore(join(this.home, 'extensions', 'registry.json'))
    this.approvals = new ExtensionStore(join(dataDir, 'extensions', 'registry.json'))
  }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutations.then(() => { if (this.closed) throw Error('extension manager is closed'); return operation() })
    this.mutations = result.catch(() => undefined)
    return result
  }
  async list(): Promise<ExtensionRecord[]> {
    const [installed, approvals] = await Promise.all([this.catalog.list(), this.approvals.list()])
    return installed.map(record => ({ ...record, enabled: !!record.integrity && approvals.some(item => item.manifest.id === record.manifest.id && item.integrity === record.integrity && item.enabled) }))
  }
  async install(source: string): Promise<ExtensionRecord> { return this.commit((await this.prepare(source)).preparedId) }
  async prepare(source: string) {
    if (this.closed) throw Error('extension manager is closed')
    for (const [id, preview] of this.prepared) if (preview.expiresAt < Date.now()) { this.prepared.delete(id); await this.installer.discardInstall(preview.value) }
    if (this.prepared.size >= 10) throw Error('too many pending extension previews')
    const local = resolve(this.projectRoot, source)
    const value = await this.installer.prepareInstall(existsSync(local) ? local : source)
    if (this.closed) { await this.installer.discardInstall(value); throw Error('extension manager is closed') }
    const previous = (await this.list()).find(record => record.manifest.id === value.id)
    const preparedId = randomUUID()
    this.prepared.set(preparedId, { value, expiresAt: Date.now() + 10 * 60_000 })
    return { preparedId, manifest: value.manifest, addedPermissions: value.manifest.permissions.filter(permission => !previous?.manifest.permissions.includes(permission)) }
  }
  commit(preparedId: string): Promise<ExtensionRecord> {
    return this.serialize(async () => {
      const preview = this.prepared.get(preparedId)
      if (!preview || preview.expiresAt < Date.now()) throw Error('extension install preview expired')
      this.prepared.delete(preparedId)
      const old = (await this.list()).find(record => record.manifest.id === preview.value.id)
      const installed = await this.installer.commitInstall(preview.value)
      const record: ExtensionRecord = { manifest: installed.manifest, source: installed.source, installedAt: new Date().toISOString(), integrity: installed.integrity, enabled: false }
      // Updates retain existing approval only when the new manifest asks for no new access.
      const resume = !!old?.enabled && record.manifest.permissions.every(permission => old.manifest.permissions.includes(permission))
      await this.stop(record.manifest.id)
      const snapshot = old ? await snapshotExtensionState(join(this.dataDir, 'extensions', record.manifest.id)) : undefined
      try {
        if (resume) await this.start(record)
        await this.catalog.update(records => [...records.filter(item => item.manifest.id !== record.manifest.id), record])
        if (resume) await this.approve({ ...record, enabled: true })
        await snapshot?.discard()
        return { ...record, enabled: resume }
      } catch (error) {
        await this.stop(record.manifest.id)
        await snapshot?.restore()
        if (old) {
          await this.catalog.update(records => [...records.filter(item => item.manifest.id !== old.manifest.id), { ...old, enabled: false }])
          if (old.enabled) await this.start(old)
        }
        throw error
      }
    })
  }
  private approve(record: ExtensionRecord) { return this.approvals.update(records => [...records.filter(item => item.manifest.id !== record.manifest.id), record]) }
  uninstall(id: string): Promise<boolean> {
    return this.serialize(async () => {
      const found = (await this.catalog.list()).some(item => item.manifest.id === id)
      await this.stop(id)
      await this.catalog.update(records => records.filter(item => item.manifest.id !== id))
      await this.approvals.update(records => records.filter(item => item.manifest.id !== id))
      return found
    })
  }
  setEnabled(id: string, enabled: boolean): Promise<ExtensionRecord | undefined> {
    return this.serialize(async () => {
      const record = (await this.list()).find(item => item.manifest.id === id)
      if (!record) return undefined
      if (enabled) await this.start(record); else await this.stop(id)
      const next = { ...record, enabled }; await this.approve(next); return next
    })
  }
  private async stop(id: string) { this.contexts.get(id)?.disable(); this.contexts.delete(id); await this.host.deactivate(id) }
  private async start(record: ExtensionRecord): Promise<void> {
    if (this.closed) throw Error('extension manager is closed')
    if (this.contexts.has(record.manifest.id)) return
    if (!record.integrity) throw Error('reinstall this extension to create an immutable artifact')
    const digest = createHash('sha256').update(record.integrity).digest('hex')
    const root = await realpath(join(this.home, 'extensions', 'artifacts', record.manifest.id, record.manifest.version, digest))
    const entry = await realpath(resolve(root, record.manifest.entry))
    const rel = relative(root, entry)
    if (rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) throw Error('extension entry must stay inside its installed directory')
    const context = new ExtensionHostContext({ ...this.deps, dataDir: this.dataDir, projectId: this.projectId, projectRoot: this.projectRoot, extensionId: record.manifest.id, permissions: record.manifest.permissions })
    this.contexts.set(record.manifest.id, context)
    try { await this.host.activate({ id: record.manifest.id, manifest: record.manifest, entry, projectId: this.projectId, dispatch: (method, params, signal) => context.dispatch(method, params, signal) }) }
    catch (error) { context.disable(); this.contexts.delete(record.manifest.id); throw error }
  }
  private async enabled(id: string): Promise<ExtensionRecord> {
    const record = (await this.list()).find(item => item.manifest.id === id && item.enabled)
    if (!record) { await this.stop(id); throw Error('extension is not enabled') }
    await this.start(record); return record
  }
  async panel(id: string, panelId: string): Promise<ExtensionPanel | undefined> {
    const record = await this.enabled(id)
    if (![...record.manifest.panels, ...(record.manifest.contributes?.panels ?? [])].some(panel => panel.id === panelId)) return undefined
    const panel = extensionPanelSchema.parse(await this.host.panel(id, panelId))
    if (panel.id !== panelId) throw Error('extension panel identity changed')
    return panel
  }
  async panels(): Promise<ExtensionPanel[]> {
    const result: ExtensionPanel[] = []
    for (const record of await this.list()) if (record.enabled) for (const declaration of [...record.manifest.panels, ...(record.manifest.contributes?.panels ?? [])]) {
      const panel = await this.panel(record.manifest.id, declaration.id); if (panel) result.push(panel)
    }
    return result
  }
  async invoke(id: string, actionId: string, input?: Record<string, unknown>): Promise<{ ok: boolean; message?: string }> {
    const record = await this.enabled(id)
    const action = [...record.manifest.actions, ...(record.manifest.contributes?.commands ?? [])].find(action => action.id === actionId)
    if (!action) throw Error('extension action is not declared')
    if (action.permission) requireExtensionPermission(record.manifest.permissions, action.permission)
    const result = await this.host.invoke(id, actionId, input)
    const message = result && typeof result === 'object' && 'message' in result ? result.message : undefined
    return { ok: true, ...(typeof message === 'string' ? { message } : {}) }
  }
  async close(): Promise<void> {
    this.closed = true
    await this.mutations
    await Promise.all([...this.contexts.keys()].map(id => this.stop(id)))
    await Promise.all([...this.prepared.values()].map(preview => this.installer.discardInstall(preview.value)))
    this.prepared.clear()
  }
}
