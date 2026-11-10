import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,chmod,symlink} from 'node:fs/promises'
import {join,relative} from 'node:path'
import {tmpdir} from 'node:os'
import {afterEach,expect,it,vi} from 'vitest'
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

const faults=vi.hoisted(()=>({failSelection:false,failRelease:false}))
vi.mock('node:fs/promises',async(importOriginal)=>{
 const original=await importOriginal<typeof import('node:fs/promises')>()
 return {...original,rm:async(path:Parameters<typeof original.rm>[0],options:Parameters<typeof original.rm>[1])=>{
  if(faults.failRelease&&String(path).includes('/selection-')){faults.failRelease=false;throw Error('injected release failure')}
  return original.rm(path,options)
 }}
})
vi.mock('../worktree-lifecycle/store.ts',async(importOriginal)=>{
 const original=await importOriginal<typeof import('../worktree-lifecycle/store.ts')>()
 return {...original,atomicLifecycleWrite:async(path:string,value:unknown)=>{
  if(faults.failSelection&&path.endsWith('/chat-selections/slack.json')){
   faults.failSelection=false;throw Error('injected selection commit failure')
  }
  return original.atomicLifecycleWrite(path,value)
 }}
})
it('review: shipped selection works with read-only global home',async()=>{
 const root=await mkdtemp(join(tmpdir(),'readonly-selection-'));roots.push(root)
 const home=join(root,'home'),data=join(root,'project');await mkdir(home);await chmod(home,0o500)
 try {
  const store=new ChatSelectionStore(data,home)
  expect(await store.read('slack')).toBeUndefined()
  await expect(store.replace('slack',null,{kind:'shipped'})).resolves.toMatchObject({target:{kind:'shipped'}})
 } finally {await chmod(home,0o700)}
})
it('review: failed first selection then explicit shipped does not retain an abandoned pin',async()=>{
 const {store,record,installed,installer}=await fixture()
 faults.failSelection=true
 await expect(store.replace('slack',null,{kind:'installed',record,localProviderId:'slack'})).rejects.toThrow('injected')
 expect(await store.read('slack')).toBeUndefined()
 await store.replace('slack',null,{kind:'shipped'})
 await installer.pruneArtifacts(record.manifest.id)
 await expect(readFile(join(installed.path,'dist/index.js'))).rejects.toMatchObject({code:'ENOENT'})
})
it('review: equivalent project paths release the same owner pin',async()=>{
 const {store,record,data,home,installed,installer}=await fixture()
 const selected=await store.replace('slack',null,{kind:'installed',record,localProviderId:'slack'})
 const reopened=new ChatSelectionStore(data+'/',home)
 await reopened.replace('slack',selected.revision,{kind:'shipped'})
 await installer.pruneArtifacts(record.manifest.id)
 await expect(readFile(join(installed.path,'dist/index.js'))).rejects.toMatchObject({code:'ENOENT'})
})

it('shipped-only changes never create an absent global home',async()=>{
 const {root,data}=await fixture(),home=join(root,'absent-home'),store=new ChatSelectionStore(data,home)
 const first=await store.replace('slack',null,{kind:'shipped'})
 await store.replace('slack',first.revision,{kind:'shipped'})
 await expect(readdir(home)).rejects.toMatchObject({code:'ENOENT'})
})
it('reconciles interrupted pin creation without touching another project selection',async()=>{
 const {store,data,home,record,installer,installed}=await fixture()
 const target={kind:'installed' as const,record,localProviderId:'slack'}
 const selected=await store.replace('slack',null,target)
 const other=new ChatSelectionStore(join(data,'other'),home)
 const otherSelection=await other.replace('slack',null,target)
 // Crash after pin creation but before the first selection commit.
 await writeFile(join(data,'extensions/chat-selections/slack.json.pending'),JSON.stringify([target]))
 await rm(join(data,'extensions/chat-selections/slack.json'))
 await new ChatSelectionStore(data,home).reconcile('slack')
 await installer.pruneArtifacts(record.manifest.id)
 expect(await readFile(join(installed.path,'dist/index.js'),'utf8')).toContain('must not execute')
 await other.replace('slack',otherSelection.revision,{kind:'shipped'})
 await installer.pruneArtifacts(record.manifest.id)
 await expect(readFile(join(installed.path,'dist/index.js'))).rejects.toMatchObject({code:'ENOENT'})
 expect(selected.target.kind).toBe('installed')
})
it('reconciles crash after selection commit and preserves a same-artifact replacement',async()=>{
 const {store,data,home,record,installer,installed}=await fixture(),target={kind:'installed' as const,record,localProviderId:'slack'}
 const first=await store.replace('slack',null,target)
 const next=await store.replace('slack',first.revision,target)
 const journal=join(data,'extensions/chat-selections/slack.json.pending')
 await writeFile(journal,JSON.stringify([target,target]))
 await new ChatSelectionStore(data,home).reconcile('slack')
 await installer.pruneArtifacts(record.manifest.id)
 expect(await readFile(join(installed.path,'dist/index.js'),'utf8')).toContain('must not execute')
 // The durable selection has advanced, but its old pin release was interrupted.
 await writeFile(journal,JSON.stringify([target]))
 await writeFile(join(data,'extensions/chat-selections/slack.json'),JSON.stringify({...next,target:{kind:'shipped'}}))
 await new ChatSelectionStore(data,home).reconcile('slack')
 await installer.pruneArtifacts(record.manifest.id)
 await expect(readFile(join(installed.path,'dist/index.js'))).rejects.toMatchObject({code:'ENOENT'})
})
it('canonical project ownership survives a symlink alias without releasing another owner',async()=>{
 const {store,data,home,root,record,installer,installed}=await fixture(),target={kind:'installed' as const,record,localProviderId:'slack'}
 const first=await store.replace('slack',null,target)
 const other=new ChatSelectionStore(join(root,'other'),home),second=await other.replace('slack',null,target)
 const alias=join(root,'project-alias');await symlink(data,alias)
 await new ChatSelectionStore(alias,home).replace('slack',first.revision,{kind:'shipped'})
 await installer.pruneArtifacts(record.manifest.id)
 expect(await readFile(join(installed.path,'dist/index.js'),'utf8')).toContain('must not execute')
 await other.replace('slack',second.revision,{kind:'shipped'})
 await installer.pruneArtifacts(record.manifest.id)
 await expect(readFile(join(installed.path,'dist/index.js'))).rejects.toMatchObject({code:'ENOENT'})
})

it('retries a failed old-pin release from the durable journal on reopen',async()=>{
 const {store,data,home,record,installer,installed}=await fixture()
 const first=await store.replace('slack',null,{kind:'installed',record,localProviderId:'slack'})
 faults.failRelease=true
 const next=await store.replace('slack',first.revision,{kind:'shipped'})
 expect(await store.read('slack')).toEqual(next)
 await expect(readFile(join(data,'extensions/chat-selections/slack.json.pending'))).resolves.toBeDefined()
 await new ChatSelectionStore(relative(process.cwd(),data),home).reconcile('slack')
 await installer.pruneArtifacts(record.manifest.id)
 await expect(readFile(join(installed.path,'dist/index.js'))).rejects.toMatchObject({code:'ENOENT'})
 await expect(readFile(join(data,'extensions/chat-selections/slack.json.pending'))).rejects.toMatchObject({code:'ENOENT'})
})
