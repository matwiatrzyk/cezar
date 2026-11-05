import type { ExtensionRecord } from '@open-mercato/cezar-contract'
import { ExtensionInstaller, type PreparedInstall } from './installer.ts'
export async function prepareUpdate(installer: ExtensionInstaller, current: ExtensionRecord | undefined, source: string): Promise<PreparedInstall> {
  const prepared = await installer.prepareInstall(source)
  if (current && prepared.manifest.id !== current.manifest.id) throw new Error('extension id cannot change during update')
  if (current && prepared.manifest.permissions.some(permission => !current.manifest.permissions.includes(permission))) throw new Error('new extension permissions require approval')
  return prepared
}
