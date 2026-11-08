# Extension placements (V1.1) — panels and commands outside Settings

Status: design, 2026-11-07. Follows `.ai/specs/2026-11-05-extension-system-design.md` (V1), whose
stated limitation was "panels, commands and forms render only in Settings → Extensions". The
business review (2026-11-07) called that the largest gap against the "like VS Code" goal.

## Goal

An enabled extension's panels and commands appear where the user works — the command palette,
the project sidebar and the task workspace — declared in the manifest, rendered by the same
declarative renderer, with no new trust granted to the extension.

## Non-goals

- Arbitrary HTML/React from extensions (V1 rule stays).
- New permissions. Task-scoped reads reuse `project.read`; the only mutation stays `tasks.propose`.
- Hosted cockpit: no new surface. Everything here is gated by `capabilities.extensions`.
- A marketplace, per-user placement overrides, or drag-and-drop of extension cards.

## Manifest (additive, inside API `0.1` — BACKWARD_COMPATIBILITY.md §6b)

```json
"contributes": {
  "panels":   [{ "id": "summary", "title": "Project summary", "location": "sidebar" },
               { "id": "task-notes", "title": "Notes", "location": "task" }],
  "commands": [{ "id": "refresh", "title": "Refresh summary", "location": "palette" },
               { "id": "summarize", "title": "Summarize this task", "location": "task" }]
}
```

- `location` is optional on both; default `settings` (today's behaviour, byte-for-byte).
- Panel locations: `settings` | `sidebar` | `task`. Command locations: `settings` | `palette` | `task`.
- Limits: at most 3 `sidebar` panels and 5 `task` panels per extension; 20 palette commands.
- A new host accepts existing manifests without `location` and keeps rendering them in Settings.
  An older host whose strict schema does not know `location` rejects a manifest containing it;
  adding an optional field to the new schema cannot update that older parser. Authors using
  placements require a host with V1.1 placement support. This is backward compatibility for old
  manifests on new hosts, not forward compatibility for new manifests on old hosts; see
  BACKWARD_COMPATIBILITY §6b. Record the first supported release when the feature is released.

## Context passed to the extension

- `task`-located panels and commands receive `{ runId }` (host-asserted, never from the payload's
  own `projectId`). The panel provider signature becomes `(context?: { runId?: string })`; the
  command handler input gains `runId` for `task` location.
- New context API `tasks.get(runId)` (requires `project.read`), returning the same public shape as
  one item of `tasks.list()`. Nothing else is added.
- Palette and sidebar surfaces pass no task context.

## Cockpit surfaces

1. **Command palette** — a new group "Extensions" after "Actions", listing `palette` commands of
   the current project's enabled extensions as "<Extension name>: <command title>". Selecting runs
   the command; the result (`message` or a task proposal) is shown through the same proposal/toast
   path Settings → Extensions already uses. Hidden on hosted and when `capabilities.extensions`
   is off. Commands never appear while the extension's worker is `failed`.
2. **Project sidebar** — `sidebar` panels render as collapsible sections under the nav in the
   project scope, default collapsed, title = panel title, body = the declarative renderer. A
   failed/stopped worker shows the section with a one-line error and a link to Settings →
   Extensions. Collapsed state is UI state in `~/.cezar/config.json` (`workspaceUiState`, optional
   key, `.catch` default), never required.
3. **Task workspace** — ONE new built-in view `extensions` in `workspaceViewSchema`
   (`'session' | 'changes' | … | 'extensions'`), pickable from the view picker only when at least
   one enabled extension contributes a `task` panel or command. Inside, each `task` panel is a card
   (the renderer) and `task` commands are buttons in the view header. Persisted layouts therefore
   gain one closed literal, not dynamic ids. Verified 2026-11-07: today `readRunLayouts` returns
   `null` for ANY schema failure, so an older cezar reading a layout that names `extensions`
   falls back to the default layout for that task (written state, rebuilt — acceptable, recorded
   in BACKWARD_COMPATIBILITY.md §3). Going forward the loader filters unknown view ids out of a
   layout instead of discarding the file, with a test, so the next such addition degrades to
   "that view is missing", not "all layouts reset".

## Data flow and liveness

- `GET /extensions/placements?location=…` (project-scoped, chained, zod) returns the enabled
  extensions' contributions for one location: `{ extensionId, name, status, panels[], commands[] }`.
  Panel bodies are still fetched per panel (`/extensions/:id/panels/:panelId`, now with an optional
  `runId` query validated as middleware) so a slow extension never blocks the list.
- Refresh: the existing `useExtensionSubscription` (WS, `{changed:true}`) invalidates placements
  and panels; task-view panels also refetch on the run's SSE updates (status/step change), debounced.
- Every panel/command id is qualified in the UI as `<extensionId>/<id>` (collision-free).

## Failure and security posture

- The renderer is unchanged: text, status, table, actions. No HTML.
- A panel error renders inside its card; the host view (sidebar/task/palette) never fails because
  an extension did. Same for a 1 MiB over-limit reply: the card says "Panel too large".
- `task` commands run with the host-asserted `runId`; an extension cannot act on a run of another
  project (manager resolves `runId` through the project's own store and 404s otherwise).
- Hosted: placements route answers `{ extensions: [] }` with `available:false`; UI hides surfaces.

## Deliverables

1. SDK + contract + host/manager: `location`, panel context, `tasks.get`, placements route,
   `runId` on panel route; §6b + `docs/authoring-extensions.md` updated in the same commit.
2. Cockpit: palette group, sidebar sections, `extensions` workspace view, API client; unit tests.
3. Examples + docs site: `examples/extensions/project-summary` gains a sidebar panel, a palette
   command and a task panel/command; feature page updated; e2e `extensions` config extended.
4. Independent review of the whole V1.1 slice, then full gate + `npm run test:e2e:runner`.

## Acceptance

- The project-summary example, installed from a local folder, shows its panel in the sidebar,
  its command in the palette and its task panel in a task's `extensions` view, without a restart.
- Disabling the extension removes all three within one WS tick; a crashed worker shows error
  cards, never a blank sidebar or a broken palette.
- An extension built against V1 (no `location`) behaves exactly as before.
- `contract-parity`, `route-parity`, `typed-bodies`, `bc-route-inventory`, web unit tests and
  `test:e2e:runner extensions` are green.
