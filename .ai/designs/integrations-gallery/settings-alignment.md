# Integrations — settings alignment

Use the existing settings column and components, keep a compact tool gallery, and open every
configuration in that column. This replaces the mix of oversized cards, side sheets and pages.
Prepared with om-ux-shape (Review → Handoff), using the published skill from open-mercato/skills.

## What the repository shows

The inspected Agents, Resources and Secrets sections use max-w-2xl, p-4/md:p-6,
small semibold headings and 13px descriptions. SettingsField defines that heading rhythm.
Pill and StatusDot explicitly require neutral chip backgrounds with color in the dot.
The current gallery used max-w-5xl, tall cards and colored fills; only some configurations used sheets.
No .uxproof contract or local om-ux-shape override was found. These are code observations,
not evidence from user testing or a formal design contract.

## Chosen behavior

[ASSUMPTION] A stable gallery grouped by purpose makes tools easier to find across status changes.
Use SettingsField headings “Issue tracking”, “Testing”, and “Notifications”, compact two-column
cards (one column on narrow screens), and Pill status text plus a colored dot. No status-based
reordering. Each card is a single keyboard-accessible button named “Configure <tool>”.

All tools open a URL-backed detail view with “All integrations”, a small title and the current
status. Browser Back returns to the gallery and restores focus to the originating card.
Forms, actions and receiver-history dialogs retain their existing behavior. Project changes
unmount unsaved forms. Existing webhook bookmarks preserve receiver, tab and hash.

Loading: “Loading…”. Errors: “Status unavailable” and the existing “Retry” action.
Empty connections: “Not connected” / “Not configured”; opening still offers setup.
Disabled notifications: “Off on this server”, with existing opt-in guidance after opening.
The change does not modify credential storage, network permissions, backend limits or delivery.

## Why this direction

Keeping tall cards and sheets changes little of the inconsistent behavior. Expanding every form
inline would bury tool discovery under lengthy credentials and receiver lists. Compact cards plus
one consistent detail view preserve discovery while reusing existing forms and settings patterns.
Usability risk is medium (navigation changes); implementation and operational risk are low
(presentation and navigation only). No new AI interaction is proposed.

## Acceptance and limits

Verify every card opens its own configuration; Back and “All integrations” restore focus;
loading/error transitions do not move tools; project switching clears unsaved credentials;
legacy webhook links and nested history dialogs still work. Compare against Agents at desktop
and mobile widths, including light/dark themes. No horizontal overflow or blocked pointer events.
The intended outcome is completing configuration without learning a second navigation pattern;
reduced support burden is plausible, not measured. Automated tests cannot establish that people
find this faster; if task-based user feedback shows worse findability, revisit grouping first.

## Verification

292 targeted UI/routing tests and workspace typecheck passed. Four Chromium scenarios passed at
390px and 1440px, including browser Back, focus restoration, legacy URLs, receiver forms and
viewport bounds. Dark and light desktop screenshots plus the mobile Jira screen were inspected.
The browser run rebuilt the web app successfully. No live external delivery or native macOS
verification was performed. Local screenshots: [dark](settings-aligned-dark.png),
[light](settings-aligned-light.png).
