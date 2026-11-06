import { cez, telegramApi, unwrap } from '@/api/client'
import { subscribeTopic } from '@/api/ws'
import { telegramInboundInvalidationSchema } from '@open-mercato/cezar-api-client'
import { SendIcon } from 'lucide-react'
import type { ChatProviderDescriptor } from '../types'
/** Why a Telegram capability is off, in the words the operator needs to fix it. */
const telegramUnavailableMessages: Record<string, string> = {
  flag_off: 'Task control needs CEZ_CHAT_INBOUND=1. Restart cezar with it to enable task control.',
  webhooks_off: 'Telegram needs CEZ_WEBHOOKS=1. Restart cezar with it, then reload this page.',
  hosted: 'Telegram is not available on a hosted cockpit. Run cezar locally to connect a bot.',
  unavailable: 'Telegram is unavailable right now. Try again in a moment.',
}

/** Friendly copy for every setup failure the wizard's calls can surface; never the raw code. */
const wizardErrorMessages: Record<string, string> = {
  ...telegramUnavailableMessages,
  invalid_token: 'Telegram rejected this bot token. Copy it again from @BotFather and try again.',
  blocked: 'Telegram blocked this bot. Unblock or recreate it, then try again.',
  conflict: 'Telegram settings changed. Start setup again.',
  damaged_state: 'Telegram access is damaged. Reset access, then start setup again.',
  vault_unavailable: 'The bot token store is unavailable. Restore it, then retry setup.',
  already_paired: 'This person is already approved for this chat, so no further approval is needed.',
  pairing_expired: 'This setup link expired. Start again.',
  pairing_limit: 'Too many Telegram setups are open. Finish or cancel one, or wait five minutes, then try again.',
  chat_limit: 'This bot already serves 20 chats. Remove a chat before adding another.',
  comparison_required: 'Compare the code sent privately by Telegram before continuing.',
  pairing_required: 'Press Start in Telegram before continuing.',
  pairing_changed: 'The pairing changed before it was approved. Start setup again.',
  chat_changed: 'The Telegram chat changed. Refresh and try again.',
  chat_conflict: 'This chat is already connected to this bot. Manage it in the Telegram tab instead.',
  bot_conflict: 'This bot is connected to another project or cezar. Use a different bot, or disconnect it there first.',
  bot_busy: 'This bot is busy with another change. Try again in a moment.',
  group_ineligible: 'This group cannot be used. Forum groups (with topics) are not supported, and the bot must still be a member.',
  group_visibility_required: 'Confirm that every member of this group can read project messages.',
  receiver_ineligible: 'This chat is not ready. Check its diagnostics and try again.',
  receiver_creation_unavailable: 'Telegram setup is unavailable right now. Try again in a moment.',
  receiver_creation_failed: 'Telegram could not set up this chat. Try again.',
  binding_missing: 'This bot is no longer assigned to this chat. Refresh the page.',
  grant_limit: 'This project has reached its Telegram access limit.',
  candidate_not_group_member: 'That person is not a member of this group. Have them join and try again.',
}

const telegramSetupErrorMessages: Record<string, string> = {
  invalid_token: 'Telegram rejected the saved bot token. Get a new token from @BotFather and use Add a chat with it.',
  blocked: 'Telegram blocked this bot. Unblock or recreate it, then try again.',
  conflict: 'Telegram settings changed. Refresh the receiver and start setup again.',
  damaged_state: 'Telegram access is damaged. Reset access below, then start setup again.',
  vault_unavailable: 'The bot token store is unavailable. Restore it, then retry setup.',
}

const telegramErrorMessages: Record<string, string> = { flag_off: 'Telegram task control is turned off in this cockpit.', webhooks_off: 'Webhooks are turned off, so Telegram replies cannot run.', hosted: 'Telegram task control is available only in a local cockpit.', unavailable: 'Telegram is temporarily unavailable. Try again in a moment.', receiver_ineligible: 'This receiver is not ready. Test and activate it with Standard content and waiting notifications enabled.', group_ineligible: 'This group cannot receive replies. Choose a private or non-forum group chat.', group_visibility_required: 'Confirm that group members may see project messages before continuing.', chat_conflict: 'This chat already has task control through another Telegram receiver. A private chat serves one person, so use that receiver.', pairing_required: 'Approve a person with Enable task control before enabling replies.', pairing_changed: 'The pairing changed before it was approved. Start Telegram setup again.', chat_changed: 'The Telegram chat changed. Refresh the receiver and try again.', revision_required: 'The settings changed. Review the refreshed settings, then try again.', revision_conflict: 'Settings changed. Review the refreshed settings and try again.', receiver_changed: 'The receiver changed. Refresh it and try again.', credentials_unavailable: 'The bot token is unavailable or no longer works. Use Add a chat with the bot’s current token.', reset_unavailable: 'Access cannot be reset until the bot state can be verified.', reset_required: 'The bot state needs a reset before this action can continue.', owner_conflict: 'Another cockpit owns this bot. Stop it there or choose another bot.', foreign_state: 'This bot belongs to another project. Choose another bot.', state_missing: 'The bot state is missing. Refresh the page and try again.', bot_busy: 'The bot is busy finishing another operation. Try again shortly.', replacement_required: 'This receiver’s bot or chat changed. Replace the pairing to continue.', already_paired: 'This person is already approved for this receiver, so no further approval is needed.', pairing_limit: 'Too many setup links are waiting. Wait five minutes or cancel one, then try again.', grant_limit: 'This project has reached its Telegram access limit.', comparison_required: 'Compare the code sent privately by Telegram before approving.', pairing_expired: 'This setup link expired. Create a new link and try again.', binding_missing: 'This bot is no longer assigned to this receiver. Refresh the page.', grant_missing: 'This approved person no longer exists. Refresh the page.', invalid_cursor: 'The activity history cursor is no longer valid. Refresh the history.', noncanonical_root: 'Telegram inbound access cannot run until the project path is canonical.', expired: 'This setup link expired. Create a new link and try again.', not_found: 'That Telegram pairing or receiver no longer exists. Refresh and try again.' }

