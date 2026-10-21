# Review 3 — agent usage-limit fallback (branch cez/50cf615c @ 78692ba3)

Base: `cd0f30b4` (upstream/main). Scope agreed with the owner: tail-only fallback, graph
workflows unchanged vs main. Reviewed: business, technical/architecture, UX/UI (three
independent reviewers + local verification).

## Environment correction

Earlier "main is broken" claims (`stepSecretsSchema` / `trackerKindSchema` undefined) were an
artifact: the worktree had no `node_modules`, so `@open-mercato/cezar-contract` resolved to the
main checkout's older source. After `npm ci` in the worktree, base `cd0f30b4` typechecks clean.

## Validation (worktree, after npm ci)

- `npm run typecheck`: **1 error, branch-caused** — `contract-parity.workspace.test.ts:225`
  `route-is-wider` (route sends more than `agentFallbackPolicySchema`; store `.passthrough()`).
- `npm test`: 18 failed / 10931 passed. 14 reproduce on clean base (TMPDIR lives inside a git
  repo → "outside a git repository" tests; provider-action-gating; agent-profile-wiring) =
  environment. **4 are branch-caused:**
  - `bc-route-inventory.test.ts` — fallback-policy route missing from BACKWARD_COMPATIBILITY.md §2.
  - `auto-resume.test.ts:558` — run with an unknown `agentProfile` now fails instead of degrading
    to the default account (fail-closed change in `resolveProfileEnvForRoot` is global).
  - `run.test.ts:696` — Continue with `runner` on a sessionless run no longer refuses.
  - `design-guardian.test.ts:319` — new native `<select>`s lack the focus-ring classes.

## P0 — release blockers

1. Suite/typecheck red (the 4 tests + typecheck above).
2. No RunManager orchestration tests for the switch path (`run.ts:2769-2845`).

## P1

3. **Main-path behavior changed** (violates "workflows unchanged"):
   - `agent-profiles.ts:155-166` throws for a missing/foreign account or unreadable accounts file
     on every step, graph included. Restrict the strict check to fallback admission.
   - `run.ts:3946` sessionless Continue with `runner` now starts fresh for any run, graph included.
     Restrict to the fallback caller.
4. **Classifier too broad**: `isUsageLimitMessage` → `LIMIT_PHRASE_RE` matches transient
   per-minute 429s and unrelated "GitHub rate limit" text → switches to another paid vendor.
5. **Originating agent/account never marked tried** → Claude → Codex → (Codex limit) → Claude
   again while still exhausted. Accounts on hold are not skipped.
6. **Legacy runs (no snapshot) use the live policy** (`run.ts:2794`) — spec says keep old behavior.
7. **Revoked snapshot disables auto-resume forever for that run** (`run.ts:2796-2805`).
8. **Restart while a sessionless fallback continuation is queued** → `reviveQueuedRun` falls to
   `reviveWorkflow` and re-runs the task from the start in the same worktree.
9. **All candidates refused synchronously** → loop ends with no exhausted summary, no timer
   (`run.ts:2823-2845`); user sees only dim notes.
10. **v1 multi-step files**: successor runs one Continue step and the task settles; later steps
    are skipped silently.
11. **Lock**: owner-less lock (crash between mkdir and owner write) wedges saves forever (409);
    pid-only identity; rm+mkdir reclaim race; missing home → ENOENT reported as 409.
12. **UX: deleted account blocks every save, including switching fallback off** (toggle resends
    the list; server 400s it). **409 conflict never refetches** → stuck until reload.
13. **UX: synthetic handover prompt renders as the user's own message bubble.**

## P2

- Account hold lives on the run and ends when the successor reaches review/done → stampede on
  the exhausted account before its reset; a second limit overwrites the first hold.
- Disable does not cancel an already-queued transfer.
- Episode state parsed from lifecycle text by regex; never reset by a human Continue.
- No sessionless manual recovery in the UI (`run-actions.ts:128` gates Continue on a session).
- Hosted mode / GET error / loading: disabled controls with no explanation (spec: hide section).
- Default/initiating agent may be added to the list and is silently skipped; nothing says which
  agent goes first or that the policy applies to NEW tasks only.
- Provider status ignored (disabled / not logged in providers addable; no badge); model picker
  ignores catalog status.
- Duplicate add is silent; no 10-cap in UI; hard-coded initial `'codex:default'`.
- A11y: checkbox labelled by its state ("Enabled"), "Remove" without row name, raw buttons
  without focus ring, raw ids in aria labels.
