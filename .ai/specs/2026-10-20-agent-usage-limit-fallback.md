# Automatic agent fallback after a provider usage limit

**Status:** Implemented locally (revision 4); release scope is single-step tail fallback only.
**Date:** 2026-10-20, revised 2026-10-21
**Revision:** 4 — records review-4 corrections and the Settings convention follow-up; Revision 4 supersedes conflicting historical design sections below.
**Related:** `2026-08-03-auto-resume-after-usage-limit.md`,
`2026-07-29-agent-profiles.md`, `2026-10-13-unified-settings.md`, `AGENT_PROTOCOL.md`.

## Goal

When a provider stops an active task because its usage allowance is exhausted, continue
that same task with the next agent explicitly configured by the user. Preserve the task,
worktree, file contents, history, permissions and remaining budget. No child task, new branch,
extra fallback-specific commit, merge or push is involved. Existing autosave/checkpoint behavior
stays intact, including check-artifact exclusions; file contents survive but files need not
remain uncommitted after an existing autosave.

Configure the ordered fallback list in **Project settings → Agents**, alongside
**Default agent / Default runner** at `/p/:projectId/settings/agents`.

## Release scope

The MVP applies only to conversational task continuations. Workflow graph execution is deliberately
unchanged from `main`: graph runs keep the existing reset-time auto-resume behavior and do not use
the fallback list. Node-scoped graph transfer remains a separate future feature. The Settings UI
states this limitation explicitly so enabling fallback does not imply graph takeover.

## Revision 4 — corrections after the merged-branch review

This section supersedes conflicting Revision 3 descriptions.

- Exhaustion includes Claude's session/hourly and “hit your limit” messages. Explicit billing
  exhaustion (`insufficient_quota`, “exceeded your current quota”) takes precedence over HTTP 429;
  transient rate-limit messages still do not transfer a task.
- A reserved successor that fails without assistant text or tool use is a failed launch, even if a
  session id was assigned before spawn. Try the next candidate; once all candidates are exhausted,
  stop with the danger summary (acceptance criterion 6), rather than restarting the same chain.
- Identify the exhausted account using the failed step's backend/profile. Disabled providers are
  rejected in the engine; the cockpit additionally supplies its provider/account connection gate.
  Check again before spawn, including account existence and consent, because the queue may wait.
- Admission stops after manager disposal and preserves its durable episode across restart.
  `fallbackEpisode.done` distinguishes a settled exhausted list from an interrupted admission.
- Policy writes serialize reclamation and the synchronous read/modify/write transaction under a
  `proper-lockfile` guard, using the existing dependency and the existing pid/start identity lock.
  The guard expires after a crash; no configuration or manual lock repair is required.
- Auto explicitly clears the previous model pin. Disabled policies are not stored on new runs.
  The exhaustion summary lists reset times of all known unexpired account holds.
- Handover lines use the non-dim `info` tone and the same lowercase provider/account naming as
  Settings. The automatic instruction bubble identifies cezar as its author and omits internal
  environment-variable names; the actual successor prompt retains its detailed instructions.
- Settings explains that order changes apply to new tasks and that tool permissions depend on the
  backend. A single header switch enables the saved list; its Off state explains that the list is
  not yet used. Reordering retains focus and announces its new position. Load errors offer Retry;
  failed saves retain the selected agent. Locked models use native settings; previously pinned rows
  explain how to replace them. The default-account note follows project and machine selections.
  Context sharing and potential charges stay visible; scope and permissions are expandable.

Deliberate retained behavior: graph workflows and earlier workflow steps keep their existing
reset-time resume. Disabling a queued handover stops it for a human; it does not silently launch
another provider or re-enable an automatic episode. Account holds persist to their reset time.
The failed agent step remains in history, but its task now publishes `queued` with
`fallbackEpisode.pending: true` atomically before asynchronous selection. The canonical attention
label is “switching agent”, with no attention request or failure notification. Admission begins
only after the old agent releases its leases. Reservation clears `pending` and continues through
the ordinary queue; exhaustion or an unexpected admission error settles `failed` once. Cancellation
settles `cancelled`. Disabling fallback is rechecked before reservation. Recovery and the queue
watchdog resume selection rather than restarting the workflow; disposal leaves durable selection
for the next manager. The pending flag is optional; old records and fallback-off behavior remain
unchanged. No new run-status enum value is introduced.

## Revision 3 — what is implemented

