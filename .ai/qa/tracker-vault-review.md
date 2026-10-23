# Tracker vault + mediated access — multi-angle review (2026-10-23)

Scope: `git diff 2e16d703 HEAD` (47 files). Three independent reviewers (security, architecture/AGENTS.md
consistency, business/correctness) plus own verification. Verdict: **changes required before merge**.

## Blocking

1. **Jira issues with common content cannot start or continue.** `adf.ts:51-55` flags mention, emoji,
   inlineCard, media, panel, status, date, expand, taskList, underline/textColor as unsupported;
   `jira.ts` `context()` then throws, `run.ts` fails the step before spawn. `act()` re-reads context, so
   one @mention mid-run turns every write into `unknown`. Fix: render leniently, report in `limitations`.
2. **Continue / restart recovery depends on a live tracker read** (`run.ts` `agentEnvForStep`). Offline,
   rate-limited, rotated connection, moved issue, or a pre-upgrade run (no `issueId`/`access`) → Continue
   fails permanently, even for "fix lint". Fix: degrade to "context unavailable", no capability.
3. **Enabled legacy automations stop silently.** `scheduler.ts:191` throws every tick; only `retryAfter`,
   nothing in the list view; review resets scan identity so the gap's events are dropped unlogged.
4. **`bc-route-inventory.test.ts` fails**: `/api/v1/tracker/task` missing from BACKWARD_COMPATIBILITY.md §2
   (also stale: §state `tracker-connections/*.env`, CLI list, new run-record fields, removed agent env).
5. **Automation skill not updated**: `automations/prompts.ts` example lacks `trackerTrigger.access`
   (server now 400s `create --file`) and line 96 still mentions credentials.

## Should fix

6. Context JSON (up to ~700 kB) prepended to every step and Continue: token cost, model window,
   Cursor argv limit (128 KiB). Write it to a file in the run tmp dir and reference it.
7. Pre-send failures (precondition, stale auth, context read) stored as permanent `unknown`
   (`task-access.ts` `catch { return unknown }`); test pins the wrong status.
8. Concurrent write on the same issue gets `unknown` without send or receipt; PID-reuse stale lock.
9. Agent can self-grant writes via `cez automation update/create --file` (prompt-injection path; not a
   boundary, but it bypasses the "explicit review" promise).
10. Editor drops `access` after connection rotation (`editor-tracker-fields.tsx:69`) → false legacy warning.
11. `cez tracker` CLI swallows the server's error reason; prompt omits `node "$CEZ_BIN"` for writes.
12. Read-only home + legacy `.env` → tracker unavailable (migration writes on read path).

## Minor

Receipt dirs not removed by `deleteRun`; `process.env.VITEST` check in `secret-keyring.ts`; Jira comments
are plain text (Markdown shows literally); `.not.not.toContain` no-op assertion; imports at line 1 and a
duplicated contract import in `store.ts`; long prompt inline in `run.ts`; env note outside the table in
`docs/reference.md`; raw `<input>`/`<legend>` instead of shadcn; no CHANGELOG entry;
`agent-profile-wiring.test.ts` fails when `CEZ_API_URL`/`CEZ_BIN` are set in the shell.

## Confirmed OK

No vendor token reaches agent env; capability per project, bound to the `ActiveRun` epoch, dies when the
run stops running, redacted; children get none; variants after the first are read-only. Migration keeps
ids, verifies before deleting plaintext, fails closed on conflict, `.migrated` blocks resurrection, AAD
binds ciphertext to the id, established keys never replaced. Routes chained, middleware-validated,
contract zod-inferred, both mounts. Jira 204, required-field transitions excluded, no POST gateway→site
fallback; Linear `success` checked, cursor cycle guard, team scope. Typecheck passes.
Not addressed by design (documented): same-user process can read the data key and decrypt.

## Fix status (2026-10-23, continue-12)

Fixed 1–12 and the minor items, except: `process.env.VITEST` guard in `secret-keyring.ts` kept
(it stops a vitest worker touching the real keychain when a test passes its own env); access
checkboxes stay native `<input type="checkbox">` (no shadcn Checkbox in `components/ui`); no
CHANGELOG edit (generated from PR labels).

- Context: lossy/oversized content → `limitations` (`context-limits.ts`); written to
  `runs/<id>.tracker-context.json`, prompt carries a short note only (`trackerPrompt`).
- Launch/Continue never fail on tracker state: legacy run → note, no capability; read failure →
  note, capability kept for `tracker read`.
- Writes: pre-send failure → `rejected` and the ID is freed; same-issue writes queue 20 s;
  own-PID stale lock reaped; replay before binding check; `beforeWrite` right before the POST.
- Legacy automations: "Needs review" badge, one log entry, checkpoint kept, confirm no longer
  pauses, access no longer part of scan identity.
- CLI: server reason surfaced, exit 1 for usage; `cez automation` cannot add write grants.
- Editor keeps grants across connection rotation; read-only home reads legacy `.env`.
- Docs: BACKWARD_COMPATIBILITY (route, CLI, run fields, `.vault` format, downgrade),
  `docs/issue-trackers.md`, `docs/reference.md`, automation skill prompt.

Evidence: `npm run typecheck` PASS. Focused vitest (tracker, automations, workflows, runs,
secrets, contract/route parity, bc-route-inventory, typed-bodies, versioned-surface, automations
UI): 151 files / 1880 tests PASS. `npm run test:unit` 42 PASS. build:server, web build,
check:pack (932 files) PASS. All 15 new/changed regression tests fail against the pre-fix
sources and pass after. Full `npm test`: 24 failures, all environment (TMPDIR inside the repo,
`CEZ_REMOTE=1` in the task shell, missing `node_modules/.bin/vitest` and terminal deps, duplicate
React from temporary `/dev/shm` deps); with TMPDIR outside the repo and cockpit env unset the
remaining 4 are those install gaps, in files this change does not touch.
