import type { ChatProviderDescriptor } from './types'

export function chatErrorCode(providerId: string, cause: unknown): string {
  const code = (cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : '').toLowerCase()
  return code.startsWith(providerId) ? code.slice(providerId.length).replace(/^[_ -]/, '') : code
}

/** Only descriptor-owned copy may cross this boundary, never server prose or credentials. */
export function chatErrorMessage(provider: ChatProviderDescriptor, cause: unknown): string {
  const code = chatErrorCode(provider.id, cause)
  for (const messages of [provider.bot?.settingsErrorMessages, provider.bot?.setupErrorMessages]) {
    if (messages && Object.hasOwn(messages, code)) return messages[code]!
  }
  return `${provider.name} could not complete that action. Refresh and try again.`
}
