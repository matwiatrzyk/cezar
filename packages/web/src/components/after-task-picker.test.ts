import { describe, expect, it } from 'vitest'
import type { ApiRun } from '@open-mercato/cezar-api-client'
import { afterCandidates } from './after-task-picker'
import { chainWait } from '@/routes/task-thread/task-thread'
import { newTaskPrefillHref, parseNewTaskParams } from '@/routes/new-task-params'

const run = (id: string, status: ApiRun['status'], createdAt: string, extra: Partial<ApiRun> = {}) =>
  ({ id, title: `task ${id}`, status, createdAt, archived: false, workflow: 'quick-task', task: '', steps: [], ...extra }) as ApiRun

describe('afterCandidates', () => {
  const runs = [
    run('old-done', 'done', '2026-10-01T00:00:00Z'),
    run('new-done', 'review', '2026-10-03T00:00:00Z'),
    run('running', 'running', '2026-10-02T00:00:00Z'),
    run('gone', 'done', '2026-10-04T00:00:00Z', { archived: true }),
  ]
  it('lists unfinished tasks first, then the newest, never archived ones', () => {
    expect(afterCandidates(runs, '').map((r) => r.id)).toEqual(['running', 'new-done', 'old-done'])
  })
  it('matches the title or an id prefix, and caps the list', () => {
    expect(afterCandidates(runs, 'TASK OLD').map((r) => r.id)).toEqual(['old-done'])
    expect(afterCandidates(runs, 'new-').map((r) => r.id)).toEqual(['new-done'])
    expect(afterCandidates(runs, '', 1)).toHaveLength(1)
  })
})

describe('chainWait', () => {
  it('names an unfinished predecessor and flags a failed or stopped one as stalled', () => {
    expect(chainWait({ afterRunId: 'a' }, [run('a', 'running', '')])).toMatchObject({ id: 'a', title: 'task a', stalled: false })
    expect(chainWait({ afterRunId: 'a' }, [run('a', 'failed', '')])?.stalled).toBe(true)
    expect(chainWait({ afterRunId: 'a' }, [run('a', 'failed', '', { autoResumeAt: '2099-01-01T00:00:00Z' })])?.stalled).toBe(false)
    expect(chainWait({ afterRunId: 'a' }, [run('a', 'cancelled', '')])?.stalled).toBe(true)
  })
  it('is nothing once the predecessor is finished or gone, or when none is named', () => {
    expect(chainWait({ afterRunId: 'a' }, [run('a', 'review', '')])).toBeUndefined()
    expect(chainWait({ afterRunId: 'a' }, [])).toBeUndefined()
    expect(chainWait({}, [run('a', 'running', '')])).toBeUndefined()
  })
})

describe('?after= deep link', () => {
  it('round-trips through the prefill href and stays absent when unset', () => {
    expect(newTaskPrefillHref({ after: 'r1' })).toBe('/new?after=r1')
    expect(parseNewTaskParams('?after=%20r1%20').after).toBe('r1')
    expect(parseNewTaskParams('?skill=x')).not.toHaveProperty('after')
  })
})
