# Slack local chat provider

Status: provider implementation candidate; shared integration and independent review rounds
belong to the parent. Extends `2026-11-04-chat-providers.md`.

## Wire and identity

Socket Mode opens with `apps.connections.open` using an app-level token; the bot token
performs `auth.test`, conversation inspection, membership, message send and update. No
public listener, plugin SDK, platform calls during import or webhook fallback exists.
Credentials are the canonical opaque JSON record `{appToken,botToken}` in ChatSecrets;
URLs never contain either value. Both tokens must belong to the same installed app.

Bot identity is `TTEAM:UBOT`. Authoritative `conversations.info` produces
`private:TTEAM:UBOT:DCHANNEL` or `group:TTEAM:UBOT:CHANNEL`, including private channels and
multiparty DMs as groups. The readable kind and bot namespace survive source/receipt and
receiver persistence and restart. Never infer privacy from Slack's channel prefix. Incoming
events must authorize this bot; interactions must reference this bot's message. Cross-team,
cross-bot and cross-chat effects fail closed. Unknown membership stays unknown.

Socket frames are acknowledged immediately by envelope ID before queued asynchronous work.
Core ChatInbox claims before task effects. Reconnect opens a fresh authenticated socket;
watchdog ping/pong bounds quiet broken connections. Stop aborts API work, closes the socket,
and drains queued work before lease release. Guards follow credential resolution and precede
wire effects. Authentication/blocked errors park; transient/rate errors back off.

Delivery is intentionally at-most-once, not exactly-once: retries are ACKed and discarded;
events predating connection creation are ignored; a bounded recent-ID watermark rejects
older events after ledger rollover. Slack disconnect/downtime, queue overflow, or a crash
after ACK can lose input. Users must resend after inspecting task state. No catch-up replays.

## Interaction and presentation

Use text commands in DMs, or bot mention plus command in groups. Slack native slash command
registration is not provided. Setup's URL carries `cezar_start`; the shared wizard must show
`slackDiscoveryCommand(link)` for the user to send manually. Clicking a Slack link does not
send a command. Incoming thread_ts always refers to the original root receipt.

Rendered text escapes &, < and > and neutralizes mentions. Limits are 4,000 rendered
characters, 25 buttons, 75-character labels; section blocks split safely at 3,000. Shared
budget rates are one per chat and ten per bot per second. Clearing controls sends `chat.update`
with the original text and section blocks; after a restart the text is read back from the bot's
own message (`conversations.history`, then `conversations.replies` for thread replies) and a
message it cannot read is left untouched. Read methods are form-encoded; only `chat.*` writes
send JSON. Optional `replyTo` on the provider-local
message schema maps to thread_ts; root must add/propagate this optional shared message field.
Without that shared propagation, outbound sends remain channel-root messages.

## Integration handoff

Register `slackServiceDescriptor`; compose `SlackInbound` with live `wire(receiverId)` and
`wireCredential(opaque)` factories. `createSlackWire` accepts a live credential resolver.
Use `slackIds` at shared persistence boundaries. The fixed destination is
`https://slack.com/api/chat.postMessage`; URL-derived bot identity is unavailable by design.
Root owns private credential resolution/redaction, generic route mounting and contracts,
shared registry, transactionally attaching bot fields to the SAME webhook receiver, and
outbound send/receipt budget integration. Root binds `createSlackDescriptor({api,setupApi,
subscribe})` in the UI registry and renders the discovery command. Existing webhook-only
`slackDescriptor` remains unchanged until that registration.

## Verification and sources

Provider tests run the unchanged seven-case core conformance suite through the real adapter
and simulated Slack Web API. Additional tests cover HTTP credential fences, errors, rendering,
private/group restart identity, normalization, ACK-before-work and stop draining. A real
loopback WebSocket test proves ACK, redelivery deduplication, reconnect and stop. Redelivered
envelopes (`retry_attempt` > 0) are processed, because the first attempt may have been sent while
the socket was down; event ids and the core's durable inbox claim keep effects exactly-once. External network
is blocked with the loopback guard `packages/web/e2e/slack-discord-netguard.c` (LD_PRELOAD); no
real workspace was contacted. Simulated browser e2e: `packages/web/e2e/slack-*.e2e.ts` and `discord-*.e2e.ts`.

Official protocol sources checked 2026-11-04:
- https://docs.slack.dev/apis/events-api/using-socket-mode/
- https://docs.slack.dev/apis/events-api/
- https://docs.slack.dev/reference/methods/conversations.info/
- https://docs.slack.dev/reference/objects/conversation-object/
- https://docs.slack.dev/reference/methods/chat.postMessage/
- https://docs.slack.dev/reference/methods/chat.update/
