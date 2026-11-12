# Connecting a dedicated Slack app

Connect a dedicated Slack app through Settings → Integrations → Slack. Existing incoming-webhook
receivers keep sending notifications; choose **Connect Slack** (or **Add a chat**) → **Notifications and task control** →
**Enable task control for <name>** to connect a bot to the same receiver.

Create a dedicated Slack app, enable Socket Mode and generate an app-level `xapp-` token with
`connections:write`. Install the app and obtain its `xoxb-` bot token. Enable Interactivity,
the Messages tab in App Home, and event subscriptions for `message.im`, `message.mpim`,
`message.channels`, `message.groups`, `app_mention`, and `member_left_channel`.
Grant bot scopes `chat:write`, `app_mentions:read`, `channels:read`, `groups:read`, `im:read`,
`mpim:read` and the corresponding four `*:history` scopes for message subscriptions.
Invite the bot to each channel. Reinstall after changing scopes.

Enter both tokens only in the cockpit's Slack setup. They are stored in the project secret
store, never a receiver URL or agent environment. Use the same app for both tokens, dedicated
to this cockpit project. Cezar uses an outbound Socket Mode connection, so no public URL or
inbound firewall exception is needed. See [Slack's Socket Mode guide](https://docs.slack.dev/apis/events-api/using-socket-mode/).

Send the displayed `cezar start CODE` manually in a DM with the bot. For a group, invite and
mention the bot followed by that command. Slack links open the app but do not send setup
commands. Approve notifications and, optionally, task control in the cockpit. Group control
requires private verification and code comparison. `cezar task` requires its own Start permission
and a Confirm button. Reply to the original bot message in a thread to address its task.

Cezar conservatively discards retransmissions and input from before its connection started.
A crash or connection outage may lose input; inspect the cockpit before resending a request.
Missing conversation scopes or transient Slack failures do not revoke approved people.
