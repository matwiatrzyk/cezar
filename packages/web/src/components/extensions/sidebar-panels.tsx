import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronRightIcon } from 'lucide-react'
import { useCallback } from 'react'
import { Link } from 'react-router'
import type { ExtensionPlacement, WorkspaceUiState } from '@open-mercato/cezar-api-client'

import { putWorkspaceUiState } from '@/api/client'
import { extensionKeys, loadExtensionPanel, qualifiedExtensionId, runExtensionCommand, useExtensionPlacements, useExtensionSubscription } from '@/api/extensions'
import { useHealth, useWorkspaceUiState, workspaceQueryKeys } from '@/api/queries'
import { ExtensionCommandOutcome, useExtensionCommandResult, type ExtensionCommandOutcomeValue } from '@/components/extensions/command-outcome'
import { ExtensionPanelView } from '@/components/extensions/panel'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/ui/toaster'
import { cn } from '@/lib/utils'

/** Settings → Extensions is a GLOBAL section (`routes/settings/registry.tsx`). */
export const EXTENSIONS_SETTINGS_PATH = '/settings/global/extensions'

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}
/** Only boolean entries: a hand-edited value never becomes a truthy collapse. */
function asCollapsedMap(value: unknown): Record<string, boolean> {
  return Object.fromEntries(Object.entries(asRecord(value)).filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean'))
}

/** A section is shut unless the user opened it: a new panel never widens the sidebar on its own. */
export function isSidebarPanelCollapsed(state: WorkspaceUiState | undefined, key: string): boolean {
  return state?.sidebarExtensionPanels?.collapsed?.[key] ?? true
}

/**
 * Which sidebar sections are open — WORKSPACE ui-state (spec V1.1, "Project sidebar"), written
 * like `useProjectOrder`: optimistic cache first, then one shallow-merge PUT carrying the whole
 * `sidebarExtensionPanels` object so a key a newer cockpit wrote survives the write.
 */
export function useSidebarPanelCollapse() {
  const queryClient = useQueryClient()
  const uiState = useWorkspaceUiState()
  const toggle = useCallback(
    (key: string) => {
      const current = queryClient.getQueryData<WorkspaceUiState>(workspaceQueryKeys.uiState)
      // Until the authoritative GET lands a write could not preserve its siblings; the toggle waits.
      if (current === undefined) return
      const siblings = asRecord(current.sidebarExtensionPanels)
      const collapsed = { ...asCollapsedMap(siblings.collapsed), [key]: !isSidebarPanelCollapsed(current, key) }
      const sidebarExtensionPanels = { ...siblings, collapsed }
      queryClient.setQueryData<WorkspaceUiState>(workspaceQueryKeys.uiState, { ...current, sidebarExtensionPanels })
      putWorkspaceUiState({ sidebarExtensionPanels }).then(
        (merged) => queryClient.setQueryData<WorkspaceUiState>(workspaceQueryKeys.uiState, merged),
        (error: unknown) => {
          toast(error instanceof Error ? error.message : String(error), { tone: 'danger' })
          void queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.uiState })
        },
      )
    },
    [queryClient],
  )
  return { state: uiState.data, toggle }
}

/**
 * The `sidebar` panels of the project's enabled extensions, as collapsible sections under its
 * nav (spec 2026-11-07-extension-placements-v1.1). Renders NOTHING when extensions are off,
 * hosted, or no enabled extension contributes one — the sidebar of a cockpit without extensions
 * is byte-for-byte the sidebar it had before.
 */
