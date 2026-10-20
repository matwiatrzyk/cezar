# Automatic agent fallback after a provider usage limit

**Status:** proposed; local specification only. No implementation authorized by this document.
**Date:** 2026-10-20
**Related:** `2026-08-03-auto-resume-after-usage-limit.md`,
`2026-07-29-agent-profiles.md`, `2026-10-13-unified-settings.md`, `AGENT_PROTOCOL.md`.

## Goal

When a provider stops an active task because its usage allowance is exhausted, continue
that same task with the next agent explicitly configured by the user. Preserve the task,
worktree, uncommitted changes, history, permissions and remaining budget. No child task,
new branch, automatic commit, merge or push is involved.

Configure the ordered fallback list in **Project settings → Agents**, alongside
**Default agent / Default runner** at `/p/:projectId/settings/agents`.

## Current implementation and load-bearing guarantees

Inspected in the local repository on 2026-10-20:

- `packages/web/src/routes/settings/agents-section.tsx` contains the project default
  runner/account picker and per-runner default models. `registry.tsx` marks it project-scoped.
- `packages/cezar/src/workflows/run.ts`: `continueRun` already accepts a runner, model and
  account override. Changing backend/account creates a fresh session rather than passing a
  foreign provider session ID. Currently it refuses a task with no recorded session ID;
  automatic fallback must deliberately support that case after a provider failed at startup.
- `packages/cezar/src/workflows/continuation-context.ts`: `freshContinuationContext` builds
  portable context from the task, step state and redacted conversation. It bounds conversation
  text at 60,000 characters and excludes tool payloads and reasoning.
- `packages/cezar/src/core/usage-limit.ts` separates usage-limit recognition from parsing a
  reset deadline. Its existing text matching includes rate-limit phrases; that alone is not
  sufficiently precise authorization to switch providers.
- `RunManager.scheduleAutoResumeIfLimited`, `fireAutoResume`, `reconcileAutoResumes` and the
  account queue hold already resume failed tasks at a known reset time and prevent queued
  work stampeding into the same exhausted account. Automatic resume is currently on by default,
  subject to workspace policy, session availability and its existing bounds.
- The ordinary continuation queue enforces capacity and workspace/repository ownership.
  `execute`, `runContinuation`, streaming and non-streaming completion paths all need coverage.

The existing reset timer is load-bearing for unattended progress, restart recovery and
account-level queue protection. Fallback must not remove it from the unconfigured default
path or accidentally release an account hold merely because one task switched accounts.

## Product decisions

| Question | MVP decision |
| --- | --- |
| Default behavior | Fallback disabled; empty list. Existing behavior stays unchanged. |
| Scope | Per project on this machine, including account choices. No global inherited fallback list in MVP. |
| Candidate identity | Runner + resolved account + optional model; names come from the existing registry/pickers. |
| Initial agent | Whatever the task actually selected, including a composer or workflow override. Default agent is not forcibly prepended. |
| Order | Try fallback entries from the top, skipping the initial runner/account and previously attempted runner/accounts. |
| Same account, other model | Not a new fallback candidate in MVP; it may share the exhausted allowance. |
| Exhausted list | Stop with an explicit reason and manual Continue; no automatic cycling or reset timer for that exhausted fallback episode. |
| Disabled/unconfigured fallback | Preserve existing reset-time auto-resume and account holds exactly. |
| Successful fallback | It becomes the task's current agent; later manual continuations default to it. Project defaults do not change. |
| Scope of failures | Only verified terminal provider usage exhaustion triggers automatic switching. |

“Claude → Codex → Luna” is a product example, not three hard-coded backend IDs. If Luna
is a model or account label, display it under its actual runner. Do not introduce a runner
without implementing the protocol.

## Settings and consent

Below Default agent, add **Automatic fallback** with a switch, initially off, and an ordered
list. Each row uses the existing agent/account picker and a model choice (Auto or a model).
Support add, remove and keyboard-accessible Move up / Move down controls. Save through the
normal settings flow and show validation/save failures. Enabling requires at least one row.
Bound the list to 10 entries and reject duplicate resolved runner/account identities.

