import { createHash } from 'node:crypto'
import { SecretStore } from '../workspace/secrets.ts'
import { redactSecrets } from '../core/secret-redaction.ts'
import { extensionEmptyInputSchema, extensionStorageGetSchema, extensionStorageSetSchema, extensionSecretSetSchema, extensionLogInputSchema, extensionTaskProposalSchema, extensionTaskSummarySchema } from '@open-mercato/cezar-contract'
import type { ExtensionPermission, ExtensionTaskEvent, ExtensionTaskProposal, ExtensionTaskSummary, ExtensionProposalReceipt } from '@open-mercato/cezar-contract'
import { ExtensionStorage } from './data.ts'
import { ExtensionTaskEventBus } from './events.ts'
import { requireExtensionPermission } from './permissions.ts'

export interface ExtensionContextDeps {
  dataDir: string
  projectId: string
  projectRoot: string
  extensionId: string
  permissions: readonly ExtensionPermission[]
  listTasks?: () => Promise<ExtensionTaskSummary[]>
  proposeTask?: (input: ExtensionTaskProposal) => Promise<ExtensionProposalReceipt>
  secrets?: SecretStore
  log?: (level: 'info' | 'error', message: string) => void
  events?: ExtensionTaskEventBus
}

/** The host-side context passed to an extension. No project id or root can be selected by the
 * extension; they are fixed at construction and task proposals are intentionally not launches. */
export class ExtensionHostContext {
  readonly storage: ExtensionStorage
  readonly events: ExtensionTaskEventBus
  readonly projectId: string
  readonly projectRoot: string
  private active = true
  private readonly knownSecrets = new Set<string>()
  constructor(private readonly deps: ExtensionContextDeps) {
    this.projectId = deps.projectId; this.projectRoot = deps.projectRoot
    this.storage = new ExtensionStorage(deps.dataDir, deps.extensionId)
    this.events = deps.events ?? new ExtensionTaskEventBus()
  }
  private ensureActive() { if (!this.active) throw new Error('extension host context is disabled') }
  private permission(permission: ExtensionPermission) { this.ensureActive(); requireExtensionPermission(this.deps.permissions, permission) }
  async listTasks(): Promise<ExtensionTaskSummary[]> { this.permission('project.read'); return (await this.deps.listTasks?.() ?? []).map(task => ({ ...task })) }
  async proposeTask(input: ExtensionTaskProposal): Promise<ExtensionProposalReceipt> {
    this.permission('task.create')
    return this.deps.proposeTask ? this.deps.proposeTask(input) : { proposalId: `${this.deps.extensionId}-${Date.now()}`, accepted: false, reason: 'task proposals are not connected' }
  }
  subscribe(listener: (event: ExtensionTaskEvent) => void): () => void { this.ensureActive(); return this.events.subscribe(listener) }
  async dispatch(method: string, input: unknown, signal: AbortSignal): Promise<unknown> {
    this.ensureActive()
    if (signal.aborted) throw new Error('extension stopped')
    switch (method) {
      case 'tasks.list':
        extensionEmptyInputSchema.parse(input)
        return (await this.listTasks()).map(task => extensionTaskSummarySchema.parse(task))
      case 'tasks.propose': return this.proposeTask(extensionTaskProposalSchema.parse(input))
      case 'storage.get': return this.storage.get(extensionStorageGetSchema.parse(input).key)
      case 'storage.set': {
        const { key, value } = extensionStorageSetSchema.parse(input)
        await this.storage.set(key, value, () => { this.ensureActive(); if (signal.aborted) throw Error('extension stopped') }); return null
      }
      case 'secrets.get':
      case 'secrets.set': {
        const parsed = extensionStorageGetSchema.parse(method === 'secrets.set' ? { key: extensionSecretSetSchema.parse(input).key } : input)
        const name = `EXTENSION_${createHash('sha256').update(`${this.deps.extensionId}\0${parsed.key}`).digest('hex').toUpperCase()}`
        const scope = { kind: 'project' as const, projectId: this.projectId, root: this.projectRoot }
        const store = this.deps.secrets ?? new SecretStore()
        if (method === 'secrets.set') {
          const { value } = extensionSecretSetSchema.parse(input)
          this.knownSecrets.add(value)
          await store.set(scope, name, value, ['cezar']); return null
        }
        const entry = (await store.read(scope)).values[name]
        if (!entry || entry.audiences.length !== 1 || entry.audiences[0] !== 'cezar') return null
        this.knownSecrets.add(entry.value); return entry.value
      }
      case 'logger.info':
      case 'logger.error': {
        const { message } = extensionLogInputSchema.parse(input)
        let safe = message
        for (const value of this.knownSecrets) safe = safe.replaceAll(value, '[REDACTED]')
        this.deps.log?.(method === 'logger.info' ? 'info' : 'error', redactSecrets(safe, [])); return null
      }
      default: throw new Error('unknown host operation')
    }
  }
  disable(): void { this.active = false }

}
