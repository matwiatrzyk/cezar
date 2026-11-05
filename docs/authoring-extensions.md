# Authoring an extension

Create `extension.json` and an ESM entry module. The manifest needs `id`, `name`, `version`,
`apiVersion: "1"`, `entry`, `permissions`, `panels`, and `actions`. A panel is declarative (`title`,
optional `text`, and action ids); an entry exports `onAction(actionId, input, context)` for actions.

Use `defineExtension` from `@open-mercato/cezar-extension-sdk` when authoring TypeScript. Install a
folder with its path, or an npm package already available to the cezar process. Installation is
paused by default; enable it per project after reviewing its manifest and source.
