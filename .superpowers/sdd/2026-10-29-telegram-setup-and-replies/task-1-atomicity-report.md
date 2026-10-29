# Task 1 activation atomicity report

## Result

Telegram setup activation now treats setup metadata removal as post-commit cleanup. After `confirm` durably writes the enabled receiver and grant, cleanup is retried up to three times and cannot turn that committed activation into an HTTP 503. The successful service result therefore agrees with durable grant state, and an in-process repeat uses the existing `pairing_expired` terminal result without ambiguity.

The existing mode capability mapping and restart coverage remain unchanged.

## Commits applied

- `c39f1f060` — cherry-pick of Task 1 implementation `4ae143a1b` (the order's `4ae1431b` was not an object on `cez/7008c30b`)
- `d41b08adf` — cherry-pick of `1649a532e`
- `8f88cab2d` — cherry-pick of `892279560`

## Regression evidence

The new regression injects failure into every cleanup persistence attempt. With the source fix temporarily removed, it failed because `activateSetup` propagated `cleanup unavailable` after the durable commit. With the fix restored, it verifies:

- activation returns `{ active: true }` with the task-control capability;
- cleanup is attempted exactly three times;
- the receiver is active and the returned grant is present;
- retrying the consumed setup returns `pairing_expired`.

## Verification

- `npx vitest run packages/cezar/src/telegram/service.test.ts packages/cezar/src/server/telegram.test.ts packages/cezar/src/server/contract-parity.telegram.test.ts` — 3 files, 51 tests passed.
- `npm run typecheck:contract` — passed.
- `npm run typecheck:server` — passed.
- `git diff --check` — passed.
