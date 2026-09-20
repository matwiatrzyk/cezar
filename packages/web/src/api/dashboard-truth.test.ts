import { describe, expect, it } from 'vitest'
import {
  dashboardTransition,
  dashboardTruth,
  dashboardTruthRevision,
  reconcileDashboardTruth,
} from './dashboard-truth'
import { compareFeedRows } from './dashboard'
describe('dashboard reconciliation', () => {
  it('retains deletion tombstones without positive identity proof and preserves newer frames', () => {
    dashboardTransition('project', 'deleted')
    dashboardTransition('project', { id: 'done', status: 'done', archived: false })
    const revision = dashboardTruthRevision()
    dashboardTransition('project', { id: 'newer', status: 'running', archived: false })
    reconcileDashboardTruth(revision)
    expect(dashboardTruth('project', 'deleted')).toBeNull()
    reconcileDashboardTruth(revision, [{ projectId: 'project', id: 'deleted' }])
    expect(dashboardTruth('project', 'deleted')).toBeUndefined()
    expect(dashboardTruth('project', 'done')).toBeUndefined()
    expect(dashboardTruth('project', 'newer')?.status).toBe('running')
  })
  it('sorts timestamp values instead of ISO spelling', () => {
    const older = { key: 'github', at: '2026-09-18T12:00:00Z' }
    const newer = { key: 'task', at: '2026-09-18T12:00:00.500Z' }
    expect([older, newer].sort(compareFeedRows)).toEqual([newer, older])
  })
})
