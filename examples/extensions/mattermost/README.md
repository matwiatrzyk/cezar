# Mattermost extension

A standalone fourth chat provider using only the public SDK and the
[Mattermost v4 API](https://docs.mattermost.com/api). Build with `npm install`
and `npm run build`, then select this folder in Settings → Extensions,
preview/install, and approve it for a project. This code runs as your local user.

Open Integrations → Mattermost and enter your HTTPS server URL and a dedicated
bot access token. Open the returned direct-message link and send the displayed
`cezar start <code>` message. Approve through the existing Cezar pairing flow.
Use `cezar tasks`, `cezar reply`, and `cezar task <prompt>`; replies to bot posts
also use the core task-control flow. Group setup requires private verification
and membership checks. No native slash-command registration is needed.

The bot reads at most 20 joined channels; use a dedicated bot with fewer channels.
Messages are polled through the worker; the host persists the platform cursor
only after durable core acceptance. Posts at the same timestamp are replayed
through core event-ID deduplication. Buttons are not supported; use text
commands. Disable stops the worker and releases bot ownership without deleting
pairings. Re-enable uses the same IDs, encrypted credentials and grants.
