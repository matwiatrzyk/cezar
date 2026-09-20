# Dashboard — final verification and delivery

Current behavior is specified in [Workspace dashboard](../../specs/2026-09-18-observability-dashboard.md)
and [Usage, trends and export](../../specs/2026-09-19-dashboard-costs.md).

## Final scope

Two views: Overview and Usage & cost. Eight sortable modules, with view-scoped restore actions,
workspace-persisted visibility/order, paired compact cards and upgrade of incomplete legacy defaults.
Overview covers current attention, finish-cohort outcomes, project comparison, recent results,
queue/scheduling and enabled automations with distinct next run/check semantics. Usage covers
reported USD/tokens, coverage and creation-date trends. PDF/CSV capture only the displayed scope.
Legacy Operations URLs remain an intentional compatibility path, not an extra view.

## Cleanup

Removed four superseded review/audit/feature notes after merging their final decisions into the
two specifications. Replaced the historical verification transcript with this current report.
Removed unused allTiles constant. Retained purposeful compatibility, regression tests and local
ignored browser artifacts. Fixed mixed GitHub failure/loading state hiding Retry; its regression
was confirmed red before the fix and green afterwards. No scheduling, metric semantics or
external integrations were changed by cleanup.

## Verification

Final review gate (2026-09-19): **421 Vitest files / 7327 tests pass**. All-workspace
typechecks, service/web production builds, check:pack (548 files / 88 web assets) and diff checks
pass. The preceding cleanup also passed 36 CLI and 16 package tests; this frontend-only review
did not rerun those unchanged CLI/package suites.

Confirmed and fixed:
- A complete custom order ending in Automations was mistaken for a legacy default and reset.
  Only the incomplete legacy default now migrates; complete user orders are preserved.
- Generic feed Retry refreshed local tasks even when GitHub failed. It now retries the failed
  visible sources, without starting a hidden source.
- Automation queries were outside dashboard reconnect reconciliation. They now refresh on
  reconciliation and project rename, while ordinary task events do not refetch every project's
  automation list.

Five regression assertions failed before the fixes; the focused 61-test gate then passed.
Full-suite log: /tmp/dashboard-final-review-suite.log. Other current logs:
 /tmp/dashboard-final-review-{red,green,types,build,pack,layout,automations,retry,exports,pdf}.log.

Local Chromium checks cover default/legacy/custom layouts (including Automations last),
schedule/poll/unarmed/paused states, scoped links, keyboard reorder, hide/reload, mobile width,
GitHub Retry in All and GitHub views, and Needs-you Sheet focus restoration. Preference writes
and automation test responses are intercepted; no real automations are enabled or run.

Generated four current UI PDF+CSV pairs: Overview/Usage with all or selected modules visible.
All 64/188/43/180 data records match captured screen annotations, plus 6/2/4/1 context rows.
PDFs have 4/3/3/2 pages; all pages were rasterized and text extracted, with representative pages
visually inspected. No interactive buttons remain in print output and no horizontal overflow
was found. Earlier cleanup additionally covered missing/ready/loading/failed GitHub states.

Evidence limits: browser checks use the local fixture preview with selected mocked failures,
not a production acceptance environment or a formal accessibility/security audit. Reported
usage remains retained-task lifetime data, not billing; completed tasks do not prove accepted
business outcomes. These limits remain explicit in the product and exports.

## Compatibility follow-up (2026-09-20)

Future widget IDs now survive bounded schema parsing and writes; the current cockpit renders
known widgets only and retains unknown slots through visibility changes, drag and reset.
Regression reproduced red before the fix. API tests cover file/GET/PUT round-trips, unrelated
preference writes and rejection of duplicate IDs without overwriting state.

Final gate: 422 files / 7329 tests pass; all-workspace typechecks, service/web builds and
check:pack pass. Chromium checks with a future widget and unknown settings confirm preservation
during keyboard reorder, hide/reload and mobile rendering. Test state writes are intercepted.
Logs: /tmp/dashboard-compat-{red,green,suite,types-final,build,pack,browser}.log.
The initial typecheck found nullable test-call access; corrected before the final typecheck.

Compatibility inventory now names optional workspace usage fields, the already-existing
automation-change event and dashboard preferences in ui-state.json. Both specifications
declare ownership, acceptance criteria, non-goals and open questions. The 15-second local-data
fallback is retained and justified by unowned projects changing on disk without SSE events;
GitHub/automation demand behavior is unchanged. No new storage, migration or runtime dependency.