Decisions taken while fixing review 3, binding over the design sections below:

- **Who owns a failure.** `RunManager.claimAgentFallback` claims a failed run only when ALL hold:
  the run's own `fallbackPolicy` snapshot is enabled (a run without a snapshot — created before the
  feature — never uses fallback); it is not a graph run; the failed step is an agent step that is
  the task's last (a `continue-*` step or the final step of a v1 file — a file with steps still
  ahead keeps the main behaviour, since a continuation would skip them); the error is a proven
  exhaustion (`isUsageExhaustion`) or the reserved successor failed before producing a session; and
  the snapshot's consent is still live (incarnation + revocation match the stored policy). In every
  other case the reset-time auto-resume runs exactly as on `main`. A revoked snapshot logs one note
  and falls through to that path; it does not block it.
- **Detection.** `isUsageExhaustion` accepts Claude's marker, or prose naming an exhausted
  allowance (`usage/weekly/monthly/daily/5-hour limit`, `quota exceeded/reached`,
  `insufficient_quota`, `out of credits/quota`) that does not also read as a throttle (`rate limit`,
  `per minute`, `too many requests`, `429`). `isUsageLimitMessage` is unchanged and still drives
  telemetry and auto-resume.
- **Episode state is structured.** `RunRecord.fallbackEpisode = {attempted, current?}`: every
  `provider:account` already tried — the task's starting agent included, so a chain never returns
  to an exhausted agent — and the reserved successor's `continue-N` step. `attempted` is persisted
  before each candidate's continuation is created (the reservation). A human Continue clears the
  episode; unattended resumes keep it.
- **Candidate admission.** `eligibleFallbackCandidates` skips, with a transcript note, accounts on
  hold and named accounts that no longer exist for that provider (fail closed — never the default
  login instead; an unreadable accounts file fails every named account). A synchronous
  `continueRun` refusal skips to the next candidate; a successor that fails before it has a session
  is treated the same on its own failure. `resolveProfileEnvForRoot` is unchanged from `main`.
- **Holds.** `RunRecord.usageLimitHolds[]` keeps each exhausted account held until its own reset,
  whatever the task does afterwards; `accountHolds()` publishes them through the shared semaphore
  (so other projects see them too), and a timer pumps the queue when one lapses.