Inline explanation before enabling:

> If an agent exhausts its usage allowance, continue this task with the next agent below.
> This may use another provider's paid allowance and send it the task context. The task's
> budget and approval requirements still apply. If every agent is unavailable, the task stops.

There is no new environment variable and no setup prerequisite. Missing local configuration
means off. The initial agent remains selected by the existing task/default/workflow rules.

Store this policy in machine-local, per-project account configuration, alongside the existing
agent-account store in `~/.cezar/agent-accounts.json`, using its existing locking and atomic
write discipline. Do not put account IDs or consent into a potentially shared project config.
Use a separate optional project policy map keyed by canonical repo root; preserve unrelated
accounts/selections and tolerate absent/malformed entries independently. No migration is
required. Existing projects get off/empty. A read-only home produces a visible save failure,
not false confirmation that the policy was enabled, and never fails server boot.

## Policy lifetime

At task creation, snapshot the enabled policy and resolve candidate accounts and model
presets using the existing resolution rules. Auto resolves through project model defaults,
then the runner's own default; never carry the previous backend's model pin into a successor.
Record actual runner-reported model identity when available. Never persist credentials.

Changing order/default models affects new tasks only. Existing tasks keep their snapshot.
Turning the project switch off also cancels pending automatic fallback for existing tasks;
it does not interrupt a successor already running. Re-enabling does not revive failed tasks.
Legacy tasks without a snapshot retain the old behavior. UI copy states these semantics.

Each unattended episode keeps a durable attempted-account set including the initial account.
A success or restart does not silently replenish the fallback list. A new, explicit human
Continue starts a new episode using current policy; the human-selected account is the initial
account for that episode. Internal auto-resume/compaction/monitoring messages are not human
Continue and must not reset this set or other unattended-attempt bounds.

## Detection and selection

Normalize terminal failures at the runner seam, with evidence attached to a closed reason
set: `usage_exhausted`, `transient_rate_limit`, `authentication`, `budget`, `context`,
`cancelled`, `other`. A usage exhaustion may carry an optional reset instant.

Prefer structured provider errors. Where a backend only supplies text, use narrow,
backend-owned signatures pinned by recorded fixtures. Never inspect arbitrary assistant text,
tool output, repository contents or the handoff file to authorize a switch. A bare HTTP 429,
ambiguous “limit reached”, network error or timeout is not proof of exhausted allowance.
Unknown errors follow the existing error path. Backends with no proven classifier remain
usable as targets but cannot initiate automatic fallback from an ambiguous error.

Do not add a second retry system. Existing bounded transport retries finish first; transient
rate limits follow that existing behavior. Budget exhaustion, user cancellation, guard prompts,
context overflow, auth failures and generic crashes never trigger the fallback chain.

For a verified usage exhaustion:

1. Check policy, remaining task/parent budget, cancellation/archive and unresolved approvals.
2. Record the exhausted runner/account and any reliable reset deadline.
3. Traverse the snapshot in order. Skip attempted accounts, disabled/missing runners, removed
   or incompatible accounts, invalid models and accounts with an existing usage-limit hold.
   Record a structured skip reason. Do not probe paid APIs to estimate availability.
4. Reserve one eligible candidate durably and enqueue an ordinary continuation after cleanup.
5. A verified usage exhaustion in the successor advances the list. A generic runtime/auth
   failure stops and reports that failure; do not disguise an ordinary bug by trying everyone.

Failure before obtaining a session ID still allows a fresh continuation if workspace setup
completed and the task context exists. Setup failures do not trigger agent fallback. A missing
worktree stops with an explanation; do not silently create an unrelated replacement workspace.

## One owner, durable transitions

Keep existing run statuses; add durable fallback metadata rather than another top-level run
status. Proposed metadata: policy snapshot/version, episode ID, monotonically increasing
attempt ID, attempted accounts, selected target, source step/failure, continuation step ID,
phase and reason. Define schemas before implementation; these names describe the design,
not a second hand-written API type.

