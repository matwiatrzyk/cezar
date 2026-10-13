import type { SelfUpdateStatus, WebhookReceiverState } from '@open-mercato/cezar-api-client'

import type { StatusDotTone } from '@/components/status-dot'

export const endpointHealthTone: Record<WebhookReceiverState, StatusDotTone> = {
  inactive: 'neutral', active: 'success', paused: 'neutral', suspended: 'pending', disabled: 'danger',
}

export function webhookTimeZone(zone?: string) {
  try {
    if (zone) { new Intl.DateTimeFormat(undefined, { timeZone: zone }); return { zone, label: zone } }
  } catch { /* A missing/unsupported server zone must not be advertised as local time. */ }
  return { zone: 'UTC', label: 'UTC (server timezone unavailable)' }
}
export function webhookTime(value: string, zone?: string) {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return 'Time unavailable'
  return date.toLocaleString(undefined, { timeZone: webhookTimeZone(zone).zone, timeZoneName: 'short' })
}

export function webhookGuide(metadata?: Pick<SelfUpdateStatus, 'version' | 'installKind'>) {
  // Only published stable versions have the v<version> tag promised by release.yml.
  const released = metadata && ['managed', 'global-npm', 'npx'].includes(metadata.installKind) && /^\d+\.\d+\.\d+$/.test(metadata.version)
  return {
    href: `https://github.com/open-mercato/cezar/blob/${released ? `v${metadata.version}` : 'main'}/packages/cezar/docs/webhooks.md`,
    note: released ? `Receiver guide for cezar ${metadata.version}.` : 'Development, snapshot or unknown build: this guide follows main and may differ from your installation. Use the receiver guide from your source checkout when available.',
  }
}
