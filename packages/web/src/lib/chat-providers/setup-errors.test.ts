import { expect, it } from 'vitest'
import { telegramDescriptor } from './telegram'
import { createSlackDescriptor } from './slack'
import { createDiscordDescriptor } from './discord'
import { chatErrorMessage } from './messages'
import type { ChatProviderDescriptor } from './types'
const ports = { api: {}, setupApi: {}, subscribe: () => () => {} } as unknown as Pick<NonNullable<ChatProviderDescriptor['bot']>, 'api' | 'setupApi' | 'subscribe'>
const providers = [telegramDescriptor, createSlackDescriptor(ports), createDiscordDescriptor(ports)]
const sharedSetupCodes = ['bot_conflict', 'pairing_limit', 'chat_limit']
const upgradeCodes = ['receiver_changed', 'receiver_missing']

it.each(providers.map(provider => [provider.name, provider] as const))('gives %s its own copy for every shared setup failure', (_name, provider) => {
  const codes = provider.id === 'telegram' ? sharedSetupCodes : [...sharedSetupCodes, ...upgradeCodes]
  for (const code of codes) {
    expect(provider.bot!.setupErrorMessages[code], code).toBeTruthy()
  }
  // A settings action (Approve another member) can hit the limit too.
  expect(chatErrorMessage(provider, new Error(`${provider.id}_chat_limit`))).toBe(provider.bot!.setupErrorMessages.chat_limit)
  expect(provider.bot!.setupErrorMessages.chat_limit).toMatch(/20 chats/)
})

it('names the task-control flag in every provider’s flag_off copy', () => {
  for (const provider of providers) expect(provider.bot!.unavailableMessages.flag_off).toContain('CEZ_CHAT_INBOUND=1')
})
