# Review: automatic agent fallback

**Date:** 2026-10-20
**Original verdict:** changes required before implementation.
**Resolution:** addressed in specification revision 2 (2026-10-20), at the design level only.
The regression matrix in that revision maps every finding to required implementation evidence.
**Scope:** review of `2026-10-20-agent-usage-limit-fallback.md` against the local source.
No implementation, provider calls, commits or publication. Findings below describe revision 1;
they are retained as the review record rather than rewritten as if the original plan were correct.

## Findings

### P1 — Ordinary Continue cannot satisfy workflow continuation

Plan: “enqueue an ordinary continuation” and “preserve the workflow cursor and its checks”.
Evidence: `packages/cezar/src/workflows/run.ts:4578` calls `settleSuccess` after a continuation;
it does not return to `executeGraph`. Graph execution is a separate path around line 4907.
Additionally, fresh-session tool selection around line 4418 uses the LAST agent step in the
workflow, not necessarily the interrupted step. A switch during an earlier step could therefore
skip later checks and use the wrong tool restrictions. The graph's verdict parsing also uses
the node backend, so changing only `run.runner` is insufficient.

Required revision: specify a dedicated graph-node retry/transfer intent with source node ID,
resolved step policy, graph cursor and attempt identity. Resume that node with the successor,
feed its result/verdict into the graph, then traverse outgoing edges once. Use ordinary
continuation only for a conversational tail with no remaining graph obligations. Define
attribution without overwriting previous attempts. Add a three-node agent → check → review
fixture and assert the check/review cannot be skipped, including after a crash.

### P1 — Independent account holds have no specified wake owner

Plan: retain a restart-safe hold independent of `autoResumeAt`, without scheduling a task.
Evidence: `run.ts:3009` derives holds from run records, and `fireAutoResume` is currently
responsible for pumping when the deadline expires. `rescueStalledQueue` around line 2979
recognizes future `autoResumeAt`, not a new independent account deadline. A stored deadline
alone is insufficient to promise timely queue progress.

Required revision: define the evidence store, lifetime and owner of one account-expiry timer
which only clears/reconciles holds and pumps registered managers. Re-arm it on restart and
manager registration; update watchdog justification. Specify cross-project behavior, max of
multiple valid deadlines, cancellation/deletion of the originating task, and an explicit rule
for successful use of that same account before the deadline. Test queued work starting at
expiry without any unrelated event. Do not let success on Codex clear a Claude hold.

### P1 — Startup failure can end in an unusable “manual Continue”

Plan: allow fallback without a session ID; on exhaustion offer manual Continue.
Evidence: `run.ts`'s `continueRun` around line 3860 refuses records with no session-bearing
step. The proposed exception only discusses automatic fallback. If every attempted backend
fails before creating a session, the advertised recovery still refuses.

Required revision: define a fresh manual continuation for a valid prepared workspace even
without any session ID, or provide another explicit same-task recovery operation. Cover initial
startup limit followed by all candidates unavailable, then user Continue after fixing access.
Do not widen this exception to failed workspace setup.

### P2 — The proposed API family does not exist at project scope

Plan: “existing project-scoped agent-profile route family”, mounted under both project aliases.
Evidence: `packages/cezar/src/server/server.ts:2345` describes the family as workspace-level;
line 2463 builds `/workspace/agent-profiles`, and line 2724 selects a project via `projectId`
in the request body. Hosted access is refused by `localHandoff` capability checks.

Required revision: choose explicitly between a new project-scoped family and extending the
single-mounted workspace family with project identity. Recommended: reuse the workspace
account-policy convention and validate the project through the existing resolver. Specify GET
and PUT contracts, local-only capability check and unknown/missing project responses. Correct
the implementation map and route-parity expectations accordingly.

### P2 — The account writer has no existing cross-process lock

Plan: reuse the store's “existing locking and atomic write discipline”.
Evidence: `packages/cezar/src/workspace/agent-accounts.ts:219` explicitly documents the
read/rename race. `mergeWriteAgentAccounts` loads, mutates, then atomically replaces the file;
atomic replacement does not serialize read-modify-write.

Required revision: remove the incorrect claim. If consent revocation must not be overwritten
by a concurrent account edit, specify serialization for ALL writers of this store, with stale
lock recovery and read-only behavior, or isolate policy behind its own adequately serialized
store. A lock used only by the new endpoint does not coordinate existing account writers.
Add a concurrent account edit versus disable test.

### P2 — Policy revocation needs durable semantics across off → on

