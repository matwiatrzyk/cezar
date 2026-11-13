# Unified Slack and Discord setup

Status: implemented, not yet released. Builds on
`2026-11-04-chat-providers.md` and the Integrations gallery (`2026-11-03-integrations-gallery.md`).
Telegram keeps its own setup flow (`2026-10-29-telegram-setup-and-replies.md`).

## Goal

One capability-led **Connect** entry per platform, minimal permissions for notification-only
destinations, optional task control, inline copy actions and actionable provider preparation.

## Design

- One vocabulary: the optional capability is called **task control** everywhere (choice, wizard,
  panel). Connect offers **Notifications only** or **Notifications and task control**; once a bot
  exists the same dialog is titled **Add a chat**.
- **Notifications only** uses a channel webhook without message-reading permissions, or the
  existing bot when one is already connected. **Notifications and task control** runs the bot
  wizard with conversation enabled, without granting the optional start/cancel/continue
  permissions automatically.
- The token step shows the provider preparation box once (hidden when adding a chat to a connected
  bot). The connect step is a numbered list (Discord: invitation first), shows Slack's command
  once (identical in a private chat and a channel), and collapses to the sender line once the
  setup command arrived.
- The webhook-only receiver list is shown only when such receivers (or their deleted history, a
  receiver link, or the webhooks-off explanation) exist; the change notice renders in the panel
  header for every provider. Slack/Discord panels with webhook-only receivers and no bot read the
  same delivery status as their gallery tile.
- Notification-only setup saves an inactive receiver, automatically sends a test, shows the
  delivery result through the existing project event invalidations, and requires explicit
  activation after a successful delivery. A changed delivery revision and an unknown, failed or
  pending result cannot activate. Closing keeps the inactive receiver; retry tests the same
  receiver rather than recreating it.
- Webhook-only rows offer **Enable task control** in place. The upgrade passes the same receiver
  id/revision to the transactional bot attachment and test path, so a bot chat never gets a second
  webhook row.
- The Slack creation link prefills the app manifest (`manifest_json`); copying it remains a
  fallback. The manifest declares Socket Mode, writable Messages, interactivity, scopes and the
  supported events. Tokens still require the operator's workspace authorization. Discord
  instructions explain intents, invitation permissions, a shared server and DM delivery. No
  third-party application setting is changed silently.
- Copy uses the shared clipboard helper with success feedback and a visible manual fallback. No
  credential is copied out of the vault or printed.
- Setup verifies incoming discovery and outgoing test separately. Bounded setup expiry, ownership,
  group consent/comparison, revision fences and test-before-activation all apply. No new API,
  state format or environment flag.

## Verification

Focused UI tests cover intent, manifest/clipboard, create/test/activate gating, failure/retry,
navigation and revision changes; the simulated-platform browser suites
(`packages/web/e2e/slack-*.e2e.ts`, `discord-*.e2e.ts`) cover upgrade identity and persisted
grants; they are run manually with `npm run test:e2e:runner` before a release (not part of CI). Automated checks never use real Slack/Discord credentials.

Platform sources: https://docs.slack.dev/reference/app-manifest/,
https://docs.slack.dev/app-manifests/configuring-apps-with-app-manifests (`manifest_json`),
https://docs.discord.com/developers/events/gateway
