import { useSyncExternalStore } from 'react'
import type { DashboardTaskRow } from '@open-mercato/cezar-api-client'
// Thin transition overlay; it never synthesizes a dashboard row. A staged row must stop
// offering an obsolete action immediately, before the debounced authoritative read returns.
const rows = new Map<
  string,
  { value: { status: DashboardTaskRow['status']; archived: boolean } | null; revision: number }
>()
const listeners = new Set<() => void>()
let version = 0
export function dashboardTransition(
  project: string,
  run: { id: string; status: DashboardTaskRow['status']; archived: boolean } | string,
) {
  const key = `${project}:${typeof run === 'string' ? run : run.id}`
  rows.delete(key)
  rows.set(key, {
    value: typeof run === 'string' ? null : { status: run.status, archived: run.archived },
    revision: version + 1,
  })
  if (rows.size > 2000) rows.delete(rows.keys().next().value!)
  version++
  listeners.forEach((fn) => fn())
}
export function useDashboardTruth(row: Pick<DashboardTaskRow, 'projectId' | 'id'>) {
  useSyncExternalStore(
    (fn) => {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },
    () => version,
  )
  return dashboardTruth(row.projectId, row.id)
}

export const dashboardTruthRevision = () => version
export const dashboardTruth = (projectId: string, runId: string) =>
  rows.get(`${projectId}:${runId}`)?.value
/** An authoritative read supersedes transitions observed before the read began. A frame
 * arriving while that request was in flight remains overlaid until the next reconciliation.
 * Deletion is stronger: absence from a bounded page proves nothing, so its tombstone survives
 * until the same identity is positively returned by a newer authoritative snapshot. */
export function reconcileDashboardTruth(
  revision: number,
  present: readonly Pick<DashboardTaskRow, 'projectId' | 'id'>[] = [],
) {
  const identities = new Set(present.map((row) => `${row.projectId}:${row.id}`))
  let changed = false
  for (const [key, entry] of rows)
    if (entry.revision <= revision && (entry.value !== null || identities.has(key))) {
      rows.delete(key)
      changed = true
    }
  if (changed) {
    version++
    listeners.forEach((fn) => fn())
  }
}
