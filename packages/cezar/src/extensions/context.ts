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
  disable(): void { this.active = false }
}
