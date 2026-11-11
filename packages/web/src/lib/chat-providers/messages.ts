import type { ChatProviderDescriptor } from './types'

/** One off-state copy for every chat provider: which env var, and that cezar must restart. */
export function chatUnavailableMessages(name: string): Readonly<Record<'flag_off' | 'webhooks_off' | 'hosted' | 'unavailable', string>> {
  return {
    flag_off: 'Task control needs CEZ_CHAT_INBOUND=1. Restart cezar with it to turn task control on.',
    webhooks_off: `${name} needs CEZ_WEBHOOKS=1. Restart cezar with it, then reload this page.`,
    hosted: `${name} is not available on a hosted cockpit. Run cezar locally to connect a bot.`,
    unavailable: `${name} is unavailable right now. Try again in a moment.`,
  }
}

export function chatErrorCode(providerId: string, cause: unknown): string {
  const code = (cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : '').toLowerCase()
  return code.startsWith(providerId) ? code.slice(providerId.length).replace(/^[_ -]/, '') : code
}

/** Only descriptor-owned copy may cross this boundary, never server prose or credentials. */
export function chatErrorMessage(provider: ChatProviderDescriptor, cause: unknown): string {
  const code = chatErrorCode(provider.id, cause)
  for (const messages of [provider.bot.settingsErrorMessages, provider.bot.setupErrorMessages]) {
    if (Object.hasOwn(messages, code)) return messages[code]!
  }
  return `${provider.name} could not complete that action. Refresh and try again.`
}
