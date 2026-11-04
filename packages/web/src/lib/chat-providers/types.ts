import type { telegramApi } from '@/api/client'
import type { ChatSetupApi } from '@/routes/settings/telegram-inbound'
import type { ChatSetupBegin } from '@open-mercato/cezar-api-client'
import type { LucideIcon } from 'lucide-react'
export interface ChatCredentialField { name: string; label: string; placeholder: string; pattern: RegExp; invalid: string }
export interface ChatProviderDescriptor {
 id: 'telegram' | 'slack' | 'discord'; name: string; format: 'telegram.v1' | 'slack.v1' | 'discord.v1'; icon: LucideIcon; description: string
 /** No transport is implied by a gallery tile. Slack and Discord remain webhook-only. */
 bot?: {
  api: typeof telegramApi; setupApi: ChatSetupApi
  subscribe(changed: () => void): () => void
  validChatId(id: string | undefined): boolean; isGroup(id: string | undefined): boolean
  fields: readonly ChatCredentialField[]
  /** Trusted operator guidance; raw server errors are never displayed. */
  setupErrorMessages: Readonly<Record<string, string>>
  settingsErrorMessages: Readonly<Record<string, string>>
  approval: {
   savedCredentials: string; checkingCredentials: string; waitingTitle: string
   waiting(username: string, group: boolean): string; candidate(username: string): string
   controlDescription: string; privateControl: string; groupControl: string; controlHint: string; comparisonHint: string
  }
  unavailableMessages: Readonly<Record<string, string>>
  credentialHelp: { create: string; add: string; storage: string }
  groupRestriction: string
  credentialHint: string; help: { label: string; href: string }
  discoveryHint: string; privateHint: string; groupHint: string
  groupLink(link: string): string | undefined
  begin(credentials: Readonly<Record<string, string>>, name: string): ChatSetupBegin
 }
}
