import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { commitInstallExtension, getExtensions, prepareInstallExtension, setExtensionEnabled, uninstallExtension } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export function ExtensionsSection() {
  const queryClient = useQueryClient(); const [source, setSource] = useState('')
  const extensions = useQuery({ queryKey: ['extensions'], queryFn: getExtensions })
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof prepareInstallExtension>>>()
  const [remove, setRemove] = useState<string>()
  const install = useMutation({ mutationFn: prepareInstallExtension, onSuccess: value => setPreview(value) })
  const commit = useMutation({ mutationFn: commitInstallExtension, onSuccess: () => { setSource(''); setPreview(undefined); void queryClient.invalidateQueries({ queryKey: ['extensions'] }) } })
  const toggle = useMutation({ mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => setExtensionEnabled(id, enabled), onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['extensions'] }) })
  const removeMutation = useMutation({ mutationFn: uninstallExtension, onSuccess: () => { setRemove(undefined); void queryClient.invalidateQueries({ queryKey: ['extensions'] }) } })
  return <div data-slot="extensions-settings-section" className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-4 md:p-6">
    <div><h2 className="text-sm font-semibold">Project extensions</h2><p className="text-ui text-muted-foreground">Install a local folder or an already-installed npm package. Extensions run trusted code in an isolated worker.</p></div>
    <form className="flex gap-2" onSubmit={event => { event.preventDefault(); if (source.trim()) install.mutate(source.trim()) }}><Input aria-label="Extension folder or package" value={source} onChange={event => setSource(event.target.value)} placeholder="./extensions/example" /><Button type="submit" disabled={install.isPending || !source.trim()}>Preview install</Button></form>
    {install.isError ? <p role="alert">{install.error.message} <Button type="button" variant="ghost" onClick={() => install.reset()}>Retry</Button></p> : null}
    {preview ? <div role="dialog" aria-label="Review extension install" className="rounded border border-border p-3"><p className="font-medium">Install {preview.manifest.name} {preview.manifest.version}?</p><p className="text-sm text-muted-foreground">This preview does not activate the extension.</p>{preview.addedPermissions.length ? <p className="text-sm">Requested access: {preview.addedPermissions.join(', ')}</p> : null}<div className="mt-3 flex gap-2"><Button type="button" onClick={() => commit.mutate(preview.preparedId)} disabled={commit.isPending}>Install paused</Button><Button type="button" variant="outline" onClick={() => setPreview(undefined)}>Cancel</Button></div></div> : null}
    {extensions.isPending ? <p>Loading extensions…</p> : extensions.isError ? <p role="alert">{extensions.error.message} <Button type="button" variant="ghost" onClick={() => void extensions.refetch()}>Retry</Button></p> : <ul className="flex flex-col gap-2">{extensions.data.extensions.map(extension => <li key={extension.manifest.id} className="flex items-center justify-between rounded border border-border px-3 py-2"><span>{extension.manifest.name} <small className="text-muted-foreground">{extension.manifest.version}</small></span><span className="flex gap-2"><Button type="button" variant="ghost" onClick={() => toggle.mutate({ id: extension.manifest.id, enabled: !extension.enabled })}>{extension.enabled ? 'Disable' : 'Enable'}</Button><Button type="button" variant="ghost" onClick={() => setRemove(extension.manifest.id)}>Uninstall</Button></span></li>)}</ul>}
    {remove ? <div role="alertdialog" className="rounded border border-warning/50 p-3 text-sm">Uninstall this extension? Its project data is preserved by default.<div className="mt-2 flex gap-2"><Button type="button" variant="danger-ghost" onClick={() => removeMutation.mutate(remove)} disabled={removeMutation.isPending}>Uninstall</Button><Button type="button" variant="outline" onClick={() => setRemove(undefined)}>Cancel</Button></div></div> : null}
  </div>
}
