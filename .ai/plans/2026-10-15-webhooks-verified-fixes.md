# Verified webhook corrections implementation plan

> Implement the already authorized corrections with TDD; independent domains may use separate cezar tasks. All changes and commits remain local.

Goal: correct the six reproduced defects at 0c53ab63 without reopening disputed review findings.
Spec: .ai/specs/2026-10-12-outbound-webhooks.md and ignored verification-2026-10-15/verification.md.
Architecture: preserve bounded transport, ownership fencing and default-off isolation. No new dependency, env flag, remote side effect or weakened destination policy.

## Tasks
- [x] Transport/URL (parent): add real-loopback undici test proving process survival and HTTP result, empty/streaming responses and abort cleanup; add create/edit contract cases for IP/localhost and invalid credentials/fragments/protocol. Observe red. Attach error handling before destroying unread response; retain immediate bounded disposal and diagnostic suppression. Use protocol-only URL syntax validation; destination policy remains authoritative. Verify transport, destination, contract and route tests.
- [x] Dispatch attention (child): red graph Finish and native attention tests with CEZ_WEBHOOKS unset; decouple snapshot persistence from CEZ:ASK dispatch Guard routing, preserve existing explicit Guard behavior. Verify graph/native/dispatch suites.
- [x] Payload privacy (child): red Standard failure/question/title tests containing Unix/Windows local paths; remove local paths before outbound persistence/render, preserve validated URLs and minimal metadata. Existing generic secret redactor must not change. Verify payload/source/service tests.
- [x] Clock limiter (child, same isolated security domain): red backward-clock test; rebase persisted rate timestamps on backward movement, preserving bounded burst and test/failure windows, including restart. Verify limiter/service tests.
- [x] Platform reporting (child): explicit unsupported-platform capability/reason with useful API/UI documentation; preserve Linux operation and flag-off behavior. No untested emulation of OS ownership. Test platform/flag combinations and route gate.
- [ ] Integrate each accepted child locally after diff/test validation; run all types, complete tests, build, Node/package checks. Fresh independent final review of combined correction diff, address confirmed regressions.

Review focus: unread/aborted real HTTP body; SSRF consent unchanged for local syntax; dispatch questions still reach parent when explicitly Guard; valid links survive privacy filtering; clock jumps never replenish repeatedly beyond burst; unsupported platform never displays enable instructions as a remedy.

Rulings: no automatic rewrite of audit-revision fence; no extra chat integrations; no broad UI refactor/performance optimization. Explicit unsupported platform is chosen over claiming untested macOS/Windows locking support.

Verification log: initial transport/URL8red→228pass; dispatch2red→272pass; privacy/clock9red→225pass; review privacy4red→229pass and ordinary-slash1red→230pass. Integrated per-merge checks51,245,167pass. Full gate pending. Independent reviews aa847971 (one privacy finding),89c0568e (privacy correction approved); ordinary-slash guard subsequently verified locally.
