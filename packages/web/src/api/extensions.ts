import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { subscribeTopic } from './ws'
import { cez, unwrap } from './client'

const extensions = cez.api.v1.p[':projectId'].extensions
export const extensionKeys = {
  all: (projectId: string) => ['extensions', projectId] as const,
  list: (projectId: string) => [...extensionKeys.all(projectId), 'list'] as const,
  panel: (projectId: string, extensionId: string, panelId: string) => [...extensionKeys.all(projectId), extensionId, 'panels', panelId] as const,
}
export async function listExtensions(projectId: string) {
  return unwrap(await extensions.access.$get({ param: { projectId } }), '/extensions')
}
export async function prepareExtension(projectId: string, source: string) {
  return unwrap(await cez.api.v1.extensions['prepare-install'].$post({ json: { source } }), '/extensions/prepare-install')
}
export async function commitExtension(projectId: string, preparedId: string) {
  return unwrap(await cez.api.v1.extensions['commit-install'].$post({ json: { preparedId } }), '/extensions/commit-install')
}
export async function enableExtension(projectId: string, extensionId: string, enabled: boolean, integrity?: string) {
  const route = extensions[':extensionId']
  return enabled
    ? unwrap(await route.enable.$post({ param: { projectId, extensionId }, json: { integrity: integrity ?? '' } }), '/extensions/enable')
    : unwrap(await route.disable.$post({ param: { projectId, extensionId } }), '/extensions/disable')
}
export async function uninstallExtension(projectId: string, extensionId: string, removeData = false) {
  return unwrap(await cez.api.v1.extensions[':extensionId'].$delete({ param: { extensionId }, query: { removeData: removeData ? 'true' : 'false' } }), '/extensions')
}
export async function loadExtensionPanel(projectId: string, extensionId: string, panelId: string) {
  return unwrap(await extensions[':extensionId'].panels[':panelId'].$get({ param: { projectId, extensionId, panelId } }), '/extensions/panels')
}
export async function runExtensionCommand(projectId: string, extensionId: string, commandId: string, input?: Record<string, unknown>) {
  const result = await unwrap(await extensions[':extensionId'].commands[':commandId'].invoke.$post({ param: { projectId, extensionId, commandId }, json: { input } }), '/extensions/commands/invoke')
  if (!result.ok) throw new Error(result.message ?? 'Extension command failed')
  return result
}

export async function loadExtensionForms(projectId: string, extensionId: string) {
  return unwrap(await extensions[':extensionId'].forms.$get({ param: { projectId, extensionId } }), '/extensions/forms')
}

export async function prepareExtensionUpdate(extensionId: string) { return unwrap(await cez.api.v1.extensions[':extensionId']['prepare-update'].$post({ param: { extensionId } }), '/extensions/prepare-update') }

export function useExtensionSubscription(projectId: string) {
  const client = useQueryClient()
  useEffect(() => subscribeTopic('extensions', () => { void client.invalidateQueries({ queryKey: extensionKeys.all(projectId) }) }), [client, projectId])
}
