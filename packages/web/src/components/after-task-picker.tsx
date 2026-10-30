import { useState } from 'react'
import type { ApiRun } from '@open-mercato/cezar-api-client'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

/** The composer's "start after another task" choice; `runId` absent while the user is still picking. */
export type AfterChoice = { runId?: string; title?: string }

const UNFINISHED: ReadonlySet<ApiRun['status']> = new Set(['queued', 'running', 'waiting'])
const LIMIT = 8

export const runTitle = (run: Pick<ApiRun, 'title' | 'titleSummary'>) => run.titleSummary ?? run.title

/**
 * The predecessor candidates for a query: unarchived runs, unfinished ones first, newest first.
 * An empty query lists the most recent few — a project may hold hundreds of tasks, so the list is
 * a search, never a full select.
 */
export function afterCandidates(runs: readonly ApiRun[], query: string, limit = LIMIT): ApiRun[] {
  const q = query.trim().toLowerCase()
  return runs
    .filter((run) => !run.archived)
    .filter((run) => !q || runTitle(run).toLowerCase().includes(q) || run.id.startsWith(q))
    .sort((a, b) => Number(UNFINISHED.has(b.status)) - Number(UNFINISHED.has(a.status)) || b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit)
}

export function AfterTaskSearch({ runs, value, onPick }: {
  runs: readonly ApiRun[] | undefined
  value: AfterChoice
  onPick: (run: ApiRun) => void
}) {
  const [query, setQuery] = useState('')
  const matches = afterCandidates(runs ?? [], query)
  return <div className="space-y-2" data-slot="after-task-search">
    <Input aria-label="Find the task to start after" placeholder="Search tasks by title or id…" value={query} onChange={(e) => setQuery(e.target.value)} autoFocus />
    {runs === undefined ? <p role="status" className="text-sm text-muted-foreground">Loading tasks…</p>
      : matches.length === 0 ? <p role="status" className="text-sm text-muted-foreground">No matching task.</p>
        : <ul role="listbox" aria-label="Tasks" className="max-h-56 space-y-0.5 overflow-y-auto">
          {matches.map((run) => <li key={run.id}>
            <button type="button" role="option" aria-selected={value.runId === run.id} onClick={() => onPick(run)}
              className={cn('flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-muted', value.runId === run.id && 'bg-muted')}>
              <span className="min-w-0 flex-1 truncate">{runTitle(run)}</span>
              <span className="shrink-0 text-xs text-muted-foreground">{run.status} · {run.id.slice(0, 8)}</span>
            </button>
          </li>)}
        </ul>}
    <p className="text-sm text-muted-foreground">Starts once that task reaches review or done, in its own worktree from the usual base branch. Slot limits still apply.</p>
  </div>
}
