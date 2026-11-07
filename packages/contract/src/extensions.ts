// Extension HTTP route shapes. The author surface (manifest, panels, forms, chat) is owned by the
// public SDK and re-exported from its workspace SOURCE, so no SDK build is needed to run the repo.
// The worker IPC protocol is internal to the service (packages/cezar/src/extensions/protocol.ts).
import { z } from 'zod'
import { extensionCapabilitySchema, extensionFormSchema, extensionManifestSchema, extensionPermissionSchema, extensionTaskProposalSchema } from '@open-mercato/cezar-extension-sdk/source'
export * from '@open-mercato/cezar-extension-sdk/source'

export const extensionRecordSchema = z.object({
  manifest: extensionManifestSchema,
  source: z.string().min(1).max(4096),
  installedAt: z.string(),
  integrity: z.string().regex(/^sha512-[A-Za-z0-9+/]+={0,2}$/).optional(),
  enabled: z.boolean(),
  status: z.enum(['disabled', 'starting', 'running', 'failed']).optional(),
  error: z.string().max(500).optional(),
}).strict()
export type ExtensionRecord = z.infer<typeof extensionRecordSchema>

export const extensionsResponseSchema = z.object({ extensions: z.array(extensionRecordSchema) }).strict()
export const installExtensionInputSchema = z.object({ source: z.string().trim().min(1).max(4096) }).strict()
export const extensionIdParamsSchema = z.object({ extensionId: z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/) })
export const extensionActionResponseSchema = z.object({ ok: z.boolean(), message: z.string().optional(), proposals: z.array(extensionTaskProposalSchema).max(10).optional() }).strict()
export const extensionPanelParamsSchema = extensionIdParamsSchema.extend({ panelId: z.string().min(1).max(100) })
export const extensionCommandParamsSchema = extensionIdParamsSchema.extend({ commandId: z.string().min(1).max(100) })
export const extensionPrepareInstallInputSchema = installExtensionInputSchema
/** What committing a preview changes for an already-installed id: every consent-relevant
 *  difference, and how many projects run it now (they keep it only when `keepsConsent`). */
export const extensionReplacementSchema = z.object({
  version: z.string(), sourceChanged: z.boolean(), keepsConsent: z.boolean(), enabledProjects: z.number().int().nonnegative(),
}).strict()
export const extensionPrepareInstallResponseSchema = z.object({
  preparedId: z.string().min(1).max(200), manifest: extensionManifestSchema,
  addedPermissions: z.array(extensionPermissionSchema), addedCapabilities: z.array(extensionCapabilitySchema),
  replaces: extensionReplacementSchema.optional(),
}).strict()
export const extensionCommitInstallInputSchema = z.object({ preparedId: z.string().min(1).max(200) }).strict()
export const extensionEnableInputSchema = z.object({ integrity: z.string().min(1) }).strict()
export const extensionInvokeInputSchema = z.object({ input: z.record(z.string(), z.unknown()).optional() }).strict()
/** Every extension route's refusal: 400 failed, 404 unknown, 409 extensions unavailable here. */
export const extensionErrorResponseSchema = z.object({ error: z.string() }).strict()
export const extensionMutationResponseSchema = z.object({ ok: z.literal(true) }).strict()
export type InstallExtensionInput = z.infer<typeof installExtensionInputSchema>
export const extensionFormsResponseSchema = z.object({ forms: z.array(extensionFormSchema) }).strict()
export const extensionUninstallQuerySchema = z.object({ removeData: z.enum(['true', 'false']).optional() }).strict()
