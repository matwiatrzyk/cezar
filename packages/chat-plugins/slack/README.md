# Slack chat plugin

Standalone Slack Socket Mode provider for cezar. It uses only the public
`@open-mercato/cezar-extension-sdk` chat contract; credentials remain supplied
by the host and are never written by this package.

```sh
cd packages/chat-plugins/slack
npm test
npm run test:pack
```

`npm run test:pack` builds the SDK and plugin, packs both with lifecycle scripts disabled,
then installs the tarballs in a fresh directory outside the monorepo. It also verifies that the
installed plugin can be activated by a packed cezar host.

In Settings → Extensions, install a built local folder containing its runtime
dependencies, or an available npm package version, then configure the
Slack connection in the project’s Integrations screen. The package identity is
`open-mercato.slack` and its provider id is `slack`; both remain stable across
folder and npm installation. The bundled compatibility worker is unchanged.

Direct tarball installation through the cockpit UI is not currently supported.
The npm tarball smoke test above does not establish that UI support or completion
of the independent-provider migration.
