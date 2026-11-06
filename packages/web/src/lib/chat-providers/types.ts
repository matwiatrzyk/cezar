import type { telegramApi } from '@/api/client'
import type { ChatSetupApi } from '@/routes/settings/telegram-inbound'
import type { ChatSetupBegin } from '@open-mercato/cezar-api-client'
import type { LucideIcon } from 'lucide-react'
export interface ChatCredentialField { name: string; label: string; placeholder: string; pattern: RegExp; invalid: string; hint?: string; visibleWhen?: (credentials: Readonly<Record<string, string>>) => boolean }
export interface ChatProviderDescriptor {
 id: string; name: string; format: string; icon: LucideIcon; description: string
 /** A bot capability is supplied only after its typed routes and transport are registered. */
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
  /** Actionable command syntax and addressing instructions for shared task-control UI. */
  commands: { respond: string; reply: string; cancel: string; continue: string; guidance: string }
  groupRestriction: string
  credentialHint: string; help: { label: string; href: string }
  discoveryHint: string; privateHint: string; groupHint: string
  /** Link labels for the connect step; Discord lists its server invitation before the private chat. */
  privateLabel?: string; groupLabel?: string; groupFirst?: boolean
  /** Platforms without a start-payload link require a visible command to paste. */
  discoveryCommand?(link: string, group?: boolean): string | undefined
  groupLink(link: string): string | undefined
  begin(credentials: Readonly<Record<string, string>>, name: string): ChatSetupBegin
 }
}
