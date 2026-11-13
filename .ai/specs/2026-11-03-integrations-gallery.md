# Settings → Integrations gallery

Status: implemented, not yet released. Related: #1614,
spec 2026-10-29 (Telegram), spec 2026-11-09 (independent chat plugins: categories, links to
Settings → Extensions).

## Decision

A project's third-party tools live in ONE project settings section, **Integrations**, shown as a
gallery of tiles grouped by category. A tile shows the tool's status; clicking it opens that
tool's configuration in place (`?integration=<id>`), with **All integrations** to go back.
Category chips (`All`, `Chat`, `Issue tracking`, `Testing`, `Webhooks`) and the search box filter
the gallery together; a category is a filter, never part of an integration's identity.

| Category | Tile id | Configuration it opens |
| --- | --- | --- |
| Chat | `telegram`, `slack`, `discord`, and every extension chat provider | the provider's panel and setup wizard (spec 2026-10-29, spec 2026-11-04-chat-providers); Slack/Discord also list their webhook-only (`slack.v1` / `discord.v1`) receivers |
| Issue tracking | `jira`, `linear` | `TrackerSection` limited to that provider |
| Testing | `e2e` | `TesterArmyE2eCard` |
| Webhooks | `webhooks` | `WebhooksSection` filtered to `cezar.json.v1` |

Several integrations are active at once. The one-tracker-per-project limit of spec 2026-09-18
holds; the Linear/Jira panel warns that connecting the other provider replaces the issue source.

**Why one section:** a separate settings entry per tool fragments navigation, and each new chat
provider would otherwise add a menu item. Installing software is a different concern and lives in
Settings → Extensions; Integrations configures a connection for one project.

## Relation to earlier specs

Only the settings PLACEMENT of specs 2026-09-18 (Settings → Issue tracker), 2026-10-10
(External integrations → Test frameworks), 2026-10-12 and 2026-10-19 (Settings → Webhooks) moves
here. Their
behaviour, storage and APIs are unchanged.

## Compatibility (released settings paths, v0.19.0)

- `/settings/tracker` → `/settings/integrations`.
- `/settings/webhooks` → `/settings/integrations`; with `endpoint` it keeps every parameter and adds
  `integration=slack|discord|webhooks` by the receiver's destination (Webhooks when unknown).
- The gallery adds no HTTP route, contract shape or stored state of its own.