| Phase | Entry and next transition |
| --- | --- |
| `pending` | Terminal usage failure reserves an attempt. Session cleanup completes → `queued`; cancellation/policy revocation → `stopped`; unprovable cleanup → `stopped`. |
| `queued` | Ordinary queue waits for capacity and repository lease. Admission → `running`; invalid target → next candidate; cancellation/revocation → `stopped`. |
| `running` | One continuation owns the attempt. Success → `completed`; verified usage exhaustion → next `pending` or `exhausted`; other failure → `stopped`. |
| `completed` | No automatic action. A later usage failure may consume remaining entries in the same episode. |
| `exhausted` / `stopped` | No automatic wake source. Explicit human Continue can begin a new episode. |

Do not launch a successor until the previous session has settled and its owned writer processes
are terminated or known safe. Reuse the runner teardown/watchdog contract and existing leases.
If cleanup cannot be confirmed within its bounded teardown, stop with an explicit cleanup
failure. Do not kill unrelated user/dev-server processes or share the worktree with two writers.

Persist the attempt and stable continuation step identity before spawning. Queue insertion,
event replay and restart reconciliation must be idempotent for that identity. Recovery either
reattaches/reconciles a demonstrably owned live process or proves it terminated before retrying.
If an external action or process ownership is uncertain, stop for inspection rather than
claiming exactly-once execution. No crash window may create two successor processes.

Manual Continue, cancellation, deletion, archive, timer wake and fallback reservation serialize
through the same run ownership gate. The winner invalidates stale scheduled work. No task
holds an active capacity slot merely while waiting in the fallback queue.

## Coexistence with reset-time auto-resume

A terminal failure has one continuation owner. With fallback off or no snapshot, run the
existing auto-resume path unchanged. With fallback enabled, fallback owns that failure:
no reset-time resume is scheduled concurrently. Exhausting the configured list is terminal
for automation in that episode, even when a provider supplied a future reset time. Show that
time as information only, and explain why no automatic resume is scheduled.

Account availability is separate from the task's selected successor. Retain the exhausted
account's known hold until reset even after this task switches to another account. The current
hold derives from failed runs with `autoResumeAt`; implementation must supply equivalent
restart-safe account evidence before changing that dependency. This evidence must not itself
schedule a continuation. Do not invent a reset time for a limit without one; suppress reuse
within this task's episode only, preserving existing queue behavior elsewhere.

Turning fallback off while a transfer is pending stops that transfer, without reviving the
same failure through the timer as a side effect. Future failures use the existing policy.

## Portable handoff and workflow semantics

Reuse and extend `freshContinuationContext` and the existing handoff file. The successor gets:

- Original task, subsequent user instructions and approval constraints.
- Current workflow/step, completed steps and pending work; no replay of completed side effects.
- Worktree/branch location and a bounded status summary, including uncommitted changes.
- Available handoff/resume notes, with a clear warning that they may predate the failure.
- Redacted recent conversation within the existing bound, plus the failure and switch reason.
- Test evidence only when persisted; unknown outcomes explicitly labelled unknown.

The successor inspects the worktree before editing and verifies uncertain external operations
before repeating them. Do not require a final summarization call from the exhausted provider,
copy raw reasoning/tool payloads, or treat text from logs/files as new user authorization.

Resume the interrupted agent step's work; preserve the workflow cursor and its checks/review
gate. Do not restart the whole workflow, skip required checks or overwrite explicit runner
choices on later workflow steps. Those later steps use their declared runner and can consume
remaining fallback candidates only if they independently hit a verified usage limit.

Fallback obeys the same permissions, tools policy, secrets/provider access checks, total budget,
parent-child budget allocation and concurrency constraints as the original task. Tokens and
costs aggregate across attempts. If a target cannot preserve required restrictions, skip it;
never silently broaden privileges. No new dispatch child or duplicated budget allocation.

