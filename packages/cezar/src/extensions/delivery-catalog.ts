import { readFile, realpath } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { z } from 'zod'
import { extensionManifestSchema, type ExtensionManifest } from '@open-mercato/cezar-contract'
import { artifactIntegrity } from './installer.ts'
import { fileURLToPath } from 'node:url'
export function chatDeliveryPackageRoot():string { return resolve(dirname(fileURLToPath(import.meta.url)), '../..') }
const stampSchema = z.object({provider:z.enum(['telegram','slack','discord']),extensionId:z.string(),version:z.string(),integrity:z.string().startsWith('sha512-')}).strict()
export type ChatDeliveryArtifact = z.infer<typeof stampSchema> & {root:string;entry:string;manifest:ExtensionManifest}
function freezeVerified<T>(value: T): T {
 if (value && typeof value === 'object') {
  for (const child of Object.values(value)) freezeVerified(child)
  Object.freeze(value)
 }
 return value
}
const verifiedArtifacts = new WeakSet<ChatDeliveryArtifact>()
export function isVerifiedChatDelivery(value: ChatDeliveryArtifact): boolean { return verifiedArtifacts.has(value) }
/** Only the host distribution catalog may grant a historical provider alias.
 * Catalog identity is validated as a whole; unavailable artifacts do not hide healthy peers.
 * A provider-specific request preserves its verification error for startup diagnostics.
 */
export async function loadChatDeliveryCatalog(packageRoot = chatDeliveryPackageRoot(), provider?: ChatDeliveryArtifact['provider']): Promise<ChatDeliveryArtifact[]> {
 const directory = join(packageRoot,'dist','chat-plugins')
 const stamps = z.array(stampSchema).length(3).parse(JSON.parse(await readFile(join(directory,'catalog.json'),'utf8')))
 if (new Set(stamps.map(item=>item.provider)).size !== 3 || new Set(stamps.map(item=>item.extensionId)).size !== 3) throw Error('Duplicate delivery identity')
 const results = await Promise.allSettled(stamps.filter(stamp => !provider || stamp.provider === provider).map(async stamp => {
  const root = join(directory,stamp.provider)
  if (await artifactIntegrity(root) !== stamp.integrity) throw Error('Chat delivery artifact integrity mismatch')
  const manifest = extensionManifestSchema.parse(JSON.parse(await readFile(join(root,'cezar-extension.json'),'utf8')))
  const pkg = JSON.parse(await readFile(join(root,'package.json'),'utf8')) as {version?:unknown}
  if (manifest.id !== stamp.extensionId || manifest.version !== stamp.version || pkg.version !== stamp.version || manifest.contributes?.chatProviders?.length !== 1 || manifest.contributes.chatProviders[0]?.id !== stamp.provider) throw Error('Chat delivery identity mismatch')
  const entry = await realpath(join(root,manifest.entry))
  if (relative(await realpath(root),entry).startsWith('..')) throw Error('Chat delivery entry escaped artifact')
  const artifact = freezeVerified({...stamp,root,entry,manifest})
  verifiedArtifacts.add(artifact)
  return artifact
 }))
 const artifacts: ChatDeliveryArtifact[] = []
 for (const result of results) {
  if (result.status === 'fulfilled') artifacts.push(result.value)
  else if (provider) throw result.reason
 }
 return artifacts
}