- **Exhaustion.** When no candidate is left, one danger-toned lifecycle line names the reason (and
  the original agent's reset time when known) and the task stays failed for a human. No
  reset-time resume is armed, matching acceptance criterion 6.
- **Restart.** A reserved successor with no session re-queues as a fresh continuation (never a
  workflow restart). A queued successor whose consent was revoked before it started is failed
  with that reason instead of starting.
- **Fresh session.** `continueRun` opens a session-less continuation only for the engine's own
  fallback call (`internal.freshSessionAllowed`); the HTTP Continue still refuses with
  `no agent session to resume`.
- **Store.** `~/.cezar/agent-fallback.json`, keyed by realpath'd project root. The lock is a
  directory renamed into place with its owner (pid + kernel start tick) inside; a lock whose owner
  is dead or a different process, or an owner-less lock older than 30 s, is renamed aside and
  reclaimed. GET answers exactly the contract shape. PUT validates accounts only for rows being
  added, so switching off or removing a row whose account was deleted always works.
- **Transcript.** One line per hand-over: `Claude reached its usage limit — Codex (Work) · gpt-5
  continues this task`. Skips are notes; exhaustion and revoked-before-start are `tone: 'danger'`.
  The successor's opening prompt is a user-message bubble, as the auto-resume and restart prompts
  already are.

### Settings → Agents → Automatic fallback — handoff

**Intent**: let the user list, in order, the agents that take a task over when its agent's usage
allowance runs out. **Non-goals**: picking the "best" agent; graph workflows.
**Actor and trigger**: a local-cockpit user on `/p/:projectId/settings/agents`, below Default agent.

| State | Trigger | What the user sees | What they can do |
|---|---|---|---|
| Loading | GET pending | "Loading fallback settings…" | wait |
| Hosted / 409 | GET 409 | "Automatic fallback is available on a local cockpit only." | nothing |
| Load error | other GET error | "Fallback settings did not load — <message>" | reload |
| Empty | no rows | Switch off and disabled, "Off — add an agent first"; "No fallback agents yet. Add the agent that should take over first." | add an agent |
| Listed | rows | `1. codex · Work · auto model` with ↑ ↓ ✕ (`Move codex · Work up`, `Remove codex · Work from fallback`) | reorder, remove, toggle |
| Row will be skipped | account deleted / provider disabled / not connected | red line under the row: "Account removed — will be skipped" (or "Provider disabled — …", "Not connected — …") | remove it; switching off still works |
| Full | 10 rows | add controls disabled, "Up to 10 agents." | remove one |
| Conflict | PUT 409 (revision moved) | toast "Fallback settings changed elsewhere — reloaded. Try again." and the section refetches | repeat the edit |

The "Agent to add" select lists only agents not yet in the list (every runner's Default login plus
its extra accounts); "Model for the agent to add" offers `auto (default)` plus the runner's
catalog. A fixed paragraph states the terms: the next provider receives the task and its repository
context and may bill its own plan; budgets and approvals still apply; each agent is tried once and a
task's own agent is never its own fallback; single-step tasks started after switching on only;
workflow graphs keep waiting for the reset; when no agent can continue the task stops and waits.

Acceptance (UI tests in `packages/web/src/routes/settings/agents-fallback.test.tsx`): an empty list
keeps the switch disabled; adding sends the current revision and removes the option from the
picker; reorder/remove buttons are named per row; removing the last row switches off; a removed
account is marked and the switch still turns off; a 409 refetches so the next edit carries the new
revision; a hosted cockpit explains the absence.

## Current implementation and load-bearing guarantees

Inspected in the local repository on 2026-10-20:

- `packages/web/src/routes/settings/agents-section.tsx` contains the project default
  runner/account picker and per-runner default models. `registry.tsx` marks it project-scoped.
- `packages/cezar/src/workflows/run.ts`: `continueRun` already accepts a runner, model and
  account override. Changing backend/account creates a fresh session rather than passing a
  foreign provider session ID. Currently it refuses a task with no recorded session ID;
  both automatic fallback and manual recovery must support that case after provider startup
  failure in a prepared workspace. Ordinary Continue settles the task on success: it does NOT
  resume the graph. Fresh-session tool resolution currently uses the last agent step, so it
  cannot be reused unchanged for a transfer of an earlier graph node.
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
| Order | One forward pass using a durable cursor; every skipped or attempted entry is consumed for this episode. |
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

Store policy separately from account credentials in a new machine-local file,
`cezarHomeDir()/agent-fallback.json`, keyed by canonical project repo root. This isolates
policy from existing account writers: `mergeWriteAgentAccounts` uses atomic replacement but
has no cross-process read-modify-write lock. Do not assume otherwise or add policy writes to
that file. Account IDs are references; credentials remain in the account system.

The new store owns ALL its writes through one bounded cross-process lock, re-reading under
the lock and atomically replacing at mode 0600. Use a unique lock owner token and process
start identity; reclaim only a demonstrably dead owner, never based solely on lock age. An
uncertain/still-live owner or lock timeout returns a retryable save error. Preserve unrelated
project entries and unknown fields; salvage malformed project entries independently as off.
Missing/corrupt state means off and must revoke old snapshots, not reconstruct their consent.
The file contains an opaque store incarnation, project revocation token and revision counter;
a rebuilt store uses a new incarnation. All reads/writes resolve through `cezarHomeDir()`.

No migration or manual file setup is required. A read-only home leaves boot working but a save
fails visibly. Never acknowledge enable/disable before the atomic write succeeds. A concurrent
account edit cannot overwrite this separate policy. Concurrent policy PUTs use expected revision
and return 409 on conflict rather than silently restoring an old enabled value.

## Policy lifetime

At task creation, snapshot the enabled policy and candidate account choices. An explicitly selected
fallback model is part of that snapshot. For `Auto`, resolve the model when the takeover is
admitted, using the then-current project model default and finally the runner's own default; this
keeps the zero-configuration path usable when a runner adds or retires a model between task
creation and takeover. Never carry the previous backend's model pin into a successor. Record
actual runner-reported model identity when available. Never persist credentials.

Changing order and explicit model choices affects new episodes only. An existing episode snapshots
its candidates plus store incarnation and project revocation token. `Auto` intentionally follows
the model default that is available at admission, so changing a default can affect a takeover
that has not yet been admitted. Turning the switch off rotates
that token and revokes ALL existing episodes, including active tasks' future transfers. It
cancels queued/pending transfers but does not interrupt a successor already running. Re-enabling
never restores old authority. New task creation or explicit human Continue may snapshot current
policy. An ordinary message to a live session, reports, monitoring and compaction do not renew
consent or reset fallback bounds. UI copy states this distinction.

Read current policy at failure reservation and again at admission immediately before spawn.
Serialize final admission with enable/disable using the policy lock: persist the launch claim
while authorized, then release the lock. This claim is the launch linearization point; disable
cancels unclaimed intents, while an admitted launch counts as already running. Before reporting
successful disable, reconcile local queued intents; other processes must still check the durable
token. A missing/unreadable policy denies fallback admission. Snapshot mismatch never invokes
fallback, even after restart or off → on. Legacy tasks without snapshots keep existing behavior.

Each episode persists a forward-only candidate cursor, visited outcomes and used runner/accounts.
Record the actual account at every workflow agent launch, including explicit step overrides.
A skip consumes an entry permanently for this episode. Reserve and advance the cursor atomically
with the attempt intent. A success/restart does not replenish it; ordinary workflow steps can
still use their declared account again, but automatic fallback cannot revisit a used account.
For A skipped → B exhausted → A available, the next candidate is C, never A.

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
3. Traverse from the persisted cursor. Skip used accounts, disabled/missing runners, removed
   or incompatible accounts, invalid models and accounts with an existing usage-limit hold.
   Record a structured skip reason. Do not probe paid APIs to estimate availability.
4. Reserve one eligible candidate durably and enqueue a typed transfer intent after cleanup:
   `graph-node` for interrupted workflow work, `tail` for a conversational continuation.
5. A verified usage exhaustion in the successor advances the list. A generic runtime/auth
   failure stops and reports that failure; do not disguise an ordinary bug by trying everyone.

Failure before obtaining a session ID still allows a fresh continuation if workspace setup
completed and the task context exists. Setup failures do not trigger agent fallback. A missing
worktree stops with an explanation; do not silently create an unrelated replacement workspace.
A task intentionally running without a worktree uses its original repo root and existing lease.

Manual Continue after startup exhaustion must use the same fresh-session path when there is no
session ID, with current policy and explicit user-selected agent. It preserves graph obligations
through a `graph-node` intent, or uses `tail` if none remain. Validate workspace setup, ownership
and approvals first. Failed setup keeps its existing setup recovery flow. A missing retained
worktree uses existing explicit lifecycle recovery before continuation, never silent repo fallback.
Test exhaustion before all session IDs followed by a successful manual recovery on the same task.

## One owner, durable transitions

Keep existing run statuses; add durable fallback metadata rather than another top-level run
status. Proposed metadata: policy snapshot/version, episode ID, monotonically increasing
attempt ID, candidate cursor, visited outcomes, used accounts, selected target, source
node/step/failure, transfer kind, resolved step policy, graph cursor/version, attempt step ID,
phase and reason. A graph override is attempt-local; updating the displayed current agent must
not lose the original node policy. Define schemas before implementation; these names describe the design,
not a second hand-written API type.

| Phase | Entry and next transition |
| --- | --- |
| `pending` | Terminal usage failure reserves an attempt. Session cleanup completes → `queued`; cancellation/policy revocation → `stopped`; unprovable cleanup → `stopped`. |
| `queued` | Ordinary queue waits for capacity and repository lease. Admission → `running`; invalid target → next candidate; cancellation/revocation → `stopped`. |
| `running` | One continuation owns the attempt. Success → `completed`; verified usage exhaustion → next `pending` or `exhausted`; other failure → `stopped`. |
| `completed` | Attempt result committed; graph work continues through its next edge, or the tail settles normally. A later usage failure can consume remaining entries. |
| `exhausted` / `stopped` | No automatic wake source. Explicit human Continue can begin a new episode. |

Map phases to run state explicitly: `pending` keeps the terminal source failure (`failed`,
no current step); `queued` uses run `queued` with its durable target attempt ID; admitted/running
uses run `running`, with existing waiting/monitoring states while the session parks. `completed`
is attempt metadata, not proof the task is done: the graph or tail controls run settlement.
`exhausted`/`stopped` is `failed` except explicit cancellation stays `cancelled`; archive retains
its existing representation. Never clear a newer owner's current step during old-attempt cleanup.
Recovery scans nonterminal transfer intents independently of the existing live-status scan, so
pending intents on failed records are reconciled too.

Do not launch a successor until the previous session has settled and its owned writer processes
are terminated or known safe. Reuse the runner teardown/watchdog contract and existing leases.
If cleanup cannot be confirmed within its bounded teardown, stop with an explicit cleanup
failure. Do not kill unrelated user/dev-server processes or share the worktree with two writers.

Persist the attempt and stable continuation step identity before spawning. Queue insertion,
event replay and restart reconciliation must be idempotent for that identity. Recovery either
reattaches/reconciles a demonstrably owned live process or proves it terminated before retrying.
If an external action or process ownership is uncertain, stop for inspection rather than
claiming exactly-once execution. No crash window may create two successor processes.

This needs new durable launch ownership, not just the existing in-memory owner token or process
usage registry. Persist a `launching` claim before spawning, scoped to run/episode/attempt and
protected by a cross-process per-run ownership lock. Record manager boot identity, provider PID
and OS process start identity when available. PID alone never proves identity (PID reuse).
Recovery of a queued claim with no launch claim is safe to enqueue. Recovery after `launching`
without provable teardown, including spawn-before-PID-persist, stops as `ownership_unknown`;
it MUST NOT automatically spawn again. A known live predecessor is not reattached unless the
runner explicitly supports it; otherwise require confirmed teardown before replacement. On
platforms without reliable identity evidence, use the same conservative stop. Manual Continue
cannot bypass unresolved ownership; require explicit verified teardown first. Guarantee at most
one automatic writer, not exactly-once external operations or universal automatic crash recovery.

Manual Continue, cancellation, deletion, archive, timer wake and fallback reservation serialize
through the same run ownership gate. Use a fixed lock order: run ownership, then policy; never
acquire run ownership while holding the policy lock (disable commits revocation, releases it,
then reconciles runs). Hold-store updates finish before admission and never nest with policy
locks. The winner invalidates stale scheduled work. No task
holds an active capacity slot merely while waiting in the fallback queue.

## Coexistence with reset-time auto-resume

A terminal failure has one continuation owner. With fallback off or no snapshot, run the
existing auto-resume path unchanged. With valid fallback authorization and a verified terminal
usage exhaustion, fallback owns that failure:
no reset-time resume is scheduled concurrently. Exhausting the configured list is terminal
for automation in that episode, even when a provider supplied a future reset time. Show that
time as information only, and explain why no automatic resume is scheduled.

Account availability is separate from the task's selected successor. Keep existing derived
`autoResumeAt`/in-flight holds for the default path. New fallback-owned exhaustion evidence lives
in `cezarHomeDir()/agent-usage-holds.json`, keyed by runner/resolved account with source attempt,
observation time and validated reset deadline. It uses the same bounded lock/atomic-store
requirements as the policy store and contains no credentials. It survives task cancellation,
archive, deletion and project removal until expiry; those actions cancel task work, not a known
provider limit. Merge valid evidence conservatively using the latest deadline; use existing reset
bounds, never invent a reset time. Missing/corrupt evidence degrades to existing holds without
reviving a task. If recording new evidence fails, stop that transfer visibly rather than claim
restart-safe protection. No-deadline exhaustion suppresses reuse only within the episode.

The workspace coordinator owns one timer for the earliest new hold expiry. On expiry it prunes
expired evidence, refreshes semaphore holds, pumps all registered managers and arms the next
expiry. Boot and manager registration reconcile the store. Each local process using the shared
store reconciles on pump/admission and through the existing queue watchdog; another process's
write therefore cannot leave its queue permanently asleep. Timer loss is repaired by watchdog
reconciliation. No timer callback creates a continuation. A sleeping queue can be justified only
by a real deadline with an armed expiry owner, active work or existing capacity/lease constraints.
Update `rescueStalledQueue` to recognize this wake source instead of looking only at auto-resume.

For MVP, success does not shorten a new hold: retain it to its validated deadline, even if an
already-running same-account task succeeds. Success on another account never releases it.
Combine these independent holds with existing holds without changing the latter's semantics.
Test expiry with no unrelated events, across projects and restarts, and after source deletion.

Disabling fallback stops unclaimed transfers without scheduling reset-time resume for that same
failure. Later failures in a running session use the existing auto-resume policy when its snapshot
has been revoked. `exhausted`/`stopped` intents remain excluded from timer reconciliation until
explicit human Continue begins a new episode.

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

Every newly collected context source (handoff text, filesystem summary, errors and test evidence)
passes the existing run-secret redactor before persistence/delivery. Original task and explicit
constraints are mandatory; if they exceed a target's input capacity, stop with `context_too_large`
instead of truncating them silently. Bound optional text to the existing 60,000-character budget:
prioritize current node/graph state and latest user corrections, then handoff/status, then newest
conversation. Label truncation and stale handoff timestamps. Replay persisted user attachments
through the existing attachment/content-block pipeline with stable IDs, never duplicate them as
new uploads. A missing or unsupported attachment required by the task stops transfer visibly.
Do not infer credentials from native CLI files while constructing the handoff.

### Graph-node transfer versus conversational tail

Persist a `graph-node` intent with the interrupted node ID, graph state/version, rendered prompt,
inputs, resolved tools policy, verdict expectations, loop counters and successor attempt ID.
Resume only that node with a backend/account override scoped to the attempt. Obtain tool grants
from THAT node, not the definition's final agent step. Feed the successor's output/verdict into
the existing graph result handler using its actual backend/session; commit result and cursor
advancement idempotently against the attempt ID. Continue downstream checks/review nodes once.
Do not call `settleSuccess` until the graph reaches its normal terminal path. Ordinary graph
execution and its effectful nodes retain existing recovery limits; uncertain external effects
stop for inspection rather than claiming exactly-once execution.

Verified usage exhaustion with valid fallback policy is handled BEFORE graph failure edges or
retry loops. Exhaustion/stop of that episode parks the task as failed, without following a graph
retry edge that could recycle candidates. Generic errors keep normal graph behavior. With
fallback off, all existing graph error behavior remains unchanged. Later explicit node runner
choices are preserved; nodes inheriting the task runner use the current agent. Each node records
its actual resolved account before attempting work. A `tail` intent alone may reuse ordinary
continuation settlement, with the originating step's resolved tools policy persisted explicitly.

Retain immutable per-attempt history with parent node ID, backend/account/model and usage.
Logical node completion aggregates its attempts without overwriting them or counting both the
node aggregate and attempt costs in the run total. Deduplicate usage events by attempt/event
identity. Apply existing budget gates to the cumulative known spend and outstanding child
reservations at reservation, admission and normal turn boundaries. Missing usage stays unknown,
not zero; preserve existing accounting limitations and do not promise a hard monetary ceiling
when a provider does not report cost. No budget reset or new child allocation on transfer.

Explicit step tool allowlists, Bash restrictions and approval requirements are required policy,
not advisory hints. Resolve them from the source node/intent and check the target's enforcement
capabilities before selection. Prompt/model preferences alone are advisory. Default unrestricted
tasks need no invented tool restriction. A target that cannot enforce a required restriction is
skipped with a capability reason; only Claude currently honors `allowedTools` at the existing
seam, so cross-backend eligibility must not be assumed. Preserve workspace grants and existing
secret/provider access checks. Required MCP/tool availability must be checked as well.

Account snapshots are stable local profile references, not immutable external login identities.
The reserved `default` means that backend's discovered login, which can change outside Cezar;
state that limitation in settings. Deleted explicit profiles are skipped, never silently replaced
by default. Revalidate profile existence/provider and model compatibility at admission.

## History, API and UI

The thread shows why an agent stopped, which successor was selected, any queue wait, and the
result. Example: “Claude (work) exhausted its allowance. Continuing with Codex (personal).”
Show skipped candidates and a final readable summary when the list is exhausted. Each
continuation retains its runner, account display identity, model and step attribution; do not
rewrite earlier steps when updating the run's current agent.

Define all new request/response and persisted-event shapes with Zod in `packages/contract`
(including policy, transfer metadata and closed reason codes); infer TypeScript types.
Extend the EXISTING single-mounted workspace account family with these proposed endpoints:

| Endpoint | Validated input | Successful response |
| --- | --- | --- |
| `GET /api/v1/workspace/agent-profiles/fallback-policy` | query `projectId` | canonical policy, revision, store incarnation and revocation token |
| `PUT /api/v1/workspace/agent-profiles/fallback-policy` | body `projectId`, expected revision/incarnation, enabled, ordered candidates | committed canonical policy and updated revision/tokens |

Register the static paths before parameterized `:id` routes, chain them into the family and use
query/body middleware validators. `projectId` is required and never null (no global default);
resolve `default` through the boot-project alias. Unknown project → 404; missing registered root
→ 409; invalid candidate/body → 400; hosted/localHandoff refusal → 409 before local reads;
stale revision or lock contention → 409; storage failure → 500, always the existing `{ error }`
shape. GET absent policy returns off/empty, revision 0 and null incarnation/token without a
write. Initial PUT sends that expected absent state; under the lock it either creates a fresh
incarnation/token or returns 409 if another writer already initialized it. PUT uses the canonical
root as key, not an arbitrary client path. Endpoints are NOT mounted under `/p/:projectId`.
Project UI passes its scoped ID explicitly and caches by project. Do not put policy into ordinary
project config schemas. Hosted UI hides/disables this local-only feature.
Run responses/events carry transfer progress; use existing SSE and reconciliation, no polling
loop or new socket. Keep old records/events readable with optional additive fields.

## Implementation map (future work)

- Contract: `packages/contract/src/agent-profiles.ts`, `runs.ts` and relevant event schemas.
- Policy/hold persistence: new workspace-owned stores via `cezarHomeDir()`, bounded locking
  and existing profile resolution; single-mounted workspace account family in
  `packages/cezar/src/server/server.ts`. Do not change the account store to hold policy.
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
3. Same run ID, workspace, file contents, workflow obligations, budgets and permissions survive;
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
unit tests with fake clocks and crash injection; integration tests preserving file contents and
aggregate budgets; account-hold and existing `auto-resume.test.ts` regression tests; contract
parity, typed-body, workspace single-mount and project-selection isolation tests; UI tests for
settings, accessibility and timeline.
For each regression assertion, demonstrate failure with the implementation removed, while
retaining green guard tests for behavior intentionally unchanged. Run repository type/build
checks and applicable suites when implementing. This documentation-only change does not
claim that these future tests have been written or run.

## Revision 2 regression matrix and implementation order

| Review item | Required proof when implementing |
| --- | --- |
| Graph transfer | Agent → check → review runs in order after fallback and restart; source-node tools/verdicts preserved; exhausted fallback cannot enter graph retry loops. |
| Hold wake owner | Expiry alone wakes work across projects; restart/watchdog repairs timer; deletion of source task does not erase hold; Codex success does not clear Claude. |
| No-session recovery | Every startup attempt fails before session ID, then manual Continue succeeds on the same prepared task and completes downstream nodes. |
| API scope | Static route does not match `:id`; workspace-only mount; selected project isolation, hosted refusal, missing root and revision-conflict responses. |
| Store consistency | Concurrent account edit versus policy disable; concurrent policy edits conflict; dead/uncertain lock owners; read-only/corrupt home; store recreation revokes snapshots. |
| Revocation | Off → on during cleanup/queue/restart never reauthorizes old episodes; launch claim versus disable has a single winner; live messages do not reset consent. |
| Autosave | Contents and existing checkpoint exclusions survive; fallback adds no commit prerequisite. |
| Ordering | A skipped → B exhausted → A available chooses C; explicit workflow accounts are registered; restart preserves cursor and skipped outcomes. |
| Context/policy | Required attachment loss stops; all added text is redacted; truncation is labelled; restricted source skips incapable target; deleted profile does not fall back to default. |
| Ownership | Crash before/after launch claim, before PID persistence and before first event; PID reuse/unsupported identity stops without a second writer. |
| Accounting | Multiple attempts plus later graph nodes count each usage event once; parent reservations persist; unknown cost is not reported as zero. |

Implement in dependency order: (1) fixture-backed classification and explicit support matrix;
(2) contract/stores/revocation and hold expiry coordinator; (3) graph/tail transfer identity and
recovery with source-step policy; (4) selection and settlement arbitration; (5) API/UI; (6) full
regression matrix. Do not expose a working-looking toggle before orchestration is complete.

The initial initiating-backend target is Claude's existing machine-readable terminal usage marker.
Codex and other initiators are enabled individually only after recorded terminal exhaustion and
false-positive fixtures prove their classifier; until then mark detection unsupported in UI.
All installed compatible runners may be targets. This is a release gate, not an assertion that
classifier fixtures or runtime tests already exist for every provider.

The companion review's nine findings are addressed by this revision at the design level. Its
historical findings remain for traceability; implementation verification is still future work.

## Out of scope

Dynamic cost/quality routing; parallel/racing agents; automatic account provisioning or
credential transfer; fallback on every error; context-overflow recovery; starting queued tasks
on another provider before they have run; global fallback inheritance; automatic revisiting of
exhausted candidates; new task/branch creation; extra fallback commits, merges or publication.