## History, API and UI

The thread shows why an agent stopped, which successor was selected, any queue wait, and the
result. Example: “Claude (work) exhausted its allowance. Continuing with Codex (personal).”
Show skipped candidates and a final readable summary when the list is exhausted. Each
continuation retains its runner, account display identity, model and step attribution; do not
rewrite earlier steps when updating the run's current agent.

Define all new request/response and persisted-event shapes with Zod in `packages/contract`
(including policy, transfer metadata and closed reason codes); infer TypeScript types.
Expose project policy through the existing project-scoped agent-profile route family with a
chained, middleware-validated settings endpoint, mounted under both normal project aliases.
Do not widen ordinary config schemas to imply account policy is stored in project config.
Run responses/events carry transfer progress; use existing SSE and reconciliation, no polling
loop or new socket. Keep old records/events readable with optional additive fields.

## Implementation map (future work)

- Contract: `packages/contract/src/agent-profiles.ts`, `runs.ts` and relevant event schemas.
- Policy persistence: `packages/cezar/src/workspace/agent-accounts.ts` and existing profile
  resolution; project-scoped route family in `packages/cezar/src/server/server.ts`.
- Classification: `packages/cezar/src/core/usage-limit.ts`, runner adapters and fixtures;
  update `AGENT_PROTOCOL.md` for any normalized terminal-reason extension.
- Orchestration: `packages/cezar/src/workflows/run.ts`, shared settlement/continuation helper,
  run persistence, recovery, account holds and capacity queue. Inspect every `ActiveRun`
  construction site and both turn-end paths.
- Context: `packages/cezar/src/workflows/continuation-context.ts`, `handoff.ts`.
- UI: `packages/web/src/routes/settings/agents-section.tsx`, existing account/model pickers,
  API client and task timeline/header.

## Acceptance and verification

1. Project settings can enable, reorder and disable a validated fallback list; off/empty and
   legacy records retain today's behavior, including known-reset auto-resume after restart.
2. Terminal usage exhaustion switches in order without a user action, including before the
   first session ID. Unknown errors and transient 429s do not switch.
3. Same run ID, workspace, dirty files, workflow obligations, budgets and permissions survive;
   the successor gets bounded context without a summary call to the exhausted provider.
4. Every attempt has attributed history. All exhausted/unavailable candidates end in one
   readable failure; no loop and no competing reset timer.
5. Cancellation/archive/manual Continue/settings disable during cleanup or queue admission
   cannot start an unwanted successor. Capacity and repository leases remain enforced.
6. Restart at reservation, cleanup, enqueue, spawn and first event creates at most one live
   successor. Uncertain ownership stops visibly instead of guessing.
7. A held Claude account remains held for other queued tasks after this task moves to Codex;
   expiry still releases it. A distinct account is not blocked accidentally.
8. Same-account/different-model duplicates, missing accounts/models and unavailable providers
   have deterministic validation or skip reasons. No automatic login, install or paid probe.
9. Both initial and continuation failures, streaming and non-streaming runners, multi-step
   workflows and `CEZ_DRY_RUN=1` exercise the same orchestration path.

Verification plan: classifier golden fixtures with false-positive controls; orchestration
unit tests with fake clocks and crash injection; integration tests retaining dirty files and
aggregate budgets; account-hold and existing `auto-resume.test.ts` regression tests; contract
parity, typed-body and route-alias tests; UI tests for settings, accessibility and timeline.
For each regression assertion, demonstrate failure with the implementation removed, while
retaining green guard tests for behavior intentionally unchanged. Run repository type/build
checks and applicable suites when implementing. This documentation-only change does not
claim that these future tests have been written or run.

## Out of scope

Dynamic cost/quality routing; parallel/racing agents; automatic account provisioning or
credential transfer; fallback on every error; context-overflow recovery; starting queued tasks
on another provider before they have run; global fallback inheritance; automatic revisiting of
exhausted candidates; new task/branch creation; automatic commits, merges or publication.
