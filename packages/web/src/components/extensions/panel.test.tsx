import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ExtensionPanelView } from './panel'

const panel = {
  id: 'summary', title: 'Summary', text: '<script>not html</script>',
  blocks: [{ type: 'status' as const, label: 'Done', value: '2' }],
  actions: [{ id: 'refresh', label: 'Refresh' }],
}

describe('ExtensionPanelView', () => {
  it('renders declarative content as text and invokes declared actions', async () => {
    const action = vi.fn().mockResolvedValue(undefined)
    render(<ExtensionPanelView panel={panel} onAction={action} />)
    expect(screen.getByText('<script>not html</script>')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(action).toHaveBeenCalledWith('refresh'))
    expect(document.querySelector('script')).toBeNull()
  })
})
