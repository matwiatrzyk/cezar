import { build } from 'esbuild'
import { createServer } from 'node:http'
import { mkdtemp, writeFile, rm, cp, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { ExtensionManager } from './manager.ts'
import { chatTransport } from '../chat/registry.ts'

it('executes the distributed public Telegram entry in the ordinary worker against a loopback simulator', async () => {
 const root = await mkdtemp(join(tmpdir(),'public-chat-worker-'))
 const queue: unknown[] = [{update_id:40,edited_message:{ignored:true}},{update_id:41,message:{message_id:5,date:Math.floor(Date.now()/1000),chat:{id:-30,type:'group',title:'Group'},from:{id:40,is_bot:false,first_name:'Human'},text:'/tasks@cezar_bot',entities:[{type:'bot_command',offset:0,length:16}]}}]
 const requests: {method:string;body:Record<string,unknown>}[]=[]
 const server=createServer(async (request,response)=>{
  const chunks:Buffer[]=[]; for await(const chunk of request) chunks.push(Buffer.from(chunk))
  const body=JSON.parse(Buffer.concat(chunks).toString()) as Record<string,unknown>
  const method=request.url!.split('/').at(-1)!;requests.push({method,body})
  const result=method==='getMe'?{id:700001,username:'cezar_bot'}:method==='getUpdates'?queue.splice(0):method==='sendMessage'?{message_id:9,chat:{id:Number(body.chat_id)}}:true
  setTimeout(()=>{response.setHeader('content-type','application/json');response.end(JSON.stringify({ok:true,result}))},10)
 })
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r))
 const port=(server.address() as {port:number}).port
 const preload=join(root,'simulator.mjs')
 await writeFile(preload,`import dns from 'node:dns/promises';import tls from 'node:tls';import net from 'node:net';import {syncBuiltinESMExports} from 'node:module';
 dns.lookup=async hostname=>{if(hostname!=='api.telegram.org')throw Error('Network denied');return [{address:'8.8.8.8',family:4}]};
 tls.connect=(options,callback)=>{if(options.servername!=='api.telegram.org'&&options.host!=='api.telegram.org')throw Error('Network denied');const socket=net.connect({host:'127.0.0.1',port:${port}});socket.authorized=true;socket.encrypted=true;socket.on('connect',()=>{socket.emit('secureConnect');callback?.()});return socket};syncBuiltinESMExports();`)
 const source=join(root,'telegram'); await mkdir(join(source,'dist'),{recursive:true})
 for (const file of ['cezar-extension.json','package.json','README.md']) await cp(resolve('packages/chat-plugins/telegram',file),join(source,file))
 await build({entryPoints:[resolve('packages/chat-plugins/telegram/src/index.ts')],outfile:join(source,'dist/index.js'),bundle:true,platform:'node',format:'esm',target:'node20',banner:{js:"import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);"},external:['bufferutil','utf-8-validate']})
 const manager=new ExtensionManager(join(root,'data'),'project',root,{home:join(root,'home'),workerExecArgv:['--import',preload]})
 let connection: ReturnType<NonNullable<ReturnType<typeof chatTransport>>['connect']>|undefined
 try {
  await manager.install(source);await manager.setEnabled('open-mercato.telegram',true)
  const transport=chatTransport(root,'open-mercato.telegram/telegram',JSON.stringify({token:'700001:'+ 'A'.repeat(24)}))!
  expect(await transport.identify()).toMatchObject({id:'700001',username:'cezar_bot'})
  let nextOffset:number|null=40; const epoch=randomUUID(); const seen:unknown[]=[]
  connection=transport.connect({recover:async()=>{},assertReady(){},prepareReceive:async()=>{},snapshot:()=>({epoch,nextOffset}),duplicate:(_e,s)=>nextOffset!==null&&s<nextOffset,finish:async(_e,s)=>{nextOffset=s+1},touch:async()=>{},flush:async()=>{}},{accept:async()=>{throw Error('ordered event reached opaque inbox')},process:async update=>{seen.push(update)},needed:()=>true,assertCredentials:async()=>{},onHealth:()=>{}})
  connection.start();await expect.poll(()=>nextOffset).toBe(42)
  expect(seen).toEqual([expect.objectContaining({sequence:41,message:expect.objectContaining({chat:{id:'-30',kind:'group',title:'Group'},command:{kind:'command',name:'tasks',args:''}})})])
  expect(await transport.send('-30',{text:'Confirm <safe>',buttons:[[{text:'Confirm',data:'confirm:fixture'}]]})).toEqual({chatId:'-30',messageId:'9'})
  expect(requests.find(row=>row.method==='sendMessage')?.body).toMatchObject({text:'Confirm <safe>',reply_markup:{inline_keyboard:[[{text:'Confirm',callback_data:'confirm:fixture'}]]}})
  expect(requests.find(row=>row.method==='getUpdates')?.body.offset).toBe(40)
 } finally {
  await connection?.stop();await manager.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await rm(root,{recursive:true,force:true})
 }
},30000)