## Independent multi-agent review (2026-09-20)

An eight-finder review of the full branch diff (`0e9dfd76..HEAD`), cross-checked by a verification
pass, confirmed four defects and one false positive (an archived-task outcome question — matches
the spec's documented completed/failed-includes-archived rule, no change needed):

- `dashboard-forge.ts` built a GitHub driver directly from any remote that merely parsed, instead
  of going through `resolveForge`'s host allowlist — the one path every other forge-aware feature
  uses. A GitLab or self-hosted remote would have been treated as GitHub and reported as a GitHub
  failure instead of "no remote". Now routes through `resolveForge`; the observability spec and
  `ForgeDriver.recentCreated`'s doc comment now say so explicitly.
- `projectCostTask`'s historical-cost fallback only recovered an all-zero step total; a genuine
  nonzero reported cost on a record with no top-level `costUsd` was silently dropped instead of
  summed, undercounting older data in Usage & cost.
- The feed collapsed a project's `partial` coverage into the same `unavailable` state as total
  failure, discarding the distinction `DashboardCoverage` (and every other consumer) preserves.
  Partial now maps to `stale`.
- The feed's Coverage panel (local task-index health) retried through the same generic `refetch`
  as the GitHub banner, which resolves to `github.refetch()` outside the Tasks-only filter — so
  Coverage's retry could silently target GitHub instead of the local source it reports on. Added
  a dedicated `retryTasks`.
- The Overview Sheet (`selection` state) was never cleared when the view went inactive; switching
  views and back reopened it against a snapshot old enough to have expired. Cleared on deactivation.

Flagged but not changed (pre-existing, out of scope for this module): `RunStore.open()` drops an
entire `runs.json` on one malformed record rather than salvaging per-entry like the disk-only
diagnostic path does — a real inconsistency this dashboard's coverage reporting now makes visible,
but fixing it means changing core run-index parsing, not this feature. Also unverified: whether
Claude CLI's per-turn `total_cost_usd` is cumulative across a multi-turn session, which — if it
is — would predate this branch and overstate `costUsd` for long sessions; worth a dedicated look.

All four fixes are covered by new or extended regression tests; full dashboard suites (backend
`workspace`/`server`/`forge`, frontend `routes/dashboard`/`api/dashboard`) and both packages'
`typecheck` were rerun green after the fixes.

## Local history and recovery

Base: 0e9dfd76. History was squashed to three commits — service/contracts+APIs, cockpit, and
documentation — folding in every fix from both the 2026-09-19/20 follow-ups and this review pass,
rather than carrying fixup commits on top. Original (pre-squash) history is retained at
backup/dashboard-before-review-cleanup-20260920; earlier snapshots remain at
backup/dashboard-before-final-cleanup-20260919 (pre-cleanup head 5a4d6f33) and
backup/dashboard-before-cleanup-20260919.
No main/remote branch, pull request or issue is changed. Nothing is pushed, uploaded or published.
Preview: http://localhost:41226/dashboard?feed=all.

## Final review fixes (2026-09-20)

- Cost snapshots expose optional tzOffsetMinutes; 409 recovery reuses the captured offset,
  falling back to the browser offset only for older responses. Backend reads preserve the
  snapshot's offset even if a subsequent query supplies another.
- Widget order reserves supported-widget slots separately from the 200 unknown-ID budget,
  so normalization remains writable without deleting future widget entries.

Four regression assertions failed before the fixes, then the focused dashboard/workspace
gate passed (29 files / 179 tests). All-workspace typechecks, service/web builds, check:pack
and diff checks pass. Full suite: 7334 passed, one unrelated GitHub template-stacking test
timed out; the entire unchanged GitHub test file passed on isolated rerun (119/119).
This is not reported as a fully green single full-suite run.

Chromium forced snapshot expiry in Europe/Warsaw: initial and recovered requests both used
-120 and windowStart 2026-09-13T22:00:00.000Z. The local preview at port 41226 was restarted
with the new service and rebuilt cockpit. No user layout was changed by this check.
Logs: /tmp/dashboard-two-fixes-{red,targeted,suite,github-recheck,types,web,pack,browser-final}.log.
