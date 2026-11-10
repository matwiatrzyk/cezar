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

The bundled compatibility provider is intentionally unchanged.

Direct tarball installation through the cockpit UI is not currently supported.
The npm tarball smoke test does not establish that UI support or completion of
the independent-provider migration.
