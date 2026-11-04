import { HashIcon } from 'lucide-react'
import type { ChatProviderDescriptor } from '../types'
export const slackDescriptor: ChatProviderDescriptor = { id: 'slack', name: 'Slack', format: 'slack.v1', icon: HashIcon, description: 'Send task updates to your Slack channels.' }
