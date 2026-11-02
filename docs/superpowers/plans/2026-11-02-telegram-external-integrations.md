# Telegram in External integrations

## Goal

Make Telegram a first-class external integration instead of presenting it as a
generic webhook receiver. The user should find one Telegram card under
Settings → External integrations, with one entry point for the unified setup
wizard and the existing diagnostics, task-control access, and revocation
controls available from the same card. The Webhooks page should contain only
generic/custom, Slack, and Discord receivers.

## Design

- Keep the existing HTTP API, receiver storage, Telegram setup wizard, and
  inbound management behavior unchanged.
- Add a Telegram integration card to `IntegrationsSection` that loads the
  project webhook capability and Telegram receiver list, renders a single
  `Connect Telegram` action when setup is needed, and renders the existing
  inbound management panel plus the wizard when Telegram is configured.
- Filter Telegram receivers out of the Webhooks list and remove Telegram-only
  setup controls and destination choices from that screen. Generic webhook
  copy must no longer advertise Telegram.
- Keep Telegram receiver rows in the underlying API so the integration card
  remains the single owner of their lifecycle.
- Update focused UI tests, the browser fixture/e2e entry point, and user-facing
  docs/spec notes so links and labels describe External integrations.

## Scope

- Cockpit settings components and tests under `packages/web/src/routes/settings`.
- The existing Telegram e2e fixture/test and Telegram setup documentation.
- No server or contract changes.

## Verification

- Focused web tests for integrations, webhooks, Telegram wizard/inbound.
- Web typecheck and build.
- Simulated Telegram e2e fixture.
- Documentation check and `git diff --check`.

## Review focus

- Existing Telegram receivers must remain manageable after being hidden from
  Webhooks.
- The unified wizard must still receive the project ID and invalidate both
  webhook and Telegram queries after completion.
- Webhooks must not offer a second Telegram creation/edit path.
- Capability-off and loading/error states must not trigger unnecessary receiver
  queries or produce an unusable integration card.
