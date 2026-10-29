# Task 2 UI review fix report

## Changes

- Task-control commands, shell/provider-cost warnings, and cancel/continue permission controls now render only for grants whose durable `capability` is `task_control`. Missing legacy capability is explicitly treated as notifications-only.
- Guided setup accepts only private-chat receivers; existing group pairing remains available through the consent-aware manual flow.
- Candidate, recovery, and completion states move focus to their primary action, with keyboard progression covered by focused tests.
- The discovery announcement says validation is pending until `begin` succeeds. Cancelling or retrying advances a request generation so late begin completions are ignored.
- Telegram token coverage uses a sentinel, asserts it is absent from rendered copy, and pins the exact typed create request keys.

## Evidence

- `npm test -- --run packages/web/src/routes/settings/telegram-inbound.test.tsx packages/web/src/routes/settings/webhooks-section.test.tsx`: 2 files, 36 tests passed.
- `git diff --check`: passed.
- `npm run typecheck:web`: attempted, but blocked by repository-wide stale server/API type drift unrelated to these files (for example missing `telegram`, `dashboard`, `tracker`, `secrets`, and `start-app` routes plus older health capability shapes). The focused tests compile and pass against the current contract source after installing this worktree's workspace links.

## Commit

Recorded after commit in the task report and parent dispatch report.
