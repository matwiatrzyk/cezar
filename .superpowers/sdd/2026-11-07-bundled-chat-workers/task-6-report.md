# Task 6 report: bundled Slack/Discord workers

Date: 2026-11-07

## Scope

This task changed documentation and the package smoke-check script only. No runtime TypeScript,
test, worker entrypoint, manifest source, or generated artifact was changed.

## Contract documented

- Slack and Discord are first-party bundled workers, not installable extensions or npm-resolved
  packages.
- The build output is `dist/bundled-chat/catalog.json`, with
  `dist/bundled-chat/slack/{index.js,manifest.json}` and
  `dist/bundled-chat/discord/{index.js,manifest.json}`.
- Manifest fields are stable and exact: public IDs `slack` and `discord`, semver `version`, a
  provider-relative `entry`, `sha512-<base64>` `integrity`, and matching formats `slack.v1` and
  `discord.v1`. The catalog loader rejects duplicate IDs, path escapes, missing/symlinked files,
  and integrity mismatches.
- The package smoke check now verifies both worker entrypoints and both manifests whenever the
  catalog is present in the would-be npm tarball.
- `slack`, `discord`, `slack.v1`, and `discord.v1` are reserved. External extensions must use
  qualified IDs such as `extensionId/localId`; they cannot replace bundled aliases.
- The host owns credentials/rotation, receiver and grant identity, authorization, durable receive
  acceptance/checkpointing and task effects. Workers own platform sockets and bounded adapter
  operations. Stable event IDs, ordered cursors, durable acceptance before checkpointing,
  generation/abort fencing, replay-safe ACKs, and receive-first shutdown ordering are documented.
- Local startup selects workers before chat recovery. Hosted mode, `CEZ_EXTENSIONS=0`, missing or
  tampered artifacts, and per-provider activation failure use the existing compatibility owner
  without running duplicate consumers. Workers are failure-isolated, not security sandboxes.
- `.env.example` and `docs/reference.md` now describe that `CEZ_EXTENSIONS=0` also disables
  bundled worker activation while preserving configured Slack/Discord integrations through the
  in-process compatibility adapter.
- Verification commands are documented with bounded `timeout` values for typecheck, build,
  package smoke, and tests; real credentials/platforms are explicitly excluded.

## Files changed

- `.env.example`
- `docs/extensions.md`
- `docs/authoring-extensions.md`
- `docs/adding-chat-provider.md`
- `docs/reference.md`
- `packages/cezar/scripts/check-pack.mjs`

## Verification

Passed:

- `git diff --check`
- `node --check packages/cezar/scripts/check-pack.mjs`

Blocked by the existing checkout state:

- `timeout 300 npm run build -w @open-mercato/cezar` fails during `tsc` before the bundled-chat
  build. The installed/workspace contract package does not expose numerous symbols consumed by
  the service, including `trackerAutomationOptionsSchema`, `parseScheduleDate`, chat state types,
  dashboard types, and others; it also reports missing `proper-lockfile` and `@napi-rs/keyring`
  declarations. These errors are outside this documentation/package-contract scope.
- `timeout 300 npm run check:pack -w @open-mercato/cezar` reaches the script but fails because
  this checkout has no `web/dist/index.html` or `web/dist/assets/*`. It therefore cannot produce
  a publishable tarball report; this is the pre-existing cockpit artifact prerequisite, not a
  bundled worker gap.

No files outside the ordered scope were modified, and no network, credentials, or external
systems were used.
