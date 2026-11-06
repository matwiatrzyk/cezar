import { z } from 'zod'

export const extensionPermissionSchema = z.enum(['project.read', 'project.write', 'task.create', 'tasks.read']).transform(value => value === 'tasks.read' ? 'project.read' as const : value)
export type ExtensionPermission = z.infer<typeof extensionPermissionSchema>
export const extensionActionSchema = z.object({
  id: z.string().min(1).max(100),
  label: z.string().min(1).max(200).optional(),
  title: z.string().min(1).max(200).optional(),
  permission: extensionPermissionSchema.optional(),
}).strict().superRefine((action, ctx) => {
  if (!action.label && !action.title) ctx.addIssue({ code: 'custom', path: ['label'], message: 'label or title is required' })
  if (action.label && action.title && action.label !== action.title) ctx.addIssue({ code: 'custom', path: ['title'], message: 'title and label must agree' })
}).transform(({ title, ...action }) => ({ ...action, label: action.label ?? title! }))
export type ExtensionAction = z.infer<typeof extensionActionSchema>
export const extensionPanelSchema = z.object({
  id: z.string().min(1).max(100),
  title: z.string().min(1).max(200),
  text: z.string().max(20_000).optional(),
  blocks: z.array(z.discriminatedUnion('type', [
    z.object({ type: z.literal('text'), text: z.string().max(20_000) }).strict(),
    z.object({ type: z.literal('status'), label: z.string().max(200), value: z.string().max(200) }).strict(),
    z.object({ type: z.literal('table'), columns: z.array(z.string().max(100)).max(20), rows: z.array(z.array(z.string().max(2_000)).max(20)).max(100) }).strict(),
  ])).max(100).default([]),
  actions: z.array(extensionActionSchema).max(20).default([]),
}).strict()
export type ExtensionPanel = z.infer<typeof extensionPanelSchema>
export const extensionCapabilitySchema = z.enum(['commands', 'panels', 'taskEvents'])
export type ExtensionCapability = z.infer<typeof extensionCapabilitySchema>

export const extensionManifestSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/),
  name: z.string().min(1).max(200),
  version: z.string().min(1).max(100),
  apiVersion: z.literal('0.1'),
  schemaVersion: z.literal(1).optional(),
  entry: z.string().min(1).max(500).optional(),
  main: z.string().min(1).max(500).optional(),
  capabilities: z.array(extensionCapabilitySchema).max(20).optional(),
  permissions: z.array(extensionPermissionSchema).max(20).default([]),
  panels: z.array(extensionPanelSchema).max(50).default([]),
  actions: z.array(extensionActionSchema).max(50).default([]),
  contributes: z.object({
    commands: z.array(extensionActionSchema).max(50).default([]),
    panels: z.array(extensionPanelSchema).max(50).default([]),
  }).strict().optional(),
}).strict().superRefine((manifest, ctx) => {
  if (!manifest.entry && !manifest.main) ctx.addIssue({ code: 'custom', path: ['entry'], message: 'entry or main is required' })
  if (manifest.entry && manifest.main && manifest.entry !== manifest.main) ctx.addIssue({ code: 'custom', path: ['main'], message: 'main and entry must agree' })
}).transform(({ schemaVersion, main, capabilities, ...manifest }) => ({
  ...manifest, entry: manifest.entry ?? main!,
})).superRefine((manifest, ctx) => {
  if (!manifest.entry) return
  if (manifest.entry.startsWith('/') || /^[A-Za-z]:[\\/]/.test(manifest.entry)) ctx.addIssue({ code: 'custom', path: ['entry'], message: 'entry must stay inside the extension directory' })
  const ids = [...manifest.actions, ...(manifest.contributes?.commands ?? [])].map(action => action.id)
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', path: ['actions'], message: 'duplicate command id' })
  const panels = [...manifest.panels, ...(manifest.contributes?.panels ?? [])].map(panel => panel.id)
  if (new Set(panels).size !== panels.length) ctx.addIssue({ code: 'custom', path: ['panels'], message: 'duplicate panel id' })
})
export type ExtensionManifest = z.infer<typeof extensionManifestSchema>

export const extensionRecordSchema = z.object({
  manifest: extensionManifestSchema,
  source: z.string().min(1).max(4096),
  installedAt: z.string(),
  integrity: z.string().regex(/^sha512-[A-Za-z0-9+/]+={0,2}$/).optional(),
  enabled: z.boolean(),
}).strict()
export type ExtensionRecord = z.infer<typeof extensionRecordSchema>