- Copy: missing "context is sent to that vendor", "budget/approvals still apply", "stops when the
  list runs out", "applies to new tasks"; jargon ("verified usage limit", "workflow graphs").
- Handover history: two dim near-identical lines (reserved + continuing), raw provider ids /
  account slugs, no model, no "who ran out"; exhausted line is dim, without next step.
- Graph runs with fallback on give no signal that fallback was skipped.
- docs/reference.md: "verified usage exhaustion" is inaccurate; omits new-tasks-only and v1 caveat.

## P3

- GET leaks unknown file fields over the wire (`.passthrough()`) — cause of the typecheck error.
- Lock/owner writes bypass `assertCezarHomeWriteIsSandboxed`.
- Native select/checkbox/buttons instead of shared `Switch`/`Button`; private `Field` copy instead
  of `settings-field.tsx`; picker row overflows at ~375px; `FallbackField` is one very long line.
- `agent-fallback.test.ts` cases share `/repo` state and depend on order.
- Suspected: `this.repoRoot` vs registry root key mismatch could make a saved policy never apply.

## Done well

- Off by default; with fallback off, tail and graph usage-limit paths are logically equal to main
  (apart from the two shared changes in P1 #3).
- Routes chained into the family, zod middleware, local-only, no path leaks, parity assert added.
- Own file under `cezarHomeDir()`, atomic 0600 writes, CAS on revision/incarnation, per-entry salvage.
- No new `CEZ_*` var, no new dataDir file.
- `quick-task` (the default) is a single-step tail workflow, so it IS covered; all other built-ins
  are graph workflows and are excluded.

## Proposed UX shape

Settings → Agents → Automatic fallback: a `Switch` that saves on/off only; one-line explanation
(context goes to the next vendor, its plan may be billed, budget/approvals still apply, new tasks
only, graph workflows wait for reset); "Starts with: <task's agent>"; ordered rows
`Provider · account · model · status` with ↑ ↓ ✕ and an "account removed — skipped" badge;
"+ Add agent" menu of not-yet-added accounts, disabled at 10; 409 → refetch + toast; hosted →
"Available on a local cockpit".

Task thread: one neutral card per handover — "Claude (work) hit its usage limit — continued with
Codex (personal) · gpt-5", skipped candidates listed; on exhaustion a danger-toned dock summary
with [Continue with…] [Wait for reset at HH:MM] [Fallback settings]. Synthetic prompt hidden or
labelled "cezar → Codex (handover)".

## Suggested fix order

1. Revert the global effects (P1 #3) → fixes `auto-resume.test`, `run.test`.
2. BC inventory + strip passthrough in GET + select focus classes → suite/typecheck green.
3. Narrow classifier, mark originator tried, skip held accounts, legacy = disabled, revocation →
   old path, exhausted summary after refusals, restart of sessionless queued continuation,
   fallback only for single-step tails (or say so).
4. Lock hardening.
5. UX: toggle-only save, 409 refetch, copy, status badges, a11y, handover rendering.
6. Orchestration + UI tests (prove red without the fix).

## Fix status (2026-10-21, same day)

Fixed: every P0/P1 above; P2 holds (array, survive task end, expiry pump), disable cancels a queued
successor, structured episode reset by human Continue, hosted/load/loading states, provider/account
badges, duplicate-free picker with 10-cap, a11y names, copy, readable single-line hand-over with
danger-toned exhaustion, docs; P3 contract leak, sandbox guard, shared Switch/Button, wrapping rows,
order-independent store tests. Also fixed: a dispatched child's report is held while its fallback
admission is pending. See spec §"Revision 3 — what is implemented".

Kept on purpose: the successor's opening prompt stays a user-message bubble (same as auto-resume and
restart prompts on main); a sessionless task whose fallback list is exhausted has no Continue button
(main's rule); runtime does not pre-probe provider auth — a successor that cannot start moves the
chain on.

Validation: `npm run typecheck` 0 errors; `npm test` 10953 passed, 14 failed — the same 14 that fail
on clean base `cd0f30b4` in this environment (TMPDIR inside a git repo, host account probes);
`npm run test:unit` pass; `npm run build` pass; `npm run test:package` 24/25 — the tarball install
fails with npm `EALLOWSCRIPTS` (local npm config), unrelated to the change. New tests:
`workflows/agent-fallback-run.test.ts` (7), `workspace/agent-fallback.test.ts` (13),
`web/routes/settings/agents-fallback.test.tsx` (7); guard tests proven red without their fix.
