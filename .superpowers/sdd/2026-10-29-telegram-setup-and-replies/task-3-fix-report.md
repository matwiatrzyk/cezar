# Task 3 review-fix report

## Result

- Telegram task creation reserves a run id in the durable source claim and persists matching private source provenance on the run through the engine's strict `flushCreatedRun` seam before queue admission.
- Source completion now uses one `settleSource` mutation for source state, journal outcome/run id, and polling offset.
- Source identity and dedupe include bot id and polling epoch, so Telegram may reuse update ids after an epoch rotation without colliding with prior history.
- Account, provider, and project gates settle as terminal `policy_refused` sources with a bounded `policyReason`; ambiguous creation failures remain `uncertain` and are never reported as delivery failures.

## Regression evidence

- `packages/cezar/src/telegram/state.test.ts`: failed settlement writes retain the wholly claimed durable snapshot; epoch rotation admits the same update id as a new source.
- `packages/cezar/src/runs/store.test.ts`: a restart finds the strictly persisted run from `(botId, epoch, updateId)` source provenance and the reserved run id.
- `packages/cezar/src/telegram/conversation.test.ts`: successful creation settles all three state components and each policy gate records `policy_refused`, not `delivery_failed`.
- `packages/cezar/src/telegram/roundtrip-source.test.ts`: provider/account/project gates refuse before task creation and the source is passed into the strict creation seam.

## Verification

- Focused Telegram source/state/conversation/authorization and run-store suite: 237 passed.
- Contract, API-client, server-test, and web typechecks: passed (web after the required server declaration build).
