# Review 4 — agent usage-limit fallback (branch cez/50cf615c @ 3bc25fc2)

Branch brought up to date first: `upstream/main` merged twice (794e125e, 3bc25fc2 — 18 upstream
commits, no conflicts), `npm ci` refreshed. Feature diff = `git diff upstream/main HEAD`.
Three independent read-only reviewers (technical/architecture, business/spec, UX via om-ux-shape
Review mode) plus local verification.

## Validation (merged branch)

- `npm run typecheck` 0 errors · `npm run test:unit` pass · `npm run build` pass.
- `npm test`: 11016 passed, 14 failed — the same 14 environment failures as on clean base
  (TMPDIR inside a git repo; host account probes). Feature suites 27/27.

## Verdict

Not ready to release. With fallback **off**, graph and tail runs are equivalent to upstream/main
(confirmed by both technical and business reviewers; the only footprint is a disabled
`fallbackPolicy` snapshot on every new run record). With fallback **on**, the feature misses the
most common real trigger and can stop the chain silently.

## P1 — confirmed

1. **Classifier misses the real exhaustion messages** (`core/usage-limit.ts`, `EXHAUSTION_PHRASE_RE`
   / `THROTTLE_RE`). Probed: `You've hit your session limit · resets 3:10pm (UTC)` → false (the exact
   telemetry string upstream pins in `usage-limit.test.ts`), `You've hit your limit · resets 3pm` →
   false, OpenAI `429 … You exceeded your current quota … insufficient_quota` → false (the `429`
   veto wins). Only Codex `You've hit your usage limit…` → true. Claude's everyday 5-hour limit never
   triggers fallback; the run silently takes the reset-time resume. Run tests only use the legacy
   `Claude AI usage limit reached|<epoch>` mock envelope, so this was never exercised.
2. **A successor that cannot start ends the chain without a reason** (`run.ts` `claimAgentFallback`,
   `successorFailedToStart`). `runContinuation` pins a `sessionId` on the step before spawning, so a
   Codex that is not logged in / not installed / crashes on auth fails with `failed.sessionId` set;
   the claim returns false, remaining candidates are never tried, no danger summary, and the original
   agent's reset-time resume (which main would arm) is lost. Review-3's "a successor that cannot start
   moves the chain on" is false. Untested.
3. **Settings promises skips the engine does not perform** (`agents-section.tsx` `problemFor` vs
   `agent-fallback.ts` `eligibleFallbackCandidates`). Rows say "Provider disabled — will be skipped" /
   "Not connected — will be skipped", but admission checks only holds and account existence. A
   provider the user DISABLED is still launched and receives the repository context (consent issue),
   and with P1-2 the chain then dies on it.
4. **Starting-agent identity ignores the project's account selection** (`run.ts`
   `originKey = runAccountKey(run, runner)`). `agentProfile` holds only a composer override; a run that
   followed the project's selection of `claude:work` is keyed `claude:default`. List
   `[claude:work, …]` → hands the task back to the exhausted `work`; list `[claude:default]` → the real,
   available default login is skipped silently. Key origin and hold from the failed step's
   `backend` + `profileId`.

## P2

- **Stale-lock reclaim race** (`agent-fallback.ts` acquireLock): after A renames the stale lock aside
  and installs its own, B can rename A's fresh lock aside and delete it — both hold the lock. Re-check
  the moved dir's owner before deleting; add a short retry so two tabs don't get an instant 409.
- **Admission continues after `dispose()`** (`admitAgentFallback`): queues and pumps on a disposed
  manager. Needs a disposed flag checked after the await.
