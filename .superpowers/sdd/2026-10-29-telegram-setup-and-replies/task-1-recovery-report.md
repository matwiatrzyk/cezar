# Task 1 restart-recovery report

## Finding

Activation durably committed the Telegram grant before removing disposable setup metadata. The cleanup correctly retried three times and still returned activation success when every attempt failed, but the surviving `setups.json` was trusted by a new `TelegramInbound`. That resurrected the consumed candidate and a second activation reached `already_paired` instead of the terminal `pairing_expired` result.

## Fix

Setup restoration now validates the durable inbound state for each candidate-bearing setup. When the state belongs to this project and already contains the matching receiver/user grant, the setup is treated as consumed, omitted from restored pairing state, and removed by the normal setup persistence pass. Pending setups, damaged or foreign state, normal cleanup, the three-attempt cleanup bound, durable notification/task-control capability, and genuine confirmation errors retain their prior behavior.

## Regression proof

The new service regression persists a candidate, forces all three post-commit cleanup attempts to fail, recreates `TelegramInbound`, and verifies:

- status and activation both return `pairing_expired`;
- stale `setups.json` is removed;
- the durable task-control grant remains available after `load()`;
- no `already_paired` result escapes.

With reconciliation temporarily removed, the focused regression failed because recreated `setupStatus` returned a live candidate. Restoring the fix made it pass.

## Verification

- `npx vitest run packages/cezar/src/telegram/service.test.ts packages/cezar/src/server/telegram.test.ts packages/cezar/src/server/contract-parity.telegram.test.ts` — 3 files, 52 tests passed.
- `npm run typecheck:contract` — passed.
- `npm run typecheck:server` — passed.
- `git diff --check` — passed.
