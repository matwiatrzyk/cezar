# Telegram receivers — review, 2026-10-27

Scope: all 27 files in `a5e5bc74..aae3f4a8` (the cockpit's local autosave), plus surrounding delivery, activation, transport, API and form behavior. Product code was not changed. No live Telegram requests or messages were made during this review.

Verdict: changes requested before release. The sending adapter fits the existing system; setup needs reliability fixes. No new critical credential disclosure or SSRF bypass was identified in the inspected paths. This is not a security guarantee or a browser accessibility audit.

## Findings

### R1 — P2: automatic connection cannot see beyond the first 100 pending updates

`packages/cezar/src/webhooks/telegram-connect.ts:69`

Every poll asks for `{ limit: 100, timeout: 0 }` without an offset. Telegram returns the earliest unconfirmed updates. With 100 older updates ahead of `/start <code>`, all subsequent polls return the same page, and matching never succeeds during the setup window. The list of chats is likewise a selection from that page, not a directory of all chats the bot knows. The previous `allowed_updates` setting can also exclude the message types this feature needs.

Reproduced with a 101-update provider mock: the matching last update was absent on three successive polls (six provider calls). Official semantics: https://core.telegram.org/bots/api#getupdates .

Recommendation: detect saturated results and explain the limitation with a manual-ID fallback. Do not silently add an offset or negative offset: acknowledging/discarding another application's updates changes the safety contract. A dedicated-bot flow that consumes updates would require an explicitly designed alternative. Document the retained `allowed_updates` limitation too.

### R2 — P2: setup's 10-second deadline does not bound DNS

`packages/cezar/src/webhooks/telegram-connect.ts:15-19`

The timer aborts a controller, but `validateDestination()` is awaited directly and does not observe its signal. An unresolved DNS lookup keeps the call pending after the deadline. The browser's two-minute window is checked only after an awaited call returns, so it does not bound this case either. The existing delivery transport already avoids this with `untilAbort()`.

Reproduced with a never-resolving lookup and fake timers: the promise was still pending after 30 seconds, with no HTTP request issued.

Recommendation: reuse the bounded-await mechanism for DNS/imports, pass cancellation through the whole call, and impose an actual browser session deadline. Keep the existing pinned-address and public-network policy.

### R3 — P2: setup bypasses outbound concurrency/rate controls and server cancellation

`packages/cezar/src/webhooks/service.ts:618-633`; `packages/cezar/src/server/webhooks.ts:57`

Normal delivery uses `ProjectLimits`, scheduler acquisition and service/attempt abort signals. `telegramConnect()` calls the provider directly, twice per poll, with no admission limit, per-bot single-flight or service/request abort signal. Each call creates another undici Agent. Multiple forms/API callers can multiply outbound work; closing the form cancels the browser request but is not wired to cancel server work, including a subsequent `getUpdates` call. The per-Agent `connections: 1` does not cap concurrent Agents.

Recommendation: give setup an appropriately sized bounded concurrency/rate policy (not blindly the three-tests-per-minute budget), handle provider 429/backoff, and pass request/disposal cancellation through. Keeping network waits outside the mutation queue is correct and should remain so. Avoid fetching `getMe` on every poll where possible.

### R4 — P2: transient-error workaround silently retries permanent errors

`packages/web/src/routes/settings/telegram-connect.tsx:40-43`

After the first successful response, every rejection is retried at three-second intervals until the deadline. Revocation, receiver deletion, policy denial and another app's webhook conflict are treated like temporary connection failures. The user continues to see “Waiting for Telegram…” despite a known actionable error. Provider rate limiting is also reduced to a generic reachability error by the server.

Reproduced in a component test: after one success and a repeated conflict, four calls were made in ten seconds, no alert was shown, and the waiting message remained.

Recommendation: classify API errors by status/type; retry temporary failures, respect rate-limit timing, and surface permanent failures immediately. Preserve the live-test regression that retries a transient dropped connection.

### R5 — P2: the spec relies on a mandatory test that the product does not enforce

`.ai/specs/2026-10-27-telegram-webhook-receivers.md:242`; `packages/cezar/src/webhooks/endpoints.ts:186`; `packages/web/src/routes/settings/webhooks-section.tsx:227`

The spec calls Test-before-Activate a mitigation for an incorrect chat ID. Both API and UI permit an inactive receiver with `lastTest: 'none'` to activate. This is existing common webhook behavior, not a newly introduced regression: the guard is identical in the parent commit. The new Telegram registry test itself activates a freshly created receiver without testing it. An incorrect but valid ID can therefore send Standard task content to another chat that the bot can access.

Recommendation: reconcile the product promise and implementation. Either add the intended Telegram-specific prerequisite consistently in API and UI, or explicitly document optional testing and strengthen destination confirmation. A successful send alone also does not establish that the user inspected the intended chat. Do not silently change activation semantics for all existing providers.

### R6 — P2: connection success can describe a different chat from the saved value

`packages/web/src/routes/settings/webhook-form.tsx:91-93`; `packages/web/src/routes/settings/telegram-connect.tsx:66`

After discovery selects chat A, the user can edit Chat ID to B while the panel still says “Connected to A”. The child component receives the bot source but not the current chat ID, so it cannot invalidate that statement. Saving uses B. After a successful match the component also provides no direct action to select another chat using the same token.

Recommendation: reconcile the match with the current form value, clear stale confirmation on manual edits, and offer “Choose another chat”. Distinguish chat discovery from verified delivery permission.

## Smaller UX, documentation and maintenance notes

- The form/guide say all group IDs start with `-100`. That describes supergroups/channels, not ordinary groups. Keep acceptance of ordinary negative group IDs and correct the hint.
- The Telegram preview retains the shared timestamp/footer layout while the real renderer emits Project/Status/Task lines and no such footer. Make it representative or clearly label it schematic.
- The spec describes bare-code matching only for channel posts, while the implementation accepts it in any supported chat. Restrict it or document the actual rule; the code is a discovery correlation value, not an authentication boundary.
- The spec's old manual setup instructions and newer Connect flow should be reconciled. “Chats the bot knows” should say “chats found in pending updates”. Do not promise compatibility with all existing polling consumers merely because offset is omitted.
- Telegram token/path syntax is repeated across contract and form; reuse contract primitives where practical. No broad provider-framework rewrite is justified for one added adapter.
- `providerCode` and `providerGone` are two conventions for the same delivery outcome. A future provider-neutral transport outcome would be cleaner, but this does not block this adapter.
- `git diff --check HEAD^ HEAD` reports extra blank lines at EOF in service.test.ts, transport.test.ts and webhook-form.test.ts.

## What is sound

- Separate `telegramChatId` and a private token-bearing URL reuse existing storage, redaction and update semantics. Changing chat ID bumps deliveryRevision; pending delivery is fenced before claim. Leaving Telegram removes the stale field.
- Chained Hono route, Zod middleware, package contract types, typed client, scoped mounting and API inventory follow repository conventions. No new env variables, daemons or required user-authored configuration.
- Requests are restricted to public Telegram HTTPS addresses, TLS verification stays enabled, DNS is pinned, redirects are disabled, and setup responses have a size cap.
- Bot token redaction includes the path segment, full token and secret suffix. Success echoes are discarded; delivery diagnostics retain only bounded numbers and known phrases. Setup errors are fixed strings. No new token leak was found in these paths.
- Rendering consumes the existing privacy-filtered canonical event, escapes HTML and link attributes, neutralizes mentions, limits visible content, and does not introduce raw prompt/transcript transmission.
- Queue reuse, retry_after extraction, migration diagnostics and disabled-recipient behavior fit existing delivery handling. Keeping explicit chat selection instead of automatically applying migration IDs avoids silently changing recipients.
- The feature is one-way notifications. It does not implement answering questions, approvals, forum-topic targeting or a Telegram command bot; that scope remains appropriate and should be explicit.

## Evidence and limits

- `timeout 300 node node_modules/vitest/vitest.mjs run packages/cezar/src/webhooks packages/cezar/src/server/contract-parity.webhooks.test.ts packages/web/src/routes/settings/webhook-form.test.tsx`: **55 files / 609 tests passed**.
- Existing route tests (webhooks, webhooks-loopback, single-project-webhooks, route-parity, bc-route-inventory, typed-bodies, versioned-surface): **7 files / 39 tests passed**.
- Three temporary diagnostic tests reproduced R1, R2 and R4; **3/3 passed by asserting the faulty current behavior**. Temporary files were removed. These are reproduction evidence, not regression tests proving a fix.
- `timeout 180 npm run typecheck --ignore-scripts`: contract, client and server passed; web failed on the existing missing `capabilities.webhooks` fixture in served-boot-project.test.ts:15. Checked parent source; this task did not change that fixture. Release typecheck was not reached. Build prehook was intentionally skipped for this read-only review.
- No new full-suite run, package build, browser e2e or live Telegram send in this review. Previous live-test results are handoff evidence, not newly repeated validation. Existing tests do not establish browser layout, keyboard navigation, screen-reader behavior, or all setup failure/race cases.
- Test processes completed. Product source and tests were left unchanged; only this report was added.
