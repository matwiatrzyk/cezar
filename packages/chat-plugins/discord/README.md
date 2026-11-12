# Standalone Discord chat plugin

This package is a public-SDK-only Discord provider for cezar. In Settings → Extensions, install a built local
folder containing its runtime dependencies, or an available npm package version, then configure the bot token in the
project's Integrations screen. It preserves Discord chat IDs, pairing and host
authorization; credentials and receive checkpoints remain owned by cezar.

```sh
npm run test:pack
```

The pack smoke builds the public SDK and this plugin, creates tarballs with
`--ignore-scripts`, and installs them in a fresh consumer outside the monorepo. It also verifies
activation by a packed cezar host.

Cezar ships this same public artifact for its default integration; the private bundled runtime
is retired. A separately installed candidate replaces the native adapter only after explicit
project selection and approval in Extensions. The selected artifact stays pinned across host
and installation updates; disable/uninstall never silently falls back to shipped code.

This package has its own version, independent of the host release. Cezar pins its shipped version
and digest; updating that shipped copy requires a host update. With local `CEZ_EXTENSIONS=0`, only
the verified shipped artifact runs through the trusted in-process facade; installed selections
stay unavailable. Hosted mode runs no chat adapter. Missing or invalid artifacts do not activate
a private compatibility implementation.

Direct tarball installation through the cockpit UI is not currently supported.
