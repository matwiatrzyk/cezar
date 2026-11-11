import type { ExtensionInventoryItem, ExtensionRecord } from '@open-mercato/cezar-contract'
import type { CanonicalChatProvider, ChatSelectionTarget } from './chat-selection-store.ts'
import type { ChatDeliveryArtifact } from './delivery-catalog.ts'
import { approved, isShippedApproval, SHIPPED_SOURCE } from './consent.ts'
import { isPackageSource } from './installer.ts'

export type PinnedSelection = {
  provider: CanonicalChatProvider
  target: Extract<ChatSelectionTarget, { kind: 'installed' }>
  present: boolean
}
export type InventoryInput = {
  installed: ExtensionRecord[]
  saved: ExtensionRecord[]
  shipped: ChatDeliveryArtifact[]
  pinned: Map<string, PinnedSelection>
  hostVersion: string
  unavailable?: 'flag-disabled' | 'hosted' | undefined
  status: (id: string) => NonNullable<ExtensionRecord['status']>
  failed: (id: string) => boolean
}

/** Metadata projection only: nothing here reconciles, leases or activates extension code. */
export function projectInventory(input: InventoryInput): ExtensionInventoryItem[] {
  const { installed, saved, shipped, pinned, hostVersion, unavailable, status, failed } = input
  const records = new Map(saved.map(record => [record.manifest.id, record]))
  const shippedRecords = new Set<string>()
  const shippedArtifacts = new Map(shipped.map(artifact => [artifact.extensionId, artifact]))
  for (const artifact of shipped) {
    if ([...pinned.values()].some(item => item.provider === artifact.provider)) {
      const old = records.get(artifact.extensionId)
      if (old && isShippedApproval(old)) records.delete(artifact.extensionId)
      continue
    }
    // An explicit installed selection is never replaced by a host update.
    const prior = records.get(artifact.extensionId)
    if (!prior || isShippedApproval(prior)) {
      shippedRecords.add(artifact.extensionId)
      records.set(artifact.extensionId, {
        manifest: artifact.manifest, source: SHIPPED_SOURCE, installedAt: artifact.integrity,
        integrity: artifact.integrity, enabled: prior?.enabled ?? true,
      })
    }
  }
  for (const [id, item] of pinned) records.set(id, item.target.record)
  const candidates = new Map<string, ExtensionRecord>()
  for (const record of installed) {
    const selected = pinned.get(record.manifest.id)
    if (selected) {
      if (selected.target.record.integrity !== record.integrity) candidates.set(record.manifest.id, record)
      continue
    }
    const selection = saved.find(item => item.manifest.id === record.manifest.id)
    if (shippedRecords.has(record.manifest.id) && selection && isShippedApproval(selection)) candidates.set(record.manifest.id, record)
    else {
      records.set(record.manifest.id, record)
      shippedRecords.delete(record.manifest.id)
    }
  }
  const projectArtifact = (record: ExtensionRecord, candidate = false): Omit<ExtensionInventoryItem, 'installedCandidate'> => {
    const id = record.manifest.id
    const artifact = !candidate && shippedRecords.has(id) ? shippedArtifacts.get(id) : undefined
    const selected = !candidate ? pinned.get(id) : undefined
    const globallyInstalled = installed.some(item => item.manifest.id === id)
    const present = selected ? selected.present : !!artifact || globallyInstalled
    const approval = saved.find(item => item.manifest.id === id)
    const enabled = !candidate && present && (artifact ? record.enabled : approved(approval, record))
    const source = record.source
    const kind = isPackageSource(source) ? 'npm' as const : /\.(tgz|tar\.gz)$/i.test(source) ? 'tarball' as const : 'folder' as const
    const availability = unavailable === 'hosted' || (unavailable === 'flag-disabled' && !artifact) ? unavailable : undefined
    return {
      record: { ...record, enabled, status: candidate ? 'disabled' : status(id) },
      provenance: artifact ? { kind: 'bundled' as const, hostVersion, integrity: artifact.integrity } : { kind, source },
      availability: availability ?? (!present ? 'missing' : !enabled ? 'disabled' : failed(id) ? 'failed' : 'available'),
      selectedVersion: record.manifest.version,
      management: {
        enable: !candidate && present && !enabled && !availability,
        disable: present && enabled && !availability,
        update: globallyInstalled && present && !artifact && !availability,
        uninstall: globallyInstalled && present && !artifact && !availability,
      },
      providers: (record.manifest.contributes?.chatProviders ?? []).map(provider => ({
        id: artifact ? artifact.provider : selected?.target.localProviderId === provider.id ? selected.provider : `${id}/${provider.id}`,
        label: provider.label,
      })),
    }
  }
  return [...records.values()].map(record => {
    const candidate = candidates.get(record.manifest.id)
    return { ...projectArtifact(record), ...(candidate ? { installedCandidate: projectArtifact(candidate, true) } : {}) }
  })
}
