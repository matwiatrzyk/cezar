import { subscribeTopic } from '@/api/ws'
import { MessagesSquareIcon } from 'lucide-react'
import type { ExtensionChatProvider } from '@open-mercato/cezar-api-client'
import { createExtensionChatApi } from '@/api/client'
import { telegramDescriptor } from './telegram'
import type { ChatProviderDescriptor } from './types'
import { chatUnavailableMessages } from './messages'

/** Uses the existing chat setup/approval components with an extension-owned typed API. */
export function extensionChatDescriptor(extensionId: string, declaration: ExtensionChatProvider): ChatProviderDescriptor {
  const api = createExtensionChatApi(extensionId, declaration.id)
  const name = declaration.label
  const messages = (values: Readonly<Record<string, string>>) => Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value.replaceAll('Telegram', name)]))
  return {
    id: `${extensionId}/${declaration.id}`, name, format: `${extensionId}/${declaration.id}.v1`, icon: MessagesSquareIcon,
    description: `Send project updates and control tasks through ${name}.`,
    bot: {
      ...telegramDescriptor.bot, api, setupApi: api.setup,
      // Setup status uses the existing bounded setup query. Snapshot views refresh on focus.
      subscribe: changed => subscribeTopic('extensions-inbound', () => changed()),
      validChatId: value => /^[A-Za-z0-9_.:@-]{1,128}$/.test(value ?? ''),
      isGroup: value => value?.startsWith(declaration.groupPrefix) === true,
      fields: declaration.credentials.map(field => ({ ...field, placeholder: field.label, pattern: /.+/, invalid: `Enter ${field.label}.` })),
      setupErrorMessages: messages(telegramDescriptor.bot.setupErrorMessages),
      settingsErrorMessages: messages(telegramDescriptor.bot.settingsErrorMessages),
      unavailableMessages: chatUnavailableMessages(name),
      credentialHelp: { create: 'Create credentials at', add: 'Use this provider’s credentials.', storage: 'Credentials are encrypted for this project.' },
      credentialHint: `Continue verifies credentials with ${name}.`,
      help: { label: name, href: declaration.discoveryUrl },
      groupRestriction: 'The provider must verify group membership.',
      approval: {
        savedCredentials: 'Verify saved credentials and create a one-time setup link.', checkingCredentials: 'Checking credentials…',
        waitingTitle: `Open ${name} and connect`, waiting: () => 'Open the private setup link and send the start command.',
        candidate: username => `connected as ${username}.`,
        controlDescription: 'Approve the person who may control project tasks.', privateControl: 'Approve this person to control tasks.',
        groupControl: 'Compare the private verification code before granting group access.', controlHint: 'Open the private setup link.',
        comparisonHint: 'Compare the code in your private chat.',
      },
      discoveryHint: 'Choose a private or group destination.', privateHint: 'Open the link and send the start command.',
      groupHint: 'Open the link in the destination group.', groupLink: link => link,
      discoveryCommand: link => `${declaration.commandPrefix}start ${new URL(link).searchParams.get('cezar_start') ?? ''}`,
      begin: (credentials, name) => ({ token: JSON.stringify(credentials), name, dedicatedBot: true }),
    },
  }
}
