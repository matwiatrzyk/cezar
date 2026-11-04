import { useEffect, useState } from 'react'
import { CopyIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { writeClipboard } from '@/lib/clipboard'

export function CopySetupValue({ value, label }: { value: string; label: string }) {
  const [result, setResult] = useState('')
  useEffect(() => setResult(''), [value])
  return <span className="flex flex-wrap items-center gap-2"><Button size="sm" variant="outline" onClick={async () => {
    try { await writeClipboard(value); setResult('Copied') } catch { setResult('Could not copy. Select the value and copy it manually.') }
  }}><CopyIcon />{label}</Button><span role="status" className="text-ui text-muted-foreground">{result}</span></span>
}

// Slack's manifest configures the otherwise easy-to-miss inbound events and writable App Home.
export const slackAppManifest = JSON.stringify({
  display_information: { name: 'Cezar', description: 'Task notifications and conversations with Cezar' },
  features: { bot_user: { display_name: 'Cezar', always_online: false }, app_home: { home_tab_enabled: false, messages_tab_enabled: true, messages_tab_read_only_enabled: false } },
  oauth_config: { scopes: { bot: ['chat:write', 'app_mentions:read', 'channels:read', 'channels:history', 'groups:read', 'groups:history', 'im:read', 'im:history', 'mpim:read', 'mpim:history'] } },
  settings: { socket_mode_enabled: true, interactivity: { is_enabled: true }, event_subscriptions: { bot_events: ['app_mention', 'message.channels', 'message.groups', 'message.im', 'message.mpim', 'member_left_channel'] } },
}, null, 2)

export const slackCreateAppUrl = `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(JSON.parse(slackAppManifest)))}`

export function ChatSetupHelp({ providerId, connecting = false }: { providerId: string; connecting?: boolean }) {
  if (providerId === 'telegram') return null
  if (connecting) return <details className="rounded-md border p-3 text-sm"><summary className="cursor-pointer font-medium">No message received? Check these steps</summary>
    {providerId === 'slack' ? <ol className="mt-2 list-decimal space-y-2 pl-5">
      <li>Open the app in Slack → Messages. If Messages is missing, enable it in App Home and allow users to send messages.</li>
      <li>In Slack app settings, enable Socket Mode and Event Subscriptions. Subscribe to message.im for direct messages and app_mention for channels. Save and reinstall the app if Slack asks.</li>
      <li>For a channel, invite the bot first and select it from the @ picker before the command. Send a new message using the current code.</li>
    </ol> : <ol className="mt-2 list-decimal space-y-2 pl-5">
      <li>Use “Add to a group” to invite the bot to a server you belong to. The invite already includes the required permissions.</li>
      <li>Open the bot from that server’s member list → Message. Allow direct messages in the server’s privacy settings. A rejection by Clyde means Discord did not deliver your message.</li>
      <li>In Developer Portal → Bot, enable Message Content Intent. Leave Interactions Endpoint URL empty. If you changed these settings, cancel and restart setup.</li>
      <li>Alternatively, send the channel command in a text channel the bot can view and send messages in.</li>
    </ol>}
    <a className="mt-2 inline-block underline" href={providerId === 'slack' ? 'https://api.slack.com/apps' : 'https://discord.com/developers/applications'} target="_blank" rel="noreferrer">Open app settings</a>
  </details>
  return <div className="rounded-md border p-3 text-sm">
    <h3 className="font-medium">Prepare your {providerId === 'slack' ? 'Slack app' : 'Discord bot'}</h3>
    {providerId === 'slack' ? <>
      <ol className="my-2 list-decimal space-y-2 pl-5">
        <li><a className="underline" href={slackCreateAppUrl} target="_blank" rel="noreferrer">Create a preconfigured Slack app</a>. Choose your workspace and review the settings. Cezar fills in messages, events, permissions and Socket Mode for you. If Slack asks you to paste a manifest, use the copy button below.</li>
        <li>Install to Workspace, then copy the Bot User OAuth Token from OAuth &amp; Permissions into Bot token below.</li>
        <li>In Basic Information → App-Level Tokens, generate a token with connections:write and paste it into App-level token below.</li>
      </ol>
      <CopySetupValue value={slackAppManifest} label="Copy Slack manifest" />
      <details className="mt-2"><summary className="cursor-pointer">Show manifest</summary><pre className="max-h-48 overflow-auto whitespace-pre-wrap text-xs">{slackAppManifest}</pre></details>
      <p className="mt-2 text-muted-foreground">Already have an app? Apply these settings in App Manifest, save, and reinstall if Slack requests it.</p>
    </> : <ol className="mt-2 list-decimal space-y-2 pl-5">
      <li><a className="underline" href="https://discord.com/developers/applications" target="_blank" rel="noreferrer">Open Discord Developer Portal</a> → New Application → Bot.</li>
      <li>Enable Message Content Intent under Privileged Gateway Intents. Leave Interactions Endpoint URL empty.</li>
      <li>Copy the bot token into the field below. Reset Token if Discord no longer shows it.</li>
      <li>Next, Cezar generates your server invitation with the required permissions. You do not need Administrator or a separate webhook.</li>
    </ol>}
  </div>
}
