# Project integrations gallery

Owner requested a local implementation of the approved gallery concept (2026-10-27).
This is the settings presentation only, not the provider architecture proposed in
#1614 / draft #1613. It deliberately uses one gallery instead of the draft's separate
Issues & code / Test frameworks tabs.

Project Settings → Integrations contains Jira, Linear and TesterArmy e2e. Cards are
grouped by In use / Available; unknown or loading statuses are separate under Check
status with retry on failure. Jira/Linear connectivity requires both an association
and matching project credentials (or dry-run mode). TesterArmy distinguishes installed,
setting up, awaiting merge and incomplete setup. Its live setup run continues to use
the existing query/event cache rather than adding polling.

Selecting a card opens a keyboard-accessible, scrollable Sheet, full-width on phones.
The tracker form is filtered to the selected provider, retaining credential save,
project/team discovery, pagination, connection and disconnect operations. It never
exposes another provider's disconnect or credential-removal button. The existing
single issue-source limit is explained before replacing it; testing tools are independent.
TesterArmy retains the existing setup task, optional key and review/merge lifecycle.
A project switch unmounts the sheet and discards unsaved credentials. Moving a card
between groups after saving does not unmount its open form. Closing restores focus.

The old scoped and legacy `/settings/tracker` URLs redirect to the integrations gallery.
Current links and documentation use Integrations. No server contracts, credential
storage, real connections, or provider capabilities are changed by this implementation.

Validation: component tests cover concurrent tools, provider isolation, stale credentials,
status failure/retry, project switching, moving a card without closing its panel, and
awaiting merge. Browser tests cover old-route redirection, both widths, native forms,
Escape/focus and horizontal overflow, using synthetic API responses without real tokens.
