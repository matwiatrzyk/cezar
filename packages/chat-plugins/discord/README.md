# Standalone Discord chat plugin

This package is a public-SDK-only Discord provider for cezar. Install the tarball
through the cockpit's Extensions flow, then configure the bot token in the
project's Integrations screen. It preserves Discord chat IDs, pairing and host
authorization; credentials and receive checkpoints remain owned by cezar.

```sh
npm run test:pack
```

The pack smoke builds the public SDK and this plugin, creates tarballs with
`--ignore-scripts`, and installs them in a fresh consumer outside the monorepo. It also verifies
activation by a packed cezar host.

The bundled compatibility provider is intentionally unchanged.
