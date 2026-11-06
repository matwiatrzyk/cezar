import { useId, useState } from 'react'
import type { ExtensionForm } from '@open-mercato/cezar-api-client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'

type Field = ExtensionForm['fields'][number]
const selectStyle = 'h-9 w-full rounded-md border border-input bg-card px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50'

/** An empty optional field is omitted, never sent as 0, its first option or a blank secret over a saved one. */
function fieldValue(field: Field, raw: FormDataEntryValue | null, checked: boolean): unknown {
  if (field.type === 'boolean') return checked
  const text = raw === null ? '' : String(raw)
  if (text === '' && !field.required) return undefined
  return field.type === 'number' ? Number(text) : text
}

/** Only declared fields are rendered. Passwords are never prefilled by the host. */
export function ExtensionFormView({ form, submit }: { form: ExtensionForm; submit: (input: Record<string, unknown>) => Promise<unknown> }) {
  const id = useId()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [flags, setFlags] = useState<Record<string, boolean>>(() => Object.fromEntries(form.fields.filter(field => field.type === 'boolean').map(field => [field.key, form.values?.[field.key] === true])))
  return <form className="space-y-3 rounded border p-3" aria-label={form.title} onSubmit={async event => {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const input: Record<string, unknown> = {}
    for (const field of form.fields) {
      const value = fieldValue(field, data.get(field.key), flags[field.key] === true)
      if (value !== undefined) input[field.key] = value
    }
    setBusy(true); setError('')
    try { await submit(input) } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not save') } finally { setBusy(false) }
  }}>
    <h3>{form.title}</h3>
    {form.fields.map(field => {
      const fieldId = `${id}-${field.key}`
      if (field.type === 'boolean') return <div key={field.key} className="flex items-center gap-2">
        <Switch id={fieldId} checked={flags[field.key] === true} onCheckedChange={checked => setFlags(current => ({ ...current, [field.key]: checked }))} />
        <label htmlFor={fieldId}>{field.label}</label>
      </div>
      const saved = form.values?.[field.key]
      return <div key={field.key} className="flex flex-col gap-1">
        <label htmlFor={fieldId}>{field.label}</label>
        {field.type === 'select'
          ? <select id={fieldId} className={selectStyle} name={field.key} required={field.required} defaultValue={saved === undefined ? '' : String(saved)}>
            <option value="" disabled={field.required}>{field.required ? 'Choose…' : 'None'}</option>
            {field.options?.map(value => <option key={value} value={value}>{value}</option>)}
          </select>
          : <Input id={fieldId} name={field.key} required={field.required} type={field.type} aria-describedby={field.type === 'password' && !field.required ? `${fieldId}-hint` : undefined}
            defaultValue={field.type === 'password' || saved === undefined ? undefined : String(saved)} />}
        {field.type === 'password' && !field.required && <span id={`${fieldId}-hint`} className="text-ui text-muted-foreground">Leave blank to keep the saved value.</span>}
      </div>
    })}
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    <Button type="submit" disabled={busy}>Save {form.title}</Button>
  </form>
}
