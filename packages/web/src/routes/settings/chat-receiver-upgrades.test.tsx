import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ChatReceiverUpgrades } from './chat-receiver-upgrades'
afterEach(cleanup)
const receivers = [{ id: 'hook', name: 'Existing notifications' }, { id: 'bot', name: 'Bot chat', chatId: 'private:TEAM:BOT:DM' }]
it('offers the existing webhook identity and server revision, excluding bot-connected chats', () => {
 const upgrade = vi.fn()
 render(<ChatReceiverUpgrades receivers={receivers} states={[{ receiverId: 'hook', inboundRevision: 'revision' }]} available onUpgrade={upgrade} />)
 fireEvent.click(screen.getByRole('button', { name: 'Add task control to Existing notifications' }))
 expect(upgrade).toHaveBeenCalledWith({ id: 'hook', name: 'Existing notifications', expectedRevision: 'revision' })
 expect(screen.queryByText('Bot chat')).toBeNull()
})
it.each([false, true])('never permits an upgrade without a current server revision (available=%s)', available => {
 render(<ChatReceiverUpgrades receivers={receivers} states={[]} available={available} onUpgrade={vi.fn()} />)
 expect(screen.getByRole('button')).toHaveProperty('disabled', true)
})
it('keeps upgrades disabled when task control is unavailable', () => {
 render(<ChatReceiverUpgrades receivers={receivers} states={[{ receiverId: 'hook', inboundRevision: 'revision' }]} available={false} onUpgrade={vi.fn()} />)
 expect(screen.getByRole('button')).toHaveProperty('disabled', true)
})
