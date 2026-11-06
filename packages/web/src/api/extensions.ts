import { cez, unwrap } from './client'

const extensions = cez.api.v1.p[':projectId'].extensions
export const extensionKeys = {
  all: (projectId: string) => ['extensions', projectId] as const,
  list: (projectId: string) => [...extensionKeys.all(projectId), 'list'] as const,
  panel: (projectId: string, extensionId: string, panelId: string) => [...extensionKeys.all(projectId), extensionId, 'panels', panelId] as const,
}
export async function listExtensions(projectId: string) {
  return unwrap(await extensions.$get({ param: { projectId } }), '/extensions')
}
export async function prepareExtension(projectId: string, source: string) {
  return unwrap(await extensions['prepare-install'].$post({ param: { projectId }, json: { source } }), '/extensions/prepare-install')
}
export async function commitExtension(projectId: string, preparedId: string) {
  return unwrap(await extensions['commit-install'].$post({ param: { projectId }, json: { preparedId } }), '/extensions/commit-install')
}
export async function enableExtension(projectId: string, extensionId: string, enabled: boolean) {
  const route = extensions[':extensionId']
  return enabled
    ? unwrap(await route.enable.$post({ param: { projectId, extensionId } }), '/extensions/enable')
    : unwrap(await route.disable.$post({ param: { projectId, extensionId } }), '/extensions/disable')
}
export async function uninstallExtension(projectId: string, extensionId: string) {
  return unwrap(await extensions[':extensionId'].$delete({ param: { projectId, extensionId } }), '/extensions')
}
export async function loadExtensionPanel(projectId: string, extensionId: string, panelId: string) {
  return unwrap(await extensions[':extensionId'].panels[':panelId'].$get({ param: { projectId, extensionId, panelId } }), '/extensions/panels')
}
export async function runExtensionCommand(projectId: string, extensionId: string, commandId: string) {
  const result = await unwrap(await extensions[':extensionId'].commands[':commandId'].invoke.$post({ param: { projectId, extensionId, commandId }, json: {} }), '/extensions/commands/invoke')
  if (!result.ok) throw new Error(result.message ?? 'Extension command failed')
  return result
}