Plan: snapshot candidates, cancel pending transfers when disabled, and do not revive failed tasks.
This does not decide whether an old active task may use its old snapshot after off → on,
or what restart does with a previously revoked queued intent. Checking only the current boolean
would allow old policy to regain authority.

Required revision: use a durable revocation generation (or equivalent per-run cancellation)
checked at reservation and admission. Define whether disable revokes all prior snapshots or
only current pending attempts. Recommended: revoke existing episodes; a human Continue may
start a new one under current settings. Test off → on during cleanup, queue wait and restart.
Also define a live human message versus explicit Continue: only the latter currently refreshes
policy, which needs to be deliberate UI behavior.

### P2 — No-autocommit promise conflicts with existing autosave

Plan: preserve uncommitted changes and “no automatic commit ... is involved”.
Evidence: `run.ts:4608` autosaves in continuation finalization; execute finalization also
calls `autosaveCommit` around line 4931. Check nodes make their own checkpoints.

Required revision: state that fallback creates no EXTRA commit and preserves existing autosave
semantics, including exclusions for check artifacts. Test content preservation, not a universal
promise that files stay dirty. If exact dirty-state preservation is intended, explicitly design
and test the change to existing failure-path autosave instead of implicitly removing it.

### P2 — Ordered traversal and attempted-set semantics are incomplete

Plan: repeatedly traverse from the top, skip attempted accounts and skip temporarily unavailable
ones, while promising a single pass through the list. Skipped candidates are not defined as
attempted. A previously skipped entry could become available and be chosen before a later
candidate, violating the advertised one-pass order. Workflow-selected accounts also need to be
recorded when a later node starts, not only at task creation.

Required revision: persist a monotonic candidate cursor and visited/skipped outcomes for the
episode. A skip is final for that episode. Before handling any node failure, record its actual
runner/account, including explicit overrides. Clarify that history may contain multiple ordinary
workflow uses of an account while automatic fallback never revisits it within the episode.
Test A skipped → B exhausted → A becomes available: choose C, not A.

### P2 — Context and permission guarantees need concrete boundaries

Plan: snapshots reference accounts, context comes from task/handoff/status, and targets must
preserve permissions. Existing portable context copies redacted conversation, but direct handoff
or filesystem summaries are additional input paths. Existing runner restrictions are also not
equivalent: `packages/cezar/src/core/agent-runner.ts:49` documents that only Claude honors
`allowedTools`.

Required revision: define required versus advisory tool restrictions and a target capability
check; unrestricted default tasks remain eligible, restricted tasks cannot silently lose a
restriction. Apply existing secret redaction to every new context source. Specify attachment
replay (not only text history), truncation priority and stale handoff handling. Treat `default`
account identity as a local profile reference, not a promise that external CLI login can never
change; reject missing explicit profiles rather than resolving them to another account.

## Additional implementation gates

- Crash ownership is a requirement, not an existing primitive: in-memory `ownerToken` and
  `registerRunProcess` are not durable process identity. Specify a process ownership protocol,
  the spawn-before-PID-persist window and PID reuse handling; when uncertain, fail closed as
  the proposal already requires. Do not advertise guaranteed automatic recovery in that case.
- Map fallback phases to actual run statuses and `currentStepId`; otherwise recovery's scan
  of queued/running/waiting records may miss a pending transfer on a failed record. Include
  pending intent reconciliation independently of that scan.
- Define precedence over graph fail edges/retry loops: classified usage exhaustion must not
  escape into a graph retry which bypasses the ordered fallback policy or resets its bounds.
- Pin current per-attempt cost aggregation before changing step attribution. Preserve existing
  accounting limitations rather than claiming exact budget enforcement where usage is unknown.
- Establish the supported initiating backends with local recorded error fixtures before coding;
  picker availability alone must not suggest every backend can detect exhaustion reliably.

## Product tradeoff already made by the proposal

Exhausting an enabled list suppresses reset-time auto-resume even if a reset is known. This
matches the user's “stop when nobody can continue” criterion, but is a deliberate reduction
of existing unattended recovery for opted-in tasks. Keep it explicit in settings copy and tests;
there is no reason to change the unconfigured/default path.

## Review evidence and next step

Read the spec and relevant source paths for graph execution, continuation, usage-limit holds,
queue watchdog, account persistence, route registration, process registration and portable
context. This is a static design review, not a runtime verification; no application tests were
run and no source files were changed. Revision 2 now incorporates these design corrections; their runtime verification remains
required during implementation. The feature goal and placement in Settings → Agents remain appropriate.
