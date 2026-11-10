import {mkdtemp,mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {afterEach,expect,it} from 'vitest'
import {ExtensionInstaller} from './installer.ts'
import {ChatSelectionStore,isVerifiedChatSelection} from './chat-selection-store.ts'
import {registerSelectedChatSlot,projectChatExtensions} from '../chat/registry.ts'
const roots:string[]=[]
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})))})
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'chat-selection-'));roots.push(root)
 const home=join(root,'home'),data=join(root,'project','.ai','cezar'),source=join(root,'source');await mkdir(source)
 const manifest=JSON.parse(await readFile(new URL('../../../chat-plugins/slack/cezar-extension.json',import.meta.url),'utf8'))
 await mkdir(join(source,'dist'));await writeFile(join(source,'cezar-extension.json'),JSON.stringify(manifest));await writeFile(join(source,'package.json'),JSON.stringify({version:manifest.version}));await writeFile(join(source,'dist/index.js'),'throw Error("reads must not execute")')
 const installer=new ExtensionInstaller(home),prepared=await installer.prepareInstall(source),installed=await installer.commitInstall(prepared)
 const record={manifest:installed.manifest,source,installedAt:new Date().toISOString(),integrity:installed.integrity,enabled:true}
 return {root,home,data,installer,installed,record,store:new ChatSelectionStore(data,home)}
}
it('metadata reads are passive and absent selection means shipped default',async()=>{
 const {store,data}=await fixture();expect(await store.read('slack')).toBeUndefined();await expect(readdir(data)).rejects.toMatchObject({code:'ENOENT'})
})
it('pins an exact installed artifact across a closed project and installer pruning',async()=>{
 const {store,home,data,installer,installed,record}=await fixture()
 const selected=await store.replace('slack',null,{kind:'installed',record,localProviderId:'slack'})
 expect(selected.target.kind).toBe('installed')
 await installer.pruneArtifacts(record.manifest.id)
 expect(await readFile(join(installed.path,'dist/index.js'),'utf8')).toContain('must not execute')
 expect(await new ChatSelectionStore(data,home).read('slack')).toEqual(selected)
 const resolved=await store.resolve('slack');expect(resolved?.root).toBe(installed.path)
})
it('compare-and-swap rejects stale decisions without rewinding selection',async()=>{
 const {store,record}=await fixture()
 const first=await store.replace('slack',null,{kind:'installed',record,localProviderId:'slack'})
 await expect(store.replace('slack',null,{kind:'shipped'})).rejects.toThrow('changed')
 expect(await store.read('slack')).toEqual(first)
 const next=await store.replace('slack',first.revision,{kind:'shipped'});expect(next.revision).not.toBe(first.revision)
})
it('retains missing and modified selection metadata but refuses executable resolution',async()=>{
 const {store,installed,record}=await fixture()
 const selected=await store.replace('slack',null,{kind:'installed',record,localProviderId:'slack'})
 await writeFile(join(installed.path,'dist/index.js'),'tampered')
 await expect(store.resolve('slack')).rejects.toThrow('integrity')
 expect(await store.read('slack')).toEqual(selected)
 await rm(installed.path,{recursive:true});await expect(store.resolve('slack')).rejects.toThrow();expect(await store.read('slack')).toEqual(selected)
})
it('invalid local provider and modified candidate cannot earn a durable alias selection',async()=>{
 const {store,record,installed}=await fixture()
 await expect(store.replace('slack',null,{kind:'installed',record,localProviderId:'missing'})).rejects.toThrow('provider')
 await writeFile(join(installed.path,'dist/index.js'),'tampered')
 await expect(store.replace('slack',null,{kind:'installed',record,localProviderId:'slack'})).rejects.toThrow('integrity')
 expect(await store.read('slack')).toBeUndefined()
})
it('corrupt durable selection fails closed rather than becoming shipped default',async()=>{
 const {store,data}=await fixture();await mkdir(join(data,'extensions','chat-selections'),{recursive:true});await writeFile(join(data,'extensions','chat-selections','slack.json'),'{')
 await expect(store.read('slack')).rejects.toThrow();await expect(store.replace('slack',null,{kind:'shipped'})).rejects.toThrow()
})
it('explicit return to shipped releases only this project durable artifact pin',async()=>{
 const {store,data,home,record,installer,installed}=await fixture()
 const other=new ChatSelectionStore(join(data,'other'),home)
 const first=await store.replace('slack',null,{kind:'installed',record,localProviderId:'slack'})
 const second=await other.replace('slack',null,{kind:'installed',record,localProviderId:'slack'})
 await store.replace('slack',first.revision,{kind:'shipped'});await installer.pruneArtifacts(record.manifest.id)
 expect(await readFile(join(installed.path,'dist/index.js'),'utf8')).toContain('must not execute')
 await other.replace('slack',second.revision,{kind:'shipped'});await installer.pruneArtifacts(record.manifest.id)
 await expect(readFile(join(installed.path,'dist/index.js'))).rejects.toMatchObject({code:'ENOENT'})
})
it('a claimed manifest cannot change the permissions of an integrity-pinned artifact',async()=>{
 const {store,record}=await fixture()
 await expect(store.replace('slack',null,{kind:'installed',record:{...record,manifest:{...record.manifest,permissions:['project.read']}},localProviderId:'slack'})).rejects.toThrow('manifest mismatch')
 expect(await store.read('slack')).toBeUndefined()
})

it('only a frozen verified durable selection can declare a canonical slot',async()=>{
 const {store,root,record}=await fixture()
 await store.replace('slack',null,{kind:'installed',record,localProviderId:'slack'})
 const artifact=(await store.resolve('slack'))!;expect(isVerifiedChatSelection(artifact)).toBe(true)
 await expect(registerSelectedChatSlot(root,{...artifact})).rejects.toThrow('Unverified')
 expect(projectChatExtensions(root)).toEqual([])
 expect(()=>{artifact.manifest.permissions.push('project.read')}).toThrow()
 const slot=await registerSelectedChatSlot(root,artifact)
 try{expect(projectChatExtensions(root).map(provider=>provider.id)).toEqual(['slack'])}finally{await slot.dispose()}
})
