import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ExtensionFormView } from './form'
afterEach(cleanup)
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
  expect((await screen.findByRole('alert')).textContent).toBe('Worker stopped')
})
