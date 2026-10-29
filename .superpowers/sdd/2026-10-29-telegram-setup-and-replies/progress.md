# SDD ledger — plan: docs/superpowers/plans/2026-10-29-telegram-setup-and-replies.md

## Preflight scan

| Pair/task | Shared files or interface | Finding | Ruling |
|---|---|---|---|
| Task 1 → Task 2 | Task 1 typed setup operations → Task 2 wizard client | Task 2 consumes the route schemas and status/error codes produced by Task 1; no file overlap. | Sequential boundary is explicit; Task 2 may not add server fallbacks or hand-written response types. |
| Task 1 → Task 3 | Existing verified receiver/grant → source correlation | Task 3 consumes Task 1's active grant and service authorization; contract changes are isolated in `telegram-tasks.ts`, not `telegram.ts`. | Keep the existing grant model authoritative; Task 3 adds only source freshness and claim state. |
| Task 3 → Task 4 | `TelegramSourceRecord` and run attribution → response delivery | Task 4 consumes source records and runtime transition callbacks; no source state or task-creation files overlap. | Task 4 must never create or claim a task; it only publishes idempotent delivery states. |
| Task 2 → Task 5 | Wizard UI → browser setup fixture and docs | Task 5 exercises the UI and documents it; no product source overlap. | Browser assertions must use public UI behavior and deterministic fixture APIs. |
| Task 4 → Task 5 | Delivery messages → browser lifecycle assertions | Task 5 consumes final message behavior; no source overlap. | Browser fixture covers at least acknowledgement and final response; unit tests own edge cases. |
| Task 1 self-check | Contract, route middleware, service orchestration, tests | The tests named in the task cover each produced operation and its gates. | Proceed; add parity coverage before implementation is marked complete. |
| Task 2 self-check | React wizard states, empty/recovery UI, component tests | The UI state machine and tests cover all named states and zero-receiver reachability. | Proceed; keep token transient and test keyboard/error paths. |
| Task 3 self-check | Durable source state, authorization, task adapter, tests | The new `telegram-tasks.ts` contract and source tests align; no direct delivery ownership is included. | Proceed; source claim precedes task creation and recovery remains at-most-once. |
| Task 4 self-check | Renderer, dispatcher, budget, runtime, delivery tests | The task consumes Task 3 and owns only response publication; shared-budget tests pin fairness. | Proceed; do not expand into run creation or source journal schema. |
| Task 5 self-check | Docs, browser fixture/spec, release checks | The browser task exercises both stages and the docs describe only shipped behavior. | Proceed; live smoke test is controlled and uses no repository credential. |

## Rulings

- Ruling: use a separate `packages/contract/src/telegram-tasks.ts` file for Stage 2 source schemas — this prevents contract-file overlap between sequential agents and keeps task-origin shapes separate from receiver setup shapes; the cost is one additional contract module.
- Ruling: use the receiver's project and paired user's saved account by default for Telegram-originated tasks — this matches the current grant boundary and avoids introducing project/account selectors into chat commands; the cost is that cross-project work starts in the cockpit.
- Ruling: use one acknowledgement, one editable/coalesced status message where possible, and one final message with bounded follow-ups as fallback — this keeps chats readable and fits the shared budget; the cost is less granular progress than a raw event stream.
- Ruling: run implementation tasks sequentially and review each before dispatching the next — their interfaces are ordered even though their files are mostly disjoint; the cost is wall-clock time, offset by independent review gates.

## Tasks

- [x] Task 1 — Stage 1 backend setup orchestration (commits 4f73698ab..9cbeab8cd, review approved after three fix rounds; merged as local merge commit)
- [x] Task 2 — Stage 1 setup wizard UI (commits f27152e85..4f2fb18a4, review approved after two fix rounds; merged locally; 88 combined tests passed after installing declared test dependency)
- [x] Task 3 — Stage 2 source correlation and task creation (commits 333f32aa3..974020f5b, review approved after one fix round; merged locally; combined 325 tests passed)
- [x] Task 4 — Stage 2 response and progress delivery (commits 132096b5c..d2fd80f60, approved after five review/fix rounds; merged locally; focused 93/93)
- [x] Task 5 — Documentation, browser flow, integration, and release checks (commit 50534bbee, approved; e2e 1/1, docs 205, focused 63 tests)

## Five validation iterations

- [x] 1. Business behavior (recheck approved; 272 server + 33 web aliased tests, source/docs consistent)
- [x] 2. Technical correctness (stale progress race fixed; delayed-send regression 21/21)
- [x] 3. Security and privacy (approved; no P1/P2)
- [x] 4. UX/UI and accessibility (focus/recovery/docs fixes merged; focused UI/Telegram 93/93)
- [x] 5. Simplicity and operations (approved; no concrete operational defect)

## Final verification

- [x] Final guard pass — documented `POST /telegram/setup`, `GET /telegram/setup/:id`, and `POST /telegram/setup/:id/activate`; added required native-select `focus-visible` ring classes. Focused guard suite 43/43, full suite 13,117 passed/4 skipped, typecheck/build/check-pack/docs/e2e all green.
