import { HashIcon } from 'lucide-react'
import type { ChatProviderDescriptor } from '../types'
type Bot = NonNullable<ChatProviderDescriptor['bot']>
/** Root supplies the typed route facade after mounting Slack's shared route family. */
export function createSlackDescriptor(bindings: Pick<Bot, 'api' | 'setupApi' | 'subscribe'>): ChatProviderDescriptor & { bot: Bot } {
 return { ...slackDescriptor, description: 'Send updates and answer tasks from Slack.', bot: {
  ...bindings,
  // Copy only text; Slack's composer picker must supply the native bot mention.
  discoveryCommand: link => slackDiscoveryCommand(link),
  fields: [
   { name: 'appToken', label: 'App-level token', placeholder: 'xapp-…', pattern: /^xapp-[A-Za-z0-9-]{10,2000}$/, invalid: 'Paste the app-level token with connections:write.' },
   { name: 'botToken', label: 'Bot token', placeholder: 'xoxb-…', pattern: /^xoxb-[A-Za-z0-9-]{10,2000}$/, invalid: 'Paste the installed app’s bot token.' },
  ],
  validChatId: id => /^(private|group):T[A-Z0-9]+:U[A-Z0-9]+:[CDG][A-Z0-9]+$/.test(id ?? ''),
  isGroup: id => id?.startsWith('group:') === true,
  begin: (credentials, name) => ({ token: JSON.stringify({ appToken: credentials.appToken, botToken: credentials.botToken }), name, dedicatedBot: true }),
  credentialHelp: { create: 'Create a Slack app with Socket Mode in', add: 'Use both tokens from the same installed Slack app.', storage: 'Both tokens are saved only in this project’s secret store.' },
  credentialHint: 'Continue checks both tokens with Slack and starts setup. Nothing is sent to your chats until you activate notifications.',
  help: { label: 'Slack app settings', href: 'https://api.slack.com/apps' },
  commands: { respond: 'cezar tasks, cezar status and cezar reply', reply: 'cezar reply', cancel: 'cezar cancel', continue: 'cezar continue', guidance: 'In a direct message, send the command to the bot. In channels and group DMs, select the installed bot from Slack’s @ picker, then type the command after the mention.' },
  groupRestriction: 'Invite the bot to the channel. All channel and group-DM members can see project messages.',
  discoveryHint: 'Send the setup command from the chat that should get notifications: your direct message with the app, or a channel. In a channel, select the installed bot from Slack’s @ picker, then paste the command after the mention.',
  privateLabel: 'Open the app in Slack', groupLabel: 'Use a channel instead',
  privateHint: 'Open the app’s Messages tab and paste the command. If Messages is missing, enable the writable Messages tab in App Home in Slack app settings.',
  groupHint: 'Invite the bot to the channel, select it from Slack’s @ picker, then paste the same command after the mention and send.',
  groupLink: () => undefined,
  approval: {
   savedCredentials: 'Cezar checks the saved Slack tokens and creates a setup code valid for five minutes.', checkingCredentials: 'Checking Slack credentials…', waitingTitle: 'Send the setup command in Slack',
   waiting: (_username, group) => group ? 'The person to approve sends the displayed cezar start command in their own DM with the bot.' : 'Send the displayed cezar start command in your DM with the bot.',
   candidate: () => 'sent the setup command in Slack.', controlDescription: 'The trusted person sends the private setup command to request task control.',
   privateControl: 'Approve the person who sent the setup command.', groupControl: 'Task control requires a second private setup command and code comparison.', controlHint: 'Send the private setup command to request approval.', comparisonHint: 'Compare the code received privately in Slack.',
  },
  unavailableMessages: { hosted: 'Slack task control requires a local cockpit.', flag_off: 'Task control needs CEZ_CHAT_INBOUND=1. Restart cezar with it to enable task control.', webhooks_off: 'Enable webhooks in this cockpit.', unavailable: 'Slack is temporarily unavailable.' },
  setupErrorMessages: { invalid_token: 'Slack rejected the credentials. Check both tokens belong to the same installed app.', blocked: 'Check the app’s scopes, Socket Mode and channel membership.', comparison_required: 'Compare the code received in your private Slack conversation.', group_visibility_required: 'Confirm that group members may see project messages.',
   bot_conflict: 'This Slack app is connected to another project or cezar. Use a different app, or disconnect it there first.', pairing_limit: 'Too many Slack setups are open. Finish or cancel one, or wait five minutes, then try again.',
   chat_limit: 'This Slack app already serves 20 chats. Remove a chat before adding another.', receiver_changed: 'This Slack receiver changed. Refresh it and try again.', receiver_missing: 'This Slack receiver no longer exists. Refresh the page.' },
  settingsErrorMessages: { credentials_unavailable: 'The saved Slack tokens are unavailable or changed. Reconnect the bot.', owner_conflict: 'Another cockpit owns this Slack bot.', revision_conflict: 'Settings changed. Refresh and try again.' },
 } }
}
export const slackDiscoveryCommand = (link: string): string => `cezar start ${new URL(link).searchParams.get('cezar_start') ?? ''}`
export const slackDescriptor: ChatProviderDescriptor = { id: 'slack', name: 'Slack', format: 'slack.v1', icon: HashIcon, description: 'Send task updates to your Slack channels.' }