- **"Approvals still apply" is misleading copy**: Codex/OpenCode/Cursor ignore `allowedTools` (#430),
  so Claude → Codex can widen tool access.
- **Momentary `failed` before every hand-over**: the run shows failed / "needs you" (and may fire a
  browser notification) while accounts load.
- **Tasks created before switching on never use it**; a human Continue resets the episode but does not
  re-snapshot; off→on revokes every in-flight snapshot. UI copy says "started after you switch it on"
  but not that edits only affect new tasks.
- **Default agent listed as its own fallback is skipped with no note** (Settings offers
  `claude · Default` first; engine drops the starting agent silently).
- **Hand-over reads as noise**: the "…continues this task" line renders dim; the successor's prompt is
  a user bubble mentioning `CEZ_HANDOFF_FILE`. Kept deliberately in review 3 for parity with
  auto-resume, but the stakes (another vendor's bill) are higher here.
- **Names differ between Settings and thread**: `codex · Work · auto model` vs `Codex (Work) · gpt-5`;
  "auto model" vs "auto (default)"; the "could not start" note omits account labels (slug shown).
- **Keyboard reorder loses focus**: ↑/↓/✕ become `disabled` while saving, dropping focus; the new order
  is not announced.
- **Adding agents does not turn the feature on**; the Switch reads a muted "Off" — easy to leave the
  page believing it is set up.

## P3

- Restart between claim and reservation leaves the run failed with no resume, no reason line, and the
  held dispatch report is never sent.
- Revoked queued successor (`retireRevokedFallback`) gets no reset-time resume, contrary to the spec's
  "falls through".
- Holds are not lifted by a human Continue on the same account or by `DELETE …/auto-resume`.
- Auto candidate passes `model: undefined`, so an unrecognised free-form pin survives a provider switch.
- Contract `usageLimitHolds` is wider than the store schema (`.min(1)`, `.datetime()` missing).
- Disabled `fallbackPolicy` snapshot written on every run; store it only when enabled.
- A named account deleted while its successor is queued resolves to the default login at spawn.
- Exhaustion line may quote the latest agent's reset, not the original's.
- Graph / non-final-step failures with fallback on take the old path with no note.
- Add-row selects shrink instead of wrapping at ~375px; terms paragraph dense ("workflow graphs");
  load-error has no Retry; picker cleared before the save succeeds.
- BACKWARD_COMPATIBILITY.md does not mention the new optional RunRecord fields.

## Suspected (not verified)

- An agent's own terminal error quoting "usage limit" text could false-trigger (no path found that
  copies tool output into `run.error`).
- Expired holds in another project / after restart wait up to 60 s for the queue watchdog.

## Test gaps

Real session-limit and 429-quota texts; successor failing after its session id is pinned; provider
disabled / not connected; run following the project account selection; dispatch report sent exactly
once; `retireRevokedFallback`; consent revoked at failure time; v1 failure on a non-final step; human
Continue / delete / dispose during admission; hold timer pumping the queue.

## Done well

- Narrow synchronous ownership; episode durable before the await; hold published before `releaseSlot`.
- `freshSessionAllowed` unreachable over HTTP; human Continue resets the episode.
- Store: per-entry salvage, exact contract output, CAS on revision/incarnation, revocation on
  disable, 0600 atomic writes behind the sandbox guard, realpath keys, correct `/proc` start tick.
- Route chained into its family, middleware validation, local-only, clean 400/404/409/500, no path
  leaks, parity assertion, BC inventory entry. No new `CEZ_*`.
- Settings UI matches the spec's handoff state table and copy; per-row accessible names; one focus
  ring; tokens only (dark mode carries over); 409 refetch works.
- Dispatch child report correctly held during admission.

## Suggested fix order

1. Classifier: add Claude `session`/`hit your limit` and OpenAI `insufficient_quota` before the
   throttle veto; run tests with the real strings (P1-1).
2. Successor failure on its reserved step (no assistant output) → next candidate; if none, danger line
   and re-arm the original agent's reset-time resume (P1-2).
3. Enforce disabled / not-connected in admission so Settings and engine agree (P1-3).
4. Origin key from the failed step's backend + profileId (P1-4).
5. Lock reclaim race, dispose guard, copy ("approvals"), one shared agent label, non-dim hand-over line.
6. Remaining P3 + the listed tests.

## Repair status — Codex continuation, 2026-10-21

All four P1 findings are repaired. The real session-limit classifier, exhausted OpenAI 429,
failed-launch chain, disabled provider and actual starting account now have regression coverage.
The classifier test and three orchestration regressions fail against pre-repair code (58dd3e62),
then pass with the fix. Temporary red-check files were removed.

Also repaired: lock-reclamation serialization; disposal guard; restart during admission;
account deletion while queued; stale Auto model pin; exact hold contract; disabled snapshots;
reset-time summary; permissions and policy-lifetime copy; consistent labels; visible handover;
automatic-message attribution; keyboard focus/live announcement; saved-but-off hint; responsive
selects; Retry and preserving the picker on failed save. BC inventory and reference docs updated.

Retained decisions and the remaining brief failed-state/notification presentation limitation are
explicit in spec Revision 4. No browser usability study was performed; UI evidence is component
tests, including retained focus and the position announcement.

Final validation:

- `env -u CEZ_API_URL -u CEZ_BIN -u CEZ_REMOTE TMPDIR=/tmp npm test`: 655 files passed,
  1 skipped; 11,039 tests passed, 4 skipped. The unisolated run's 14 failures came from
  repo-nested TMPDIR (11) and inherited cockpit environment (3); each also passed in isolation.
- `npm run typecheck`: passed, including the final source changes.
- `npm run test:unit`: 42 passed.
- `npm run build`: passed, including check:pack (892 files).
- `TMPDIR=/tmp NPM_CONFIG_USERCONFIG=/dev/null NPM_CONFIG_GLOBALCONFIG=/tmp/cezar-fallback-empty.npmrc npm run test:package`:
  25 passed. The empty temporary global config avoids the host's `allow-scripts=opencode-ai`
  option, which otherwise produces EALLOWSCRIPTS. User/global config files were not changed.
- Focused fallback suites: 36 passed. `git diff --check`: passed.
- No push. This continuation leaves its changes local; the preceding provider's work was already
  saved by cezar in b73f261b.

## Follow-up: no transient failed state during handover

The remaining failed-state/notification limitation above is now fixed. Failure publication and
fallback eligibility are decided synchronously before any run event is emitted: eligible tasks
enter queued selection (`fallbackEpisode.pending`) and display “switching agent”. The failed step
still records the provider error, while the task is not reported as failed until no successor can
continue. The normal attention/notification logic needs no delay, suppression timer or polling.

Tests inspect the actual store event stream (no failed event before reservation), prove the old
implementation fails that assertion, and cover one final failure emission, notification transitions,
restart, cancellation, consent revocation, admission errors and watchdog recovery. The default
path and graph workflow guard tests remain in the suite.

Follow-up validation: full isolated vitest 11,045 passed / 4 skipped (655 files passed / 1 skipped);
final focused fallback/attention/notification suites 97 passed; recovery/auto-resume 36 passed;
typecheck and build passed; node unit 42 passed; package 25 passed; diff whitespace check passed.
The event-stream assertion fails on the preceding HEAD and passes with the fix. All work local;
no push and no new manual commit.
