# Unified Slack and Discord setup

User-approved scope: one capability-led Connect entry, minimal permissions for notification-only destinations, optional conversation, inline copy actions and actionable provider preparation. Supersedes the separate add-webhook/add-bot entry points in the gallery and chat provider UI specs. Telegram keeps its existing setup flow.

- One vocabulary: the optional capability is called task control everywhere (choice, wizard, panel); "conversation" is not used. Connect offers Notifications only or Notifications and task control; once a bot exists the same dialog is titled Add a chat.
- The token step shows the provider preparation box once (hidden when adding a chat to a connected bot); the dialog description and the token hint no longer repeat it. The connect step is a numbered list (Discord: invitation first), shows Slack's identical private/channel command once, and collapses to the sender line once the setup command arrived.
- The webhook-only receiver list is shown only when such receivers (or their deleted history, a receiver link, or the webhooks-off explanation) exist; the change notice renders in the panel header for every provider. Slack/Discord panels with webhook-only receivers and no bot read the same delivery status as their gallery tile.
- Connect offers Notifications only or Notifications and task control. The former uses a channel webhook without message-reading permissions, or the existing bot when one is already connected. The latter selects conversation in the existing bot wizard without granting optional start/cancel/continue permissions automatically.
- Notification-only setup saves an inactive receiver, automatically sends a test, shows delivery results using the existing project event invalidations, and requires explicit activation after successful delivery. Changed delivery revisions and unknown/failed/pending results cannot activate. Closing retains an inactive receiver; retry tests the same receiver rather than recreating it.
- Existing webhook rows offer Enable task control in place. Upgrade passes the same receiver id/revision to the existing transactional attachment and test path; bot chats do not get a second webhook row.
- Slack creation link prefills its JSON manifest; copying remains a fallback. The manifest declares Socket Mode, writable Messages, interactivity, scopes and supported events. Tokens still require the operator's workspace authorization. Discord instructions explain intent, invitation permissions, shared server and DM delivery. No third-party application settings are mutated silently.
- Copy uses the shared clipboard helper, with success feedback and visible manual fallback. No credential is copied out of the vault or printed.
- Setup verifies incoming discovery and outgoing test separately. Existing bounded setup expiry, ownership, group consent/comparison, revision fences and test-before-activation are retained. No new API, state format, migration or environment flag.

Verification: focused UI tests cover intent, manifest/clipboard, create/test/activate gating, failure/retry, navigation and revision changes; existing native-adapter simulated browser tests cover upgrade identity and persisted grants. Real Slack/Discord credentials are not used by automated checks.

Platform sources checked: https://docs.slack.dev/reference/app-manifest/ and https://docs.discord.com/developers/events/gateway

Prefilled creation links follow https://docs.slack.dev/app-manifests/configuring-apps-with-app-manifests (manifest_json).
