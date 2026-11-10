import { useEffect, useRef, useState } from 'react'
import type { ExtensionChatSelectionInput, ExtensionChatSelectionPreview, ExtensionInventoryItem } from '@open-mercato/cezar-api-client'
import { previewChatSelection, selectChatImplementation } from '@/api/extensions'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'

type Provider = ExtensionChatSelectionPreview['provider']
const canonical = (id: string): id is Provider => id === 'telegram' || id === 'slack' || id === 'discord'

/** Canonical identities come from inventory, never package names or paths.
 * The server preview alone authorizes the proposed local provider mapping. */
export function ChatSelection({ item, projectId, projectName, off, refresh }: {
  item: ExtensionInventoryItem; projectId: string; projectName: string; off?: string; refresh: () => Promise<unknown>
}) {
  const [request, setRequest] = useState<{ provider: Provider; input: ExtensionChatSelectionInput }>()
  const trigger = useRef<HTMLButtonElement | null>(null)
  const candidate = item.installedCandidate
  return <>
    {item.providers.filter(provider => canonical(provider.id)).map(provider => {
      const id = provider.id as Provider
      // Only an unambiguous manifest contribution can be proposed. This is not a trust decision.
      const locals = candidate?.record.manifest.contributes?.chatProviders ?? []
      const local = locals.find(local => local.id === id) ?? (locals.length === 1 ? locals[0] : undefined)
      const open = (button: HTMLButtonElement, target: ExtensionChatSelectionInput['target']) => {
        trigger.current = button
        setRequest({ provider: id, input: { target, enabled: item.record.enabled } })
      }
      return <div key={id} className="flex flex-wrap gap-2">
        {candidate?.record.integrity && local && !off && <Button variant="outline" onClick={event => open(event.currentTarget, { kind: 'installed', extensionId: candidate.record.manifest.id, localProviderId: local.id, integrity: candidate.record.integrity! })}>Use installed version</Button>}
        {item.provenance.kind !== 'bundled' && off !== 'hosted' && <Button variant="outline" onClick={event => open(event.currentTarget, { kind: 'shipped' })}>Return to version shipped with Cezar</Button>}
      </div>
    })}
    {request && <SelectionDialog {...request} projectId={projectId} projectName={projectName} onClose={() => setRequest(undefined)} onFocus={() => trigger.current?.focus()} refresh={refresh} />}
  </>
}

function SelectionDialog({ provider, input, projectId, projectName, onClose, onFocus, refresh }: {
  provider: Provider; input: ExtensionChatSelectionInput; projectId: string; projectName: string;
  onClose: () => void; onFocus: () => void; refresh: () => Promise<unknown>
}) {
  const [preview, setPreview] = useState<ExtensionChatSelectionPreview>()
  const [error, setError] = useState<string>()
  const [generation, setGeneration] = useState(0)
  const [loading, setLoading] = useState(true)
  const [pending, setPending] = useState(false)
  const submitting = useRef(false)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setPreview(undefined); setError(undefined)
    void previewChatSelection(projectId, provider, input, controller.signal).then(value => {
      if (controller.signal.aborted) return
      if (input.enabled && !value.current?.enabled) throw new Error('Project access changed. Close this review and refresh the inventory.')
      setPreview(value)
    }).catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Selection preview failed') })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [projectId, provider, input, generation])
  const confirm = async () => {
    if (!preview || submitting.current || loading) return
    submitting.current = true; setPending(true); setError(undefined)
    try {
      await selectChatImplementation(projectId, provider, { target: preview.target, enabled: preview.enabled, revision: preview.revision })
      if (alive.current) onClose()
      await refresh()
    } catch (reason) {
      if (alive.current) {
        setPreview(undefined)
        setError(reason instanceof Error ? reason.message : 'Selection failed')
      }
    } finally { submitting.current = false; if (alive.current) setPending(false) }
  }
  return <Dialog open onOpenChange={open => { if (!open && !submitting.current) onClose() }}>
    <DialogContent onCloseAutoFocus={event => { event.preventDefault(); onFocus() }} className="max-h-[calc(100dvh-2rem)] grid-rows-[minmax(0,1fr)_auto] overflow-hidden">
      <div role="region" aria-label="Implementation selection review" tabIndex={0} className="min-h-0 space-y-4 overflow-y-auto [overflow-wrap:anywhere]">
        <DialogHeader><DialogTitle>Select {provider} implementation for {projectName}</DialogTitle><DialogDescription>Review the source and access for this project before confirming.</DialogDescription></DialogHeader>
        <p className="text-sm">Changing code preserves pairings. It does not restore old secrets, state snapshots, checkpoints or completed tasks.</p>
        <p className="text-sm">Project access after selection: {input.enabled ? 'Enabled' : 'Disabled (preserved)'}</p>
        {loading && <p role="status">Loading selection preview…</p>}
        {preview && <>
          <p>Current approval: {preview.current?.enabled ? 'Enabled' : 'Disabled'}</p>
          <p>Current source: {preview.current?.source ?? 'None'} · Version: {preview.current?.manifest.version ?? 'None'}</p>
          <p>Target: {preview.target.kind === 'shipped' ? 'Version shipped with Cezar' : 'Installed version'}</p>
          <p>Target source: {preview.candidate.source} · Version: {preview.candidate.manifest.version}</p>
          <p>Current permissions: {preview.current?.manifest.permissions.join(', ') || 'None'}</p>
          <p>Target permissions: {preview.candidate.manifest.permissions.join(', ') || 'None'}</p>
          <p>Added permissions: {preview.addedPermissions.join(', ') || 'None'}</p>
          <p>Current capabilities: {preview.current?.manifest.capabilities?.join(', ') || 'None'}</p>
          <p>Target capabilities: {preview.candidate.manifest.capabilities?.join(', ') || 'None'}</p>
          <p>Added capabilities: {preview.addedCapabilities.join(', ') || 'None'}</p>
          <p>Only approve code you trust. Extensions run locally as your user; worker isolation is not a security sandbox.</p>
        </>}
        {error && <p role="alert">{error}</p>}
        {!preview && !loading && <Button disabled={pending} onClick={() => setGeneration(value => value + 1)}>Review again</Button>}
      </div>
      <DialogFooter>
        <Button variant="outline" disabled={pending} onClick={onClose}>Cancel selection</Button>
        <Button disabled={!preview || loading || pending} onClick={() => void confirm()}>Confirm selection</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
}
