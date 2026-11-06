import { useState } from 'react'
import type { ExtensionForm } from '@open-mercato/cezar-api-client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

/** Only declared fields are rendered. Passwords are never prefilled by the host. */
export function ExtensionFormView({ form, submit }: { form: ExtensionForm; submit: (input: Record<string, unknown>) => Promise<unknown> }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  return <form className="space-y-3 rounded border p-3" aria-label={form.title} onSubmit={async event => {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const input = Object.fromEntries(form.fields.map(field => [field.key, field.type === 'boolean' ? data.has(field.key) : field.type === 'number' ? Number(data.get(field.key)) : String(data.get(field.key) ?? '')]))
    setBusy(true); setError('')
    try { await submit(input) } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not save') } finally { setBusy(false) }
  }}>
    <h3>{form.title}</h3>
    {form.fields.map(field => <label key={field.key} className="block">{field.label}
      {field.type === 'select' ? <select name={field.key} required={field.required} defaultValue={String(form.values?.[field.key] ?? '')}>{field.options?.map(value => <option key={value}>{value}</option>)}</select>
        : <Input name={field.key} required={field.required} type={field.type === 'boolean' ? 'checkbox' : field.type} defaultChecked={field.type === 'boolean' && form.values?.[field.key] === true} defaultValue={field.type === 'password' || field.type === 'boolean' ? undefined : String(form.values?.[field.key] ?? '')} />}
    </label>)}
    {error && <p role="alert">{error}</p>}
    <Button type="submit" disabled={busy}>Save {form.title}</Button>
  </form>
}
