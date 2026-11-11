import type { ExtensionCapability, ExtensionRecord } from '@open-mercato/cezar-contract'
import { extensionCapabilitySchema } from '@open-mercato/cezar-contract'
import { sourceIdentity } from './installer.ts'

/** A manifest without `capabilities` is unrestricted at runtime, so it is compared as holding all. */
const effectiveCapabilities = (manifest: ExtensionRecord['manifest']): readonly ExtensionCapability[] =>
  manifest.capabilities ?? extensionCapabilitySchema.options

export const SUPPORTED_EXTENSION_HOST_FEATURES = new Set(['chat.receive.eventless-checkpoints', 'chat.receive.session.v1', 'chat.credentials.slack-rotation.v1', 'chat.native-task-choices.v1', 'chat.presentation.v1'])
export function assertExtensionHostFeatures(manifest: ExtensionRecord['manifest']): void {
  const missing = (manifest.requiredHostFeatures ?? []).filter(feature => !SUPPORTED_EXTENSION_HOST_FEATURES.has(feature))
  if (missing.length) throw new Error(`unsupported required host feature: ${missing.join(', ')}`)
}

/** A project's approval covers the installed artifact it names, or a later update that asks for
 *  nothing more — so a project that was not open during an update keeps its consent too. */
export function approved(approval: ExtensionRecord | undefined, record: ExtensionRecord): boolean {
  if (!approval?.enabled) return false
  const same = approval.integrity === record.integrity && approval.installedAt === record.installedAt
  return same || keepsConsent(approval, record)
}

export const isDeliveredApproval = (record: ExtensionRecord): boolean =>
  record.source === 'bundled' && !!record.integrity && record.installedAt === record.integrity

type ConsentInput = Pick<ExtensionRecord, 'manifest' | 'source'>

export const addedPermissions = (old: ConsentInput | undefined, next: ConsentInput) =>
  next.manifest.permissions.filter(permission => !old?.manifest.permissions.includes(permission))

export const addedCapabilities = (old: ConsentInput | undefined, next: ConsentInput) => {
  const before = old ? effectiveCapabilities(old.manifest) : []
  return effectiveCapabilities(next.manifest).filter(capability => !before.includes(capability))
}

/** An update keeps a project's approval only when it comes from the same source and asks for
 *  nothing the approved version lacked. */
export function keepsConsent(old: (ConsentInput & { enabled: boolean }) | undefined, next: ConsentInput): boolean {
  if (!old?.enabled) return false
  const priorProviders = old.manifest.contributes?.chatProviders
  return sourceIdentity(old.source) === sourceIdentity(next.source)
    && addedPermissions(old, next).length === 0
    && addedCapabilities(old, next).length === 0
    && (next.manifest.contributes?.chatProviders ?? []).every(provider => !provider.credentialProfile
      || priorProviders?.some(prior => prior.id === provider.id && prior.credentialProfile === provider.credentialProfile))
}
