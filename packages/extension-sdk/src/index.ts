/** Public, dependency-free SDK types. The host validates the same wire shapes at its boundary. */
export type ExtensionPermission = 'project.read' | 'project.write' | 'task.create'
export type ExtensionAction = { id: string; label: string; permission?: ExtensionPermission }
export type ExtensionPanel = { id: string; title: string; text?: string; actions?: ExtensionAction[] }
export type ExtensionManifest = {
  id: string
  name: string
  version: string
  apiVersion: '0.1'
  entry: string
  permissions?: ExtensionPermission[]
  panels?: ExtensionPanel[]
  actions?: ExtensionAction[]
}
export type ExtensionHostContext = Readonly<{
  projectId: string
  projectRoot: string
  permissions: readonly string[]
}>
export type ExtensionActionHandler = (actionId: string, input: Record<string, unknown> | undefined, context: ExtensionHostContext) => Promise<{ message?: string } | void>
export type ExtensionDefinition = ExtensionManifest & { onAction?: ExtensionActionHandler }
export function defineExtension(definition: ExtensionDefinition): ExtensionDefinition { return definition }