export function SidebarExtensionPanels({ projectId }: { projectId: string }) {
  const allowed = useHealth().data?.capabilities?.extensions === true
  useExtensionSubscription(projectId)
  const placements = useExtensionPlacements(projectId, 'sidebar', allowed)
  const { state, toggle } = useSidebarPanelCollapse()
  const { result, show, dismiss } = useExtensionCommandResult()
  const extensions = allowed && placements.data?.available ? placements.data.extensions : []
  if (extensions.length === 0) return null
  return (
    <div data-slot="sidebar-extension-panels" className="flex flex-col gap-0.5 px-2.5 pb-2">
      {extensions.map((extension) =>
        extension.status === 'failed' ? (
          <FailedExtension key={extension.extensionId} extension={extension} />
        ) : (
          extension.panels.map((panel) => {
            const key = qualifiedExtensionId(extension.extensionId, panel.id)
            const collapsed = isSidebarPanelCollapsed(state, key)
            const bodyId = `sidebar-extension-panel-${key.replace(/[^A-Za-z0-9_-]/g, '-')}`
            return (
              <section key={key} data-slot="sidebar-extension-panel" data-extension-panel={key} data-collapsed={collapsed ? '' : undefined} aria-label={panel.title}>
                <button
                  type="button"
                  onClick={() => toggle(key)}
                  aria-expanded={!collapsed}
                  aria-controls={bodyId}
                  // Disabled until the ui-state cache exists: a write without it could drop siblings.
                  disabled={state === undefined}
                  title={`${extension.name} · ${key}`}
                  className="flex h-11 w-full items-center gap-2 rounded-md px-2.5 text-ui font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-60 md:h-[30px]"
                >
                  <ChevronRightIcon aria-hidden="true" className={cn('size-3.5 shrink-0 transition-transform', !collapsed && 'rotate-90')} />
                  <span className="min-w-0 flex-1 truncate text-left">{panel.title}</span>
                </button>
                {collapsed ? null : (
                  <div id={bodyId} className="mb-1 ml-[14px] border-l border-border pl-2 pr-1 text-sm">
                    <SidebarPanelBody projectId={projectId} extensionId={extension.extensionId} panelId={panel.id} onOutcome={(outcome) => show(key, outcome)} />
                    <ExtensionCommandOutcome projectId={projectId} result={result?.extensionId === key ? result : undefined} onDismiss={dismiss} />
                  </div>
                )}
              </section>
            )
          })
        ),
      )}
    </div>
  )
}

/** A stopped worker keeps its place: one line saying so, and the way to fix it (spec V1.1). */
function FailedExtension({ extension }: { extension: ExtensionPlacement }) {
  return (
    <section data-slot="sidebar-extension-failed" data-extension-id={extension.extensionId} aria-label={extension.name} className="flex flex-col gap-1 rounded-md border border-danger/40 bg-danger/5 px-2.5 py-2 text-xs">
      <p role="alert" className="truncate text-danger" title={extension.error}>
        <span className="font-medium">{extension.name}</span>: {extension.error ?? 'the extension stopped'}
      </p>
      <Link to={EXTENSIONS_SETTINGS_PATH} className="text-muted-foreground underline-offset-2 hover:underline">Open Settings → Extensions</Link>
    </section>
  )
}

function SidebarPanelBody({ projectId, extensionId, panelId, onOutcome }: { projectId: string; extensionId: string; panelId: string; onOutcome: (outcome: ExtensionCommandOutcomeValue) => void }) {
  const queryClient = useQueryClient()
  const panel = useQuery({ queryKey: extensionKeys.panel(projectId, extensionId, panelId), queryFn: () => loadExtensionPanel(projectId, extensionId, panelId) })
  if (panel.isPending) return <p role="status" className="py-1 text-xs text-muted-foreground">Loading panel…</p>
  if (panel.isError) {
    return (
      <div className="flex flex-col gap-1 py-1">
        <p role="alert" className="text-xs text-danger">{panel.error.message}</p>
        <Button size="sm" variant="outline" className="self-start" onClick={() => void panel.refetch()}>Retry panel</Button>
      </div>
    )
  }
  return (
    <ExtensionPanelView
      panel={panel.data}
      compact
      onAction={async (actionId) => {
        onOutcome(await runExtensionCommand(projectId, extensionId, actionId))
        await queryClient.invalidateQueries({ queryKey: extensionKeys.all(projectId) })
      }}
    />
  )
}
