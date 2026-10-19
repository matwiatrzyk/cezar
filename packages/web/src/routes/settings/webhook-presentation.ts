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

export function webhookGuide(_metadata?: Pick<SelfUpdateStatus, 'version' | 'installKind'>) {
  return {
    href: 'https://github.com/open-mercato/cezar/blob/main/packages/cezar/docs/webhooks.md',
    note: 'Open receiver guide',
  }
}