export const extensionsResponseSchema = z.object({ extensions: z.array(extensionRecordSchema) }).strict()
export const installExtensionInputSchema = z.object({ source: z.string().trim().min(1).max(4096) }).strict()
export const extensionIdParamsSchema = z.object({ extensionId: z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/) })
export const extensionActionInputSchema = z.object({ actionId: z.string().min(1).max(100), input: z.record(z.string(), z.unknown()).optional() }).strict()
export const extensionActionResponseSchema = z.object({ ok: z.boolean(), message: z.string().optional() }).strict()
export const extensionPanelsResponseSchema = z.object({ panels: z.array(extensionPanelSchema) }).strict()
export const extensionPanelParamsSchema = extensionIdParamsSchema.extend({ panelId: z.string().min(1).max(100) })
export const extensionCommandParamsSchema = extensionIdParamsSchema.extend({ commandId: z.string().min(1).max(100) })
export const extensionPrepareInstallInputSchema = installExtensionInputSchema
export const extensionPrepareInstallResponseSchema = z.object({ preparedId: z.string().min(1).max(200), manifest: extensionManifestSchema, addedPermissions: z.array(extensionPermissionSchema) }).strict()
export const extensionCommitInstallInputSchema = z.object({ preparedId: z.string().min(1).max(200) }).strict()
export const extensionInvokeInputSchema = z.object({ input: z.record(z.string(), z.unknown()).optional() }).strict()
export const extensionMutationResponseSchema = z.object({ ok: z.literal(true) }).strict()
export const extensionTaskSummarySchema = z.object({ id: z.string().max(200), title: z.string().max(500), status: z.enum(['queued', 'running', 'waiting', 'review', 'done', 'failed', 'cancelled']) }).strict()
export const extensionTaskProposalSchema = z.object({ title: z.string().trim().min(1).max(500), prompt: z.string().trim().min(1).max(20_000), workflow: z.string().max(100).optional() }).strict()
export const extensionProposalReceiptSchema = z.object({ proposalId: z.string().min(1).max(200), accepted: z.literal(false), reason: z.string().max(500).optional() }).strict()
export const extensionTaskEventSchema = z.object({ sequence: z.number().int().nonnegative(), task: extensionTaskSummarySchema, type: z.enum(['created', 'updated', 'removed']) }).strict()
export type ExtensionTaskSummary = z.infer<typeof extensionTaskSummarySchema>
export type ExtensionTaskProposal = z.infer<typeof extensionTaskProposalSchema>
export type ExtensionProposalReceipt = z.infer<typeof extensionProposalReceiptSchema>
export type ExtensionTaskEvent = z.infer<typeof extensionTaskEventSchema>
export const extensionRpcRequestSchema = z.object({
  type: z.literal('request'), requestId: z.string().min(1).max(100), generation: z.string().min(1).max(100),
  method: z.enum(['activate', 'invoke', 'panel', 'deactivate']), params: z.unknown(),
}).strict()
export const extensionRpcResponseSchema = z.object({
  type: z.literal('response'), requestId: z.string().min(1).max(100), generation: z.string().min(1).max(100),
  ok: z.boolean(), result: z.unknown().optional(), error: z.object({ code: z.string(), message: z.string() }).optional(),
}).strict()
export const extensionRpcReadySchema = z.object({ type: z.literal('ready'), generation: z.string() }).strict()
export type ExtensionRpcRequest = z.infer<typeof extensionRpcRequestSchema>
export type ExtensionRpcResponse = z.infer<typeof extensionRpcResponseSchema>
export type InstallExtensionInput = z.infer<typeof installExtensionInputSchema>

export const extensionHostRequestSchema = z.object({
  type: z.literal('hostRequest'), requestId: z.string().min(1).max(100), generation: z.string().min(1).max(100),
  method: z.enum(['tasks.list', 'tasks.propose', 'storage.get', 'storage.set', 'secrets.get', 'secrets.set', 'logger.info', 'logger.error']),
  params: z.unknown(),
}).strict()
export type ExtensionHostRequest = z.infer<typeof extensionHostRequestSchema>
export const extensionStorageKeySchema = z.string().regex(/^[a-zA-Z0-9._-]{1,128}$/)
export const extensionStorageGetSchema = z.object({ key: extensionStorageKeySchema }).strict()
export const extensionStorageSetSchema = extensionStorageGetSchema.extend({ value: z.json() }).strict()
export const extensionSecretSetSchema = extensionStorageGetSchema.extend({ value: z.string().min(1).max(32768) }).strict()
export const extensionLogInputSchema = z.object({ message: z.string().max(4000) }).strict()
export const extensionEmptyInputSchema = z.object({}).strict()

/** Informational delivery can overflow; consumers reload their snapshot on this signal. */
export const extensionTaskNotificationSchema = z.union([
  extensionTaskEventSchema,
  z.object({ type: z.literal('resyncRequired') }).strict(),
])
export type ExtensionTaskNotification = z.infer<typeof extensionTaskNotificationSchema>
