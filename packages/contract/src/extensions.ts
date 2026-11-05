import { z } from 'zod'

export const extensionPermissionSchema = z.enum(['project.read', 'project.write', 'task.create'])
export type ExtensionPermission = z.infer<typeof extensionPermissionSchema>
export const extensionActionSchema = z.object({
  id: z.string().min(1).max(100),
  label: z.string().min(1).max(200),
  permission: extensionPermissionSchema.optional(),
}).strict()
export type ExtensionAction = z.infer<typeof extensionActionSchema>
export const extensionPanelSchema = z.object({
  id: z.string().min(1).max(100),
  title: z.string().min(1).max(200),
  text: z.string().max(20_000).optional(),
  /** Declarative content only; HTML and arbitrary React are intentionally not accepted. */
  blocks: z.array(z.discriminatedUnion('type', [
    z.object({ type: z.literal('text'), text: z.string().max(20_000) }).strict(),
    z.object({ type: z.literal('status'), label: z.string().max(200), value: z.string().max(200) }).strict(),
    z.object({ type: z.literal('table'), columns: z.array(z.string().max(100)).max(20), rows: z.array(z.array(z.string().max(2_000)).max(20)).max(100) }).strict(),
  ])).max(100).default([]),
  actions: z.array(extensionActionSchema).max(20).default([]),
}).strict()
export type ExtensionPanel = z.infer<typeof extensionPanelSchema>
export const extensionManifestSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/),
  name: z.string().min(1).max(200),
  version: z.string().min(1).max(100),
  apiVersion: z.literal('0.1'),
  entry: z.string().min(1).max(500),
  permissions: z.array(extensionPermissionSchema).max(20).default([]),
  panels: z.array(extensionPanelSchema).max(50).default([]),
  actions: z.array(extensionActionSchema).max(50).default([]),
}).strict()
export type ExtensionManifest = z.infer<typeof extensionManifestSchema>

export const extensionRecordSchema = z.object({
  manifest: extensionManifestSchema,
  source: z.string().min(1).max(4096),
  installedAt: z.string(),
  enabled: z.boolean(),
}).strict()
export type ExtensionRecord = z.infer<typeof extensionRecordSchema>

export const extensionsResponseSchema = z.object({ extensions: z.array(extensionRecordSchema) }).strict()
export const installExtensionInputSchema = z.object({ source: z.string().trim().min(1).max(4096) }).strict()
export const extensionIdParamsSchema = z.object({ extensionId: z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/) }).strict()
export const extensionPanelParamsSchema = extensionIdParamsSchema.extend({ panelId: z.string().min(1).max(100) }).strict()
export const extensionCommandParamsSchema = extensionIdParamsSchema.extend({ commandId: z.string().min(1).max(100) }).strict()
export const extensionActionInputSchema = z.object({ actionId: z.string().min(1).max(100), input: z.record(z.string(), z.unknown()).optional() }).strict()
export const extensionActionResponseSchema = z.object({ ok: z.boolean(), message: z.string().optional() }).strict()
export const extensionPanelsResponseSchema = z.object({ panels: z.array(extensionPanelSchema) }).strict()
export type InstallExtensionInput = z.infer<typeof installExtensionInputSchema>

export const extensionPrepareInstallInputSchema = installExtensionInputSchema
export const extensionPrepareInstallResponseSchema = z.object({
  preparedId: z.string().min(1).max(200),
  manifest: extensionManifestSchema,
  addedPermissions: z.array(extensionPermissionSchema),
}).strict()
export const extensionCommitInstallInputSchema = z.object({ preparedId: z.string().min(1).max(200) }).strict()
export const extensionUpdateInputSchema = z.object({ version: z.string().min(1).max(100), approvePermissions: z.boolean().optional() }).strict()
export const extensionUninstallInputSchema = z.object({ preserveData: z.boolean().default(true) }).strict()
export const extensionProjectStateSchema = z.object({
  extensionId: extensionIdParamsSchema.shape.extensionId,
  enabled: z.boolean(),
  approvedPermissions: z.array(extensionPermissionSchema),
  manifest: extensionManifestSchema,
}).strict()
export const extensionTaskSummarySchema = z.object({ id: z.string().max(200), title: z.string().max(500), status: z.enum(['queued', 'running', 'review', 'done', 'failed', 'cancelled']) }).strict()
export const extensionTaskProposalSchema = z.object({ title: z.string().trim().min(1).max(500), prompt: z.string().trim().min(1).max(20_000), workflow: z.string().max(100).optional() }).strict()
export const extensionProposalReceiptSchema = z.object({ proposalId: z.string().min(1).max(200), accepted: z.literal(false), reason: z.string().max(500).optional() }).strict()
export const extensionTaskEventSchema = z.object({ sequence: z.number().int().nonnegative(), task: extensionTaskSummarySchema, type: z.enum(['created', 'updated', 'removed']) }).strict()
export const extensionStorageValueSchema = z.record(z.string(), z.unknown())
export const extensionInvokeInputSchema = z.object({ input: z.record(z.string(), z.unknown()).optional() }).strict()
export const extensionInvokeResponseSchema = extensionActionResponseSchema
export const extensionMutationResponseSchema = z.object({ ok: z.literal(true) }).strict()
export type ExtensionPrepareInstallResponse = z.infer<typeof extensionPrepareInstallResponseSchema>
export type ExtensionTaskSummary = z.infer<typeof extensionTaskSummarySchema>
export type ExtensionTaskProposal = z.infer<typeof extensionTaskProposalSchema>
export type ExtensionTaskEvent = z.infer<typeof extensionTaskEventSchema>
