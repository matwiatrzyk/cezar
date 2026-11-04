import { MessagesSquareIcon } from 'lucide-react'
import type { ChatProviderDescriptor } from '../types'
export const discordDescriptor: ChatProviderDescriptor = { id: 'discord', name: 'Discord', format: 'discord.v1', icon: MessagesSquareIcon, description: 'Send task updates to your Discord channels.' }
