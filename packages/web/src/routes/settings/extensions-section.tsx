import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { getExtensions, installExtension, setExtensionEnabled } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export function ExtensionsSection() {
  const queryClient = useQueryClient(); const [source, setSource] = useState('')
  const extensions = useQuery({ queryKey: ['extensions'], queryFn: getExtensions })
  const install = useMutation({ mutationFn: installExtension, onSuccess: () => { setSource(''); void queryClient.invalidateQueries({ queryKey: ['extensions'] }) } })
  const toggle = useMutation({ mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => setExtensionEnabled(id, enabled), onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['extensions'] }) })
  return <div data-slot="extensions-settings-section" className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-4 md:p-6">
    <div><h2 className="text-sm font-semibold">Project extensions</h2><p className="text-ui text-muted-foreground">Install a local folder or an already-installed npm package. Extensions run trusted code in an isolated worker.</p></div>
    <form className="flex gap-2" onSubmit={event => { event.preventDefault(); if (source.trim()) install.mutate(source.trim()) }}><Input aria-label="Extension folder or package" value={source} onChange={event => setSource(event.target.value)} placeholder="./extensions/example" /><Button type="submit" disabled={install.isPending || !source.trim()}>Install</Button></form>
    {extensions.isPending ? <p>Loading extensions…</p> : extensions.isError ? <p role="alert">{extensions.error.message}</p> : <ul className="flex flex-col gap-2">{extensions.data.extensions.map(extension => <li key={extension.manifest.id} className="flex items-center justify-between rounded border border-border px-3 py-2"><span>{extension.manifest.name} <small className="text-muted-foreground">{extension.manifest.version}</small></span><Button type="button" variant="ghost" onClick={() => toggle.mutate({ id: extension.manifest.id, enabled: !extension.enabled })}>{extension.enabled ? 'Disable' : 'Enable'}</Button></li>)}</ul>}
  </div>
}
