import { getExtensionPanels, invokeExtensionAction } from './client'
import type { ExtensionPanel } from '@open-mercato/cezar-api-client'

export async function loadExtensionPanels(): Promise<ExtensionPanel[]> {
  return (await getExtensionPanels()).panels
}

export function runExtensionAction(extensionId: string, actionId: string, input?: Record<string, unknown>) {
  return invokeExtensionAction(extensionId, actionId, input)
}
