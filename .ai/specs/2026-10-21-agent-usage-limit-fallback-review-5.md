# Fallback verification after latest main merge

Date: 2026-10-21. Original review verdict: **changes required** (three confirmed P2 gaps).

**Repair status:** all three findings addressed locally in the follow-up below.

## Reviewed version and scope

Fetched upstream/main at `08dc8428` (trunk-based projects, #1597) and merged it locally as
`7cdf525d` on `cez/50cf615c`. The sole textual conflict was the server import block; both
`setFallbackProviderCheck` and `checkoutGitStatus` were retained. No push.

An independent Codex task `cf9b9994` reviewed the committed merge read-only. Its branch has no
source diff. Its two findings were reproduced locally with additional temporary Vitest tests,
not accepted solely on the reviewer's report. The third finding was independently reproduced
through the real HTTP app. The temporary failing probes were removed after recording evidence;
their behavior and reproduction steps are below. Existing suites do not cover these failures.

The agreed scope remains new tasks with an enabled snapshot, quick-task/final v1 steps only.
Graphs and earlier workflow steps keep existing reset-time resume; this is intentional.
No new default-off or trunk/checkout regression was found in the reviewed paths.

## Confirmed findings

### P2 — Revocation during pending selection resumes automatically after restart

`packages/cezar/src/workflows/run.ts:2886`: when recovery sees a queued pending fallback whose
consent is revoked, `scheduleAutoResumeIfLimited` retires the episode but falls through to
`armAutoResume`. Revision 4 instead promises that disabling an already queued handover stops it
for human intervention. This differs from a later ordinary failure after revocation, for which
existing auto-resume is intentional.

Reproduction using the existing fallback-run fixture: enable a policy; create a run with its
snapshot, a future Claude usage-limit error, a failed agent step with a session id, status queued,
and `fallbackEpisode: {pending:true, attempted:['claude:default']}`. Disable the policy through
`putAgentFallbackPolicy`, instantiate RunManager and await `recover()`. Assert `autoResumeAt`
is undefined: it fails because a reset-time timestamp was armed. Confirmed by both reviewer
runtime probe and local Vitest probe. Fix should stop after retiring this pending episode while
preserving ordinary revoked-before-failure and default-off auto-resume.

### P2 — Removing the completed task releases an exhausted account before reset

`packages/cezar/src/workflows/run.ts:3370`: `accountHolds()` derives fallback holds solely from
extant run records. Deleting the completed task removes the only copy of its unexpired hold,
allowing other tasks onto the exhausted account. The design requires account holds to outlive
source-task deletion, not merely source-task completion.

Reproduction: a done Codex run has no autoResumeAt and has
`usageLimitHolds: [{account:'claude:default', until: now + 1 hour}]`. Before `store.deleteRun(id)`,
`manager.accountHolds().deadline.has('claude:default')` is true; afterwards it is false.
The assertion that it remains true fails in both the independent runtime probe and local test.
Account-level durable storage or another deletion-independent owner is needed.

### P2 — Missing registered project still serves fallback policy

`packages/cezar/src/server/server.ts:2155,2478`: projectRootFor returns the registered root
without checking that it exists. GET then returns policy/defaults with 200. The spec's API
contract explicitly requires 409 for a missing registered root. PUT uses the same resolution.

Reproduction in the real agent-profiles API test fixture: register repoRoot, construct the app,
remove repoRoot, request GET `/api/v1/workspace/agent-profiles/fallback-policy?projectId=<id>`.
Expected 409, actual 200. Local Vitest probe confirmed it. A fix must also distinguish this 409
from hosted mode in the UI: the current load-error branch treats every 409 as local-only.

## Verification

- `npm run typecheck`: passed on the merged source.
- `npm run test:unit`: 42 passed; `npm run build` and pack gate passed; `npm run test:package`: 25 passed.
- Full isolated `npm test`: 659 files passed / 1 skipped; 11,101 tests passed / 4 skipped.
- Fallback + trunk integration suites: 30 passed, including a new retained test that a project
  with `taskWorkspace: 'in-place'` keeps the same task and checkout across fallback, does not
  create a worktree, stays on main and does not enter landing during reservation.
- Independent reviewer: seven focused suites, 82 tests passed, and typecheck passed.
- Three additional diagnostic assertions failed as described above (not failures in the normal
  committed test suite). Logs: `/tmp/fallback-main-runtime-probe.log` and
  `/tmp/fallback-main-api-probe.log` in this environment.
- Chromium against the merged UI with stubbed API: desktop, 375px mobile, light/dark, activation,
  keyboard reorder; one switch, no horizontal overflow, disabled opacity 0.5, focus retained.
- Limits: no real paid-provider exhaustion or cross-provider billing was exercised. Engine tests
  use the bundled dry-run backend; browser checks use controlled API responses.

This verification updated the spec's stale revision header and description of the enable control.
It does not fix the three newly confirmed findings or claim that the complete original design
(all older sections, including graph-node transfer) has been implemented.

## Repair follow-up

All three reproduced failures now have retained regression coverage. Runtime tests failed on
both old behaviors before the fix; API/UI tests failed in five corresponding cases before repair.

- Retiring pending selection returns immediately and records a completed episode. Completed
  episodes cannot arm reset-time resume during subsequent recovery. A guard test preserves
  ordinary auto-resume when consent was revoked before a later failure.
- Account holds persist independently in immutable per-account/deadline entries under
  `~/.cezar/agent-usage-holds/`. Deterministic hashed keys and atomic writes let concurrent
  writers retain distinct deadlines without read/modify/write races. Managers import active
  historical run holds before deletion and restore expiry wakeups. Tests cover task deletion,
  manager restart, expiration, independent writers, malformed entries and unwritable homes.
- Both fallback-policy endpoints check that the registered root is a directory before policy
  access. Missing roots return409; unknown projects remain404; hosted requests remain409 before
  local reads. UI distinguishes the exact hosted message from a missing-root error and supports
  Retry after restoration. API tests prove rejected PUT leaves policy unchanged.

The API/UI child diff was inspected and its 74 tests independently rerun before local merge.
Runtime/store/auto-resume focused suites: 48 passed. No push.

Final repair validation: full vitest 11,115 passed / 4 skipped (660 files passed / 1 skipped);
typecheck, build and pack gate passed; node unit 42 passed; package 25 passed. An additional
expiry-wakeup regression was then added and passed; final four affected suites passed 102 tests
and server typecheck passed again. Chromium with controlled API responses confirmed the missing
folder message, absence of the hosted explanation, and successful Retry after restoration.
No repository source changed after these checks. All work remains local, without a push.
