# Task 2 keyboard review report

## Contract/API-client integration

The reviewed worktree initially had no local `node_modules`, so module resolution climbed to the parent checkout and loaded its older `@open-mercato/cezar-api-client` workspace. That stale package did not export `telegramInboundInvalidationSchema` or `createWebhookSchema`; six focused tests failed at `.safeParse`. Running the repository install in this worktree created the declared local workspace links. A resolution check then pointed at this worktree's `packages/api-client/src/index.ts` and confirmed both schemas are exported. No contract type was widened and no assertion was weakened.

## Keyboard coverage

- Added the established `@testing-library/user-event` helper as a web test dependency.
- Candidate: asserts `Review permissions` receives focus, presses Enter with `user.keyboard`, and asserts the permissions state.
- Completion: focuses the activation action, asserts that focus, presses Enter with `user.keyboard`, asserts the completed state, and asserts focus moves to `Set up another person`.
- Recovery: asserts `Try again` receives focus, presses Enter with `user.keyboard`, and asserts the token-selection state replaces recovery.
- Removed the synthetic `keyDown` followed by an independent click.

## Focused verification

Command (with `CEZ_REMOTE` unset):

```text
env -u CEZ_REMOTE npm test -- --run packages/web/src/routes/settings/telegram-inbound.test.tsx packages/web/src/routes/settings/webhooks-section.test.tsx

Test Files  2 passed (2)
     Tests  36 passed (36)
  Duration  2.92s
```

`git diff --check` passed. The final diff was reviewed for the two cherry-picked UI commits plus the keyboard test/dependency changes; capability gating, private-only setup, stale async protection, token non-rendering, and recovery UI remain covered by the focused suite.

## Commit

Keyboard implementation commit: `a32a630695f1babccb98572de797535ece838432`.
