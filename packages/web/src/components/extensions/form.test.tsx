import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ExtensionFormView } from './form'
// The Radix Switch measures its thumb with a ResizeObserver, which jsdom lacks.
beforeEach(() => vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }))
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
it('submits typed declared values, never prefills passwords, and displays save errors', async () => {
  const submit = vi.fn().mockRejectedValue(new Error('Worker stopped'))
  render(<ExtensionFormView submit={submit} form={{ id: 'settings', title: 'Preferences', commandId: 'save', fields: [
    { key: 'name', label: 'Name', type: 'text', required: true },
    { key: 'limit', label: 'Limit', type: 'number', required: true },
    { key: 'active', label: 'Active', type: 'boolean', required: false },
    { key: 'token', label: 'Token', type: 'password', required: false },
  ], values: { name: 'Example', limit: 5, active: true, token: 'must-not-appear' } }} />)
  expect((screen.getByLabelText('Token') as HTMLInputElement).value).toBe('')
  fireEvent.change(screen.getByLabelText('Token'), { target: { value: 'new-token' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save Preferences' }))
  await waitFor(() => expect(submit).toHaveBeenCalledWith({ name: 'Example', limit: 5, active: true, token: 'new-token' }))
  const alert = await screen.findByRole('alert')
  expect(alert.textContent).toBe('Worker stopped')
  expect(alert.className).toContain('text-danger')
})

it('renders a boolean as a switch labelled inline, not a full-width text input', async () => {
  const submit = vi.fn().mockResolvedValue(undefined)
  render(<ExtensionFormView submit={submit} form={{ id: 'f', title: 'Flags', commandId: 'save', fields: [{ key: 'active', label: 'Active', type: 'boolean', required: false }], values: { active: false } }} />)
  const toggle = screen.getByRole('switch', { name: 'Active' })
  expect(toggle.getAttribute('aria-checked')).toBe('false')
  fireEvent.click(toggle)
  fireEvent.click(screen.getByRole('button', { name: 'Save Flags' }))
  await waitFor(() => expect(submit).toHaveBeenCalledWith({ active: true }))
})

it('omits empty optional number, select and password fields instead of sending 0, the first option or a blank secret', async () => {
  const submit = vi.fn().mockResolvedValue(undefined)
  render(<ExtensionFormView submit={submit} form={{ id: 'f', title: 'Optional', commandId: 'save', fields: [
    { key: 'limit', label: 'Limit', type: 'number', required: false },
    { key: 'mode', label: 'Mode', type: 'select', required: false, options: ['fast', 'slow'] },
    { key: 'token', label: 'Token', type: 'password', required: false },
  ] }} />)
  expect((screen.getByLabelText('Mode') as HTMLSelectElement).value).toBe('')
  expect(screen.getByText(/leave blank to keep/i)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Save Optional' }))
  await waitFor(() => expect(submit).toHaveBeenCalledWith({}))
})

it('keeps a saved select choice and a saved number', async () => {
  const submit = vi.fn().mockResolvedValue(undefined)
  render(<ExtensionFormView submit={submit} form={{ id: 'f', title: 'Saved', commandId: 'save', fields: [
    { key: 'limit', label: 'Limit', type: 'number', required: false },
    { key: 'mode', label: 'Mode', type: 'select', required: false, options: ['fast', 'slow'] },
  ], values: { limit: 0, mode: 'slow' } }} />)
  fireEvent.click(screen.getByRole('button', { name: 'Save Saved' }))
  await waitFor(() => expect(submit).toHaveBeenCalledWith({ limit: 0, mode: 'slow' }))
})
