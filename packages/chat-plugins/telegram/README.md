# Telegram chat plugin

This is a standalone cezar extension. Its runtime imports only the public
`@open-mercato/cezar-extension-sdk`; Telegram HTTP, validation and normalization live in this
package. The host still owns bot leases, durable acceptance, the receive checkpoint, pairing,
grants and task execution.

Build with `npm install && npm run build`. In Settings → Extensions, install this folder (or the
tarball produced by `npm pack`), approve it for the project, then configure the Telegram bot token
under Integrations. The extension identity is `open-mercato.telegram` and its provider contribution
is `telegram`; neither changes with the installation path.

The package does not replace cezar's bundled Telegram provider yet. It is the external vertical
slice used to prove the public receive protocol, including eventless durable checkpoints for
unsupported Telegram updates. Disabling extensions therefore leaves the existing compatibility
path and its environment-flag behavior unchanged.

Run `npm test` for adapter tests against a local Telegram API simulator. No live account is used.
