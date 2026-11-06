/** Public schemas are also the host's wire contract. */
export * from './schemas.js'
import type { z } from 'zod'
import type {
  extensionFormSchema, extensionPanelSchema, extensionStorageSetSchema, ExtensionPermission,
  ExtensionTaskSummary, ExtensionTaskProposal, ExtensionProposalReceipt, ExtensionTaskNotification,
} from './schemas.js'

export type MaybePromise<T> = T | Promise<T>
export type Disposable = { dispose(): MaybePromise<unknown> }
export type ExtensionJsonValue = z.infer<typeof extensionStorageSetSchema>['value']
export type ExtensionActionResult = { message?: string } | void
/** Legacy onAction receives an action id; registered commands do not. */
export type ExtensionActionHandler = (actionId: string, input: Record<string, unknown> | undefined, context: ExtensionContext) => MaybePromise<ExtensionActionResult>
export type ExtensionCommandHandler = (input: Record<string, unknown> | undefined, context: ExtensionContext) => MaybePromise<ExtensionActionResult>
export type ExtensionPanelProvider = () => MaybePromise<z.input<typeof extensionPanelSchema>>

/** Fixed by the host. All data operations cross asynchronous IPC. */
export type ExtensionContext = Readonly<{
  projectId: string
  permissions: readonly ExtensionPermission[]
  commands: { register(id: string, handler: ExtensionCommandHandler): Disposable }
  panels: { register(id: string, provider: ExtensionPanelProvider): Disposable }
  chat: { register(id: string, factory: (credentials: Record<string, string>) => MaybePromise<import('./chat.js').ExtensionChatAdapter>): Disposable }
  forms: { register(id: string, provider: () => MaybePromise<z.input<typeof extensionFormSchema>>): Disposable }
  tasks: {
    list(): Promise<ExtensionTaskSummary[]>
    /** Returns a proposal receipt, never a launched task. */
    propose(input: ExtensionTaskProposal): Promise<ExtensionProposalReceipt>
  }
  storage: {
    get(key: string): Promise<ExtensionJsonValue | undefined>
    set(key: string, value: ExtensionJsonValue): Promise<null>
  }
  secrets: {
    get(key: string): Promise<string | null>
    set(key: string, value: string): Promise<null>
  }
  logger: { info(message: string): Promise<void>; error(message: string): Promise<void> }
  /** Informational events; reload the snapshot on resyncRequired. No durable replay. */
  taskEvents: { subscribe(handler: (event: ExtensionTaskNotification) => MaybePromise<void>): Disposable }
}>
export type ExtensionHostContext = ExtensionContext
export type ExtensionDefinition = {
  activate?(context: ExtensionContext): MaybePromise<Disposable | void>
  deactivate?(): MaybePromise<void>
  onAction?: ExtensionActionHandler
}
/** Identity helper. The host loads the manifest separately from this lifecycle object. */
export function defineExtension<T extends ExtensionDefinition>(definition: T): T { return definition }
