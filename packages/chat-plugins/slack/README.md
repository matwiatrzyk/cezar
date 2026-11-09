# Slack chat plugin

Standalone Slack Socket Mode provider for cezar. It uses only the public
`@open-mercato/cezar-extension-sdk` chat contract; credentials remain supplied
by the host and are never written by this package.

```sh
cd packages/chat-plugins/slack
npm install
npm test
npm run test:pack
```

Install the generated tarball through Settings → Extensions, then configure the
Slack connection in the project’s Integrations screen. The package identity is
`open-mercato.slack` and its provider id is `slack`; both remain stable across
folder and tarball installation. The bundled compatibility worker is unchanged.
