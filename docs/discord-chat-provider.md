# Discord provider

The shipped adapter lives in `packages/chat-plugins/discord`; see [adding-chat-provider.md](adding-chat-provider.md) for the provider contract.

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
