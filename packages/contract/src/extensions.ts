import { z } from 'zod'

export const extensionPermissionSchema = z.enum(['project.read', 'project.write', 'task.create'])
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
export const extensionActionInputSchema = z.object({ actionId: z.string().min(1).max(100), input: z.record(z.string(), z.unknown()).optional() }).strict()
export const extensionActionResponseSchema = z.object({ ok: z.boolean(), message: z.string().optional() }).strict()
export const extensionPanelsResponseSchema = z.object({ panels: z.array(extensionPanelSchema) }).strict()
export type InstallExtensionInput = z.infer<typeof installExtensionInputSchema>