export const telegramDescriptor: ChatProviderDescriptor & { bot: NonNullable<ChatProviderDescriptor['bot']> } = {
 id: 'telegram', name: 'Telegram', format: 'telegram.v1', icon: SendIcon,
 description: 'Send task updates to your Telegram chats and answer tasks from them.',
 bot: {
  api: telegramApi,
  unavailableMessages: telegramUnavailableMessages,
  setupErrorMessages: wizardErrorMessages,
  settingsErrorMessages: { ...telegramErrorMessages, ...telegramSetupErrorMessages },
  setupApi: {
   begin: async (projectId, json) => unwrap(await cez.api.v1.p[':projectId'].telegram.setup.$post({ param: { projectId }, json }), '/telegram/setup'),
   status: async (projectId, id, signal) => unwrap(await cez.api.v1.p[':projectId'].telegram.setup[':id'].$get({ param: { projectId, id } }, { init: { signal } }), '/telegram/setup'),
   activate: async (projectId, id, input) => unwrap(await cez.api.v1.p[':projectId'].telegram.setup[':id'].activate.$post({ param: { projectId, id }, json: { ...input, activate: true } }), '/telegram/setup/activate'),
   cancel: async (projectId, id) => unwrap(await cez.api.v1.p[':projectId'].telegram.setup[':id'].$delete({ param: { projectId, id } }), '/telegram/setup'),
  },
  subscribe: changed => subscribeTopic('telegram-inbound', data => { if (telegramInboundInvalidationSchema.safeParse(data).success) changed() }),
  validChatId: id => /^-?[1-9][0-9]*$/.test(id ?? ''), isGroup: id => id?.startsWith('-') === true,
  fields: [{ name: 'token', label: 'Bot token', placeholder: '123456789:AA…', pattern: /^\d{5,15}:[A-Za-z0-9_-]{30,64}$/, invalid: 'This does not look like a bot token. It has the form 123456789:AA… — copy it from @BotFather.' }],
  credentialHelp: { create: 'Create a bot with', add: 'Paste the token of the bot you already connected. Each person or group gets its own chat.', storage: 'The token is saved only in this project’s secret store.' },
  commands: { respond: '/tasks, /status and /reply', reply: '/reply', cancel: '/cancel', continue: '/continue', guidance: '' },
  lastContactLabel: 'Last successful poll',
  groupRestriction: 'Forum groups are not supported.',
  credentialHint: 'Continue checks the token with Telegram and starts setup. Nothing is sent to your chats until you activate notifications.',
  help: { label: '@BotFather', href: 'https://t.me/BotFather' },
  approval: {
   savedCredentials: 'Cezar checks the chat’s saved bot token and creates a one-time link that expires in five minutes. The token is never shown here.',
   checkingCredentials: 'Checking the saved bot token…',
   waitingTitle: 'Open Telegram and press Start',
   waiting: (username, group) => `Waiting for Telegram… ${group ? 'The person to approve opens this link in their own private chat with' : 'Open this link in your private chat with'} @${username} and ${group ? 'presses' : 'press'} Start.`,
   candidate: username => `pressed Start in @${username}.`,
   controlDescription: 'The trusted person opens the private link and presses Start to get task control.',
   privateControl: 'The first person who presses Start is approved to control tasks. No second link is needed.',
   groupControl: 'Task control requires a second private Start and code comparison after notifications are active.',
   controlHint: 'Open the private setup link and press Start to approve the person who may control tasks.',
   comparisonHint: 'Task control requires the second private Start and code comparison.',
  },
  discoveryHint: 'Choose the chat that receives notifications: your private chat or a group.',
  privateHint: 'Opens your own chat with the bot. Press Start there.',
  groupHint: 'Pick a group and add the bot; it starts there automatically. Forum groups (with topics) are not supported.',
  groupLink(link) { try { const url = new URL(link), code = url.searchParams.get('start'); if (!code) return; url.search = ''; url.searchParams.set('startgroup', code); return url.toString() } catch { return undefined } },
  begin: (credentials, name) => ({ token: credentials.token!, name, dedicatedBot: true }),
 },
}
