import type { ExtensionAction, ExtensionManifest, ExtensionPanel } from '@open-mercato/cezar-contract'

export type { ExtensionManifest, ExtensionPanel, ExtensionAction }
export type ExtensionHostContext = Readonly<{
  projectId: string
  projectRoot: string
  permissions: readonly string[]
}>
export type ExtensionActionHandler = (actionId: string, input: Record<string, unknown> | undefined, context: ExtensionHostContext) => Promise<{ message?: string } | void>
export type ExtensionDefinition = ExtensionManifest & { onAction?: ExtensionActionHandler }
export function defineExtension(definition: ExtensionDefinition): ExtensionDefinition { return definition }
