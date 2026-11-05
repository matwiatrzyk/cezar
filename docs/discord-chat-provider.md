# Discord provider integration contract

This is an internal compiled-in adapter. See the platform spec `.ai/specs/2026-11-04-discord-chat.md` for protocol behavior and limits.

`packages/cezar/src/chat/providers/discord/index.ts` exports:

- `discordServiceDescriptor`, `discordProvider`, `discordPresentation`.
- `discordTransport({token, dryRun?, request?, socket?}, valid?)`: real transport; request/socket are injected wire seams for offline tests. Construction performs no I/O. `token` accepts a string or async vault resolver, rechecked immediately before effects; a changed token fences the existing transport. `dryRun` blocks production REST/Gateway (tests must inject both wire seams).
- `encodeDiscordCredentials({token})` and `decodeDiscordCredentials(opaque): string`: shared codec, one raw token in the private vault.
- `discordChatId`: qualified channel-ID schema.
- `renderDiscordNotification(eventJson, {chatId, replyHint?}): ChatMessage`: accepts an already privacy-filtered webhook event. Shared generic notification rendering may use `discordPresentation` instead.

`server/discord-service.ts` exports `DiscordInbound` and `DiscordServiceDependencies`. Dependencies are the shared service dependencies except provider/transport/credentialTransport, plus `discord(receiverId): DiscordTransportOptions` and optional `discordCredential(opaque): DiscordTransportOptions`. The latter defaults to `{token: opaque}`. The facade reuses ChatInbound without another action/permission/storage system.

`packages/contract/src/discord-chat.ts` exports `discordSchemas` (the shared route factory instance), `discordBotTokenSchema`, and `discordInboundInvalidationSchema`. Root re-exports these from the contract index and uses the shared chained route builder for `/api/v1/discord` and `/api/v1/p/:projectId/discord`. Shared ID slots admit actor snowflakes and qualified channels; persisted role-specific schemas remain stricter.

`packages/web/src/lib/chat-providers/discord/index.ts` retains webhook-only `discordDescriptor` and exports `createDiscordDescriptor({api,setupApi,subscribe})`. Root supplies typed route ports and the `discord-inbound` subscription. The bot descriptor supplies `discoveryCommand(link,group?)`; shared setup and approval screens must render it as copyable text. `discordDiscoveryCommand` is separately exported. Discord itself does not consume the code embedded in the profile link fragment.

Root integration requirements:

1. Register the service descriptor and facade, route schemas/aliases and demand-driven invalidation.
2. Keep `discord.v1` webhook-only receivers unchanged. Atomically attach credentials, authenticated bot identity and discovered qualified channel to the SAME receiver, with expected revision and tested bot delivery before activation.
3. Store credentials in cezar-only ChatSecrets, never a receiver URL. Do not derive bot identity from the fixed destination URL; restart must restore/authenticate it explicitly.
4. Route bot-connected notifications through the shared send budget and this transport; persist its exact receipt plus private/group classification. Never fall back to webhook on any bot error.
5. Register the cockpit factory and explicit command rendering; complete same-receiver upgrade and restart e2e using the loopback fixture in `packages/web/e2e/discord-wire-fixture.mjs`.

A provider candidate is not completion of the full integration. Parent owns integration and four independent review/fix rounds; provider-local tests are not those rounds.
## Native `/tasks` command

Discord supports application commands over its HTTP command endpoint and
dynamic autocomplete interactions. The provider registers `/tasks` with an
optional `task` string option (`autocomplete: true`); the focused value is
resolved to at most 25 task choices and the selected value is passed to the
existing chat command semantics. This is provider-specific wire behavior: the
shared conversation remains responsible for authorization, visibility, and
execution.

Slack does not expose a dynamic suggestion callback for slash-command
arguments. Its native slash-command configuration has only a static usage
hint, so Slack is unchanged. Telegram’s `setMyCommands` similarly supplies a
static list shown after `/`; it has no dynamic argument-autocomplete API, so
Telegram is unchanged.
