import { MessagesSquareIcon } from 'lucide-react'
import type { ChatProviderDescriptor } from '../types'
type Bot = NonNullable<ChatProviderDescriptor['bot']>
export const discordDescriptor: ChatProviderDescriptor = { id: 'discord', name: 'Discord', format: 'discord.v1', icon: MessagesSquareIcon, description: 'Send task updates to your Discord channels.' }
export function discordDiscoveryCommand(link: string, group = false): string | undefined {
 try { const url = new URL(link), bot = url.pathname === '/oauth2/authorize' ? url.searchParams.get('client_id') : url.pathname.split('/').at(-1), code = new URLSearchParams(url.hash.slice(1)).get('cezar-start');
  if (url.origin !== 'https://discord.com' || !bot || !/^[1-9][0-9]{0,19}$/.test(bot) || !code || !/^[A-Za-z0-9_-]{1,128}$/.test(code)) return;
  return `${group ? `<@${bot}> ` : ''}/start ${code}`;
 } catch { return undefined }
}
/** The root supplies its typed route facade once Discord routes have been registered. */
export function createDiscordDescriptor(ports: Pick<Bot, 'api' | 'setupApi' | 'subscribe'>): ChatProviderDescriptor & { bot: Bot } {
 const unavailableMessages = { flag_off: 'Task control needs CEZ_CHAT_INBOUND=1.', webhooks_off: 'Discord needs CEZ_WEBHOOKS=1.', hosted: 'Connect Discord from a local cockpit.', unavailable: 'Discord is temporarily unavailable.' }
 return { ...discordDescriptor, bot: {
  discoveryCommand: discordDiscoveryCommand,
  ...ports, unavailableMessages,
  validChatId: id => /^discord:(?:dm:[1-9][0-9]{0,19}|guild:[1-9][0-9]{0,19}:[1-9][0-9]{0,19})$/.test(id ?? ''), isGroup: id => id?.startsWith('discord:guild:') === true,
  fields: [{ name: 'token', label: 'Bot token', placeholder: 'Bot token from the developer portal', pattern: /^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}$/, invalid: 'Copy the bot token from Discord Developer Portal → Bot.' }],
  setupErrorMessages: { ...unavailableMessages, invalid_token: 'Discord rejected this bot token.', blocked: 'Check Message Content intent, bot permissions, and that Interactions Endpoint URL is empty.', group_ineligible: 'Choose a guild text channel. Threads and group DMs are not supported.', candidate_not_group_member: 'This person must be able to view the channel.', comparison_required: 'Compare the private code before approving.', pairing_expired: 'The setup code expired. Start again.',
   bot_conflict: 'This Discord bot is connected to another project or cezar. Use a different bot, or disconnect it there first.', pairing_limit: 'Too many Discord setups are open. Finish or cancel one, or wait five minutes, then try again.',
   chat_limit: 'This Discord bot already serves 20 chats. Remove a chat before adding another.', receiver_changed: 'This Discord receiver changed. Refresh it and try again.', receiver_missing: 'This Discord receiver no longer exists. Refresh the page.' },
  settingsErrorMessages: { ...unavailableMessages, credentials_unavailable: 'Reconnect using the current bot token.', owner_conflict: 'Another cockpit owns this bot.', revision_conflict: 'Refresh the settings and try again.' },
  credentialHelp: { create: 'Create a dedicated bot in', add: 'Paste the token for the bot connected to this project.', storage: 'Saved only in this project’s encrypted secret store.' },
  credentialHint: 'Continue contacts Discord and opens Gateway for setup. Enable Message Content intent. Leave Interactions Endpoint URL empty. Project notifications and task control require activation.',
  help: { label: 'Discord Developer Portal', href: 'https://discord.com/developers/applications' },
  commands: { respond: '/tasks, /status and /reply', reply: '/reply', cancel: '/cancel', continue: '/continue', guidance: 'In a direct message, send the command as a text message to the bot. In a guild text channel, select the bot from Discord’s @ picker, then type the command after the mention and send it as a text message.' },
  groupRestriction: 'Guild text channels only; threads and group DMs are not supported.',
  discoveryHint: 'First invite the bot to a server you belong to using the invitation below. Then open the bot from that server’s member list → Message, and send the private setup command as text.', privateHint: 'If Discord refuses the message, allow direct messages in your shared server’s privacy settings. You can also use the channel command instead.', groupHint: 'Invite the bot to your server, then paste the command with its mention in a text channel.',
  groupLink: link => { try { const source = new URL(link); const id = source.pathname.split('/').at(-1); if (!id || !/^[1-9][0-9]{0,19}$/.test(id)) return; return `https://discord.com/oauth2/authorize?client_id=${id}&scope=bot&permissions=68608${source.hash}`; } catch { return undefined } },
  approval: { savedCredentials: 'Cezar checks the saved bot token and creates a five-minute setup code.', checkingCredentials: 'Checking the saved bot token…', waitingTitle: 'Send the setup command in Discord', waiting: (_id, group) => group ? 'The trusted person sends the command in a private message to the bot.' : 'Send the setup command in a private message to the bot.', candidate: () => 'sent the setup command.', controlDescription: 'Approve a trusted person through a private setup command.', privateControl: 'The person who sends the setup command is approved.', groupControl: 'Task control requires a second private setup command and code comparison.', controlHint: 'Send the private setup command, then compare the code.', comparisonHint: 'Compare the private code before approving.' },
  begin: (credentials, name) => ({ token: credentials.token!, name, dedicatedBot: true }),
 } };
}
