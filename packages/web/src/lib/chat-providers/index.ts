import { telegramDescriptor } from './telegram'
import { slackDescriptor } from './slack'
import { discordDescriptor } from './discord'
import type { ChatProviderDescriptor } from './types'
export type { ChatProviderDescriptor, ChatCredentialField } from './types'
export { telegramDescriptor } from './telegram'
export const chatProviderDescriptors: readonly ChatProviderDescriptor[] = [slackDescriptor, discordDescriptor, telegramDescriptor]
