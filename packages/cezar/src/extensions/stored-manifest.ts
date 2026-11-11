import { z } from 'zod'
import { extensionManifestSchema, extensionRecordSchema, type ExtensionManifest } from '@open-mercato/cezar-contract'

// The only home of the spellings the SDK dropped: installed bytes and saved consent outlive them (BACKWARD_COMPATIBILITY.md §6b); delete this file to end that support.

/** The features the last host that read `requiredHostFeatures` supported. Any other value still fails the strict parse. */
const LEGACY_HOST_FEATURES = new Set(['chat.receive.eventless-checkpoints', 'chat.receive.session.v1', 'chat.credentials.slack-rotation.v1', 'chat.native-task-choices.v1', 'chat.presentation.v1'])

type Fields = Record<string, unknown>
const isFields = (value: unknown): value is Fields => !!value && typeof value === 'object' && !Array.isArray(value)
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : []
const permission = (value: unknown) => value === 'tasks.read' ? 'project.read' : value

function foldAction(action: unknown): unknown {
  if (!isFields(action)) return action
  const { title, ...rest } = action
  return { ...rest, label: rest.label ?? title, ...(rest.permission === undefined ? {} : { permission: permission(rest.permission) }) }
}
function foldPanel(panel: unknown): unknown {
  return isFields(panel) && Array.isArray(panel.actions) ? { ...panel, actions: panel.actions.map(foldAction) } : panel
}

/** An absent list meant unrestricted at runtime. This keeps only what the manifest's declarations
 *  and approved permissions could reach, so a later update asking for more asks again. */
function inferCapabilities(contributes: Fields, permissions: unknown[]): string[] {
  return [
    ...(['commands', 'panels', 'forms', 'chatProviders'] as const).filter(kind => list(contributes[kind]).length),
    ...(permissions.includes('project.read') ? ['taskEvents'] : []),
  ]
}

/** Old spellings to the current shape. Anything it does not recognize passes through for the strict parse to refuse. */
export function foldLegacyManifest(raw: unknown): unknown {
  if (!isFields(raw)) return raw
  const { schemaVersion, main, panels, actions, requiredHostFeatures, ...rest } = raw
  const declared = isFields(rest.contributes) ? rest.contributes : {}
  const commands = [...list(actions), ...list(declared.commands)].map(foldAction)
  const allPanels = [...list(panels), ...list(declared.panels)].map(foldPanel)
  const contributes = { ...declared, commands, panels: allPanels }
  const permissions = list(rest.permissions).map(permission)
  return {
    ...rest,
    ...(schemaVersion === 1 || schemaVersion === undefined ? {} : { schemaVersion }),
    ...(list(requiredHostFeatures).every(feature => LEGACY_HOST_FEATURES.has(feature as string)) ? {} : { requiredHostFeatures }),
    entry: rest.entry ?? main,
    permissions,
    capabilities: rest.capabilities ?? inferCapabilities(contributes, permissions),
    ...(rest.contributes !== undefined || commands.length || allPanels.length ? { contributes } : {}),
  }
}

/** Never for a new install: `extensionManifestSchema` alone accepts those. */
export const parseStoredManifest = (raw: unknown): ExtensionManifest => extensionManifestSchema.parse(foldLegacyManifest(raw))

/** A record already on disk (registry, approval, chat selection), read through the same fold. */
export const storedRecordSchema = z.preprocess(
  raw => isFields(raw) ? { ...raw, manifest: foldLegacyManifest(raw.manifest) } : raw,
  extensionRecordSchema,
)
