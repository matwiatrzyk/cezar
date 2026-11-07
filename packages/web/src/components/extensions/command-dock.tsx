import { XIcon } from 'lucide-react'
import { useCallback, useState } from 'react'
import type { ExtensionPlacement, ExtensionPlacementCommand } from '@open-mercato/cezar-api-client'

import { qualifiedExtensionId, runExtensionCommand } from '@/api/extensions'
import { ExtensionCommandOutcome, useExtensionCommandResult } from '@/components/extensions/command-outcome'
import { Button } from '@/components/ui/button'

/** What the dock shows for the command the palette last ran. */
export type ExtensionCommandDockState =
  | { phase: 'running'; projectId: string; label: string }
  | { phase: 'failed'; projectId: string; label: string; error: string }
  | { phase: 'done'; projectId: string; label: string }

/**
 * Runs a palette command and keeps its progress and result after the palette has closed (spec
 * V1.1, "Command palette"): the dialog is gone the moment a row is picked, so the feedback needs
 * a home outside it — the same outcome component Settings and the other surfaces use.
 */
export function useExtensionCommandDock() {
  const [state, setState] = useState<ExtensionCommandDockState>()
  const { result, show, dismiss: dismissResult } = useExtensionCommandResult()
  const run = useCallback(
    async (projectId: string, extension: ExtensionPlacement, command: ExtensionPlacementCommand) => {
      const label = `${extension.name}: ${command.title}`
      dismissResult()
      setState({ phase: 'running', projectId, label })
      try {
        const outcome = await runExtensionCommand(projectId, extension.extensionId, command.id)
        show(qualifiedExtensionId(extension.extensionId, command.id), outcome)
        setState({ phase: 'done', projectId, label })
      } catch (error) {
        setState({ phase: 'failed', projectId, label, error: error instanceof Error ? error.message : 'Extension command failed' })
      }
    },
    [dismissResult, show],
  )
  const dismiss = useCallback(() => {
    setState(undefined)
    dismissResult()
  }, [dismissResult])
  return { state, result, run, dismiss }
}

export function ExtensionCommandDock({ state, result, onDismiss }: { state?: ExtensionCommandDockState; result: ReturnType<typeof useExtensionCommandResult>['result']; onDismiss: () => void }) {
  if (!state) return null
  return (
    <aside
      data-slot="extension-command-dock"
      data-phase={state.phase}
      aria-label="Extension command"
      className="fixed right-4 bottom-[max(env(safe-area-inset-bottom),1rem)] z-50 flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2 rounded-lg border border-border bg-popover p-3 text-sm text-popover-foreground shadow-lg"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate font-medium" title={state.label}>{state.label}</span>
        <Button variant="ghost" size="icon-xs" aria-label="Dismiss" onClick={onDismiss} className="-mr-1 text-muted-foreground hover:text-foreground">
          <XIcon aria-hidden="true" className="size-3.5" />
        </Button>
      </div>
      {state.phase === 'running' ? <p role="status" aria-live="polite" className="text-muted-foreground">Running…</p> : null}
      {state.phase === 'failed' ? <p role="alert" className="text-danger">{state.error}</p> : null}
      {state.phase === 'done' ? <ExtensionCommandOutcome projectId={state.projectId} result={result} onDismiss={onDismiss} /> : null}
    </aside>
  )
}
