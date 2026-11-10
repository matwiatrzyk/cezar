import { readFile, realpath } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { z } from 'zod'
import { extensionManifestSchema, type ExtensionManifest } from '@open-mercato/cezar-contract'
import { artifactIntegrity } from './installer.ts'
import { bundledPackageRoot } from './bundled-catalog.ts'
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
/** Only the host distribution catalog may grant a historical provider alias. */
export async function loadChatDeliveryCatalog(packageRoot = bundledPackageRoot()): Promise<ChatDeliveryArtifact[]> {
 const directory = join(packageRoot,'dist','chat-plugins')
 const stamps = z.array(stampSchema).length(3).parse(JSON.parse(await readFile(join(directory,'catalog.json'),'utf8')))
 if (new Set(stamps.map(item=>item.provider)).size !== 3 || new Set(stamps.map(item=>item.extensionId)).size !== 3) throw Error('Duplicate delivery identity')
 return Promise.all(stamps.map(async stamp => {
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
}
