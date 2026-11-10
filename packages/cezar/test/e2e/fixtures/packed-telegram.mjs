import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
const [root,host,plugin]=process.argv.slice(2)
// Every runtime import is from the newly installed tarball, outside the monorepo.
const load=path=>import(pathToFileURL(join(host,'dist',path)).href)
const {ExtensionManager}=await load('extensions/manager.js')
const {WebhookService}=await load('webhooks/service.js')
const {WebhookScheduler}=await load('webhooks/scheduler.js')
const {RunStore}=await load('runs/store.js')
const {createChatTask}=await load('server/run-messages.js')
const project=join(root,'project');await mkdir(project);execFileSync('git',['init','-q'],{cwd:project,timeout:5000})
const queue=[],sent=[],offsets=[],started=[]
let nextMessage=1
const server=createServer(async(req,res)=>{
 const chunks=[];for await(const chunk of req) chunks.push(chunk)
 const body=JSON.parse(Buffer.concat(chunks).toString()),method=req.url.split('/').at(-1)
 let result=true
 if(method==='getMe') result={id:700001,username:'cezar_bot',first_name:'Cezar'}
 if(method==='getChat') result={id:Number(body.chat_id),type:Number(body.chat_id)<0?'supergroup':'private',title:'Fixture'}
 if(method==='getChatMember') result={status:'member',user:{id:Number(body.user_id)}}
 if(method==='getWebhookInfo') result={url:''}
 if(method==='getUpdates') {offsets.push(body.offset);result=queue.splice(0).filter(row=>body.offset==null||row.update_id>=body.offset)}
 if(method==='sendMessage') {result={message_id:nextMessage++,chat:{id:Number(body.chat_id)}};sent.push({...body,receipt:result})}
 setTimeout(()=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:true,result}))},10)
})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
const port=server.address().port,preload=join(root,'simulator.mjs')
await writeFile(preload,`import dns from 'node:dns/promises';import tls from 'node:tls';import net from 'node:net';import {syncBuiltinESMExports} from 'node:module';
dns.lookup=async hostname=>{if(hostname!=='api.telegram.org')throw Error('Network denied');return [{address:'8.8.8.8',family:4}]};
tls.connect=(options,callback)=>{if(options.servername!=='api.telegram.org'&&options.host!=='api.telegram.org')throw Error('Network denied');const socket=net.connect({host:'127.0.0.1',port:${port}});socket.authorized=true;socket.encrypted=true;socket.on('connect',()=>{socket.emit('secureConnect');callback?.()});return socket};syncBuiltinESMExports();`)
const dataDir=join(project,'.ai/cezar'),provider='open-mercato.telegram/telegram'
let manager,service
const wait=async(predicate)=>{const until=Date.now()+10000;while(!predicate()){if(Date.now()>until)throw Error('Simulator condition timed out');await new Promise(r=>setTimeout(r,20))}}
async function open() {
 service=await WebhookService.open({root:project,dataDir,projectId:'project',mode:'local',serverPorts:()=>[],scheduler:new WebhookScheduler()})
 assert.ok(service)
 const store=await RunStore.open(dataDir)
 // Stop at the engine boundary: exercise the packed core authorization/Confirm
 // path without invoking an agent, spending money, or using live credentials.
 const context={id:'project',root:project,dataDir,store,manager:{startRun(workflow,options){started.push({workflow,options});return {id:options.chatSource.runId}}}}
 service.setChatInteractions({context:async()=>context,deliver:async()=>{throw Error('Unexpected reply')},
  createTask:(project,text,source,check,target)=>createChatTask(project,text,source,check,{providerActionError:async()=>null},target)})
 manager=new ExtensionManager(dataDir,'project',project,{home:process.env.CEZ_HOME,workerExecArgv:['--import',preload]})
}
async function close() {await service?.dispose();await manager?.close();service=undefined;manager=undefined}
try {
 await open();await manager.install(plugin);await manager.setEnabled('open-mercato.telegram',true)
 const inbound=service.chats.get(provider);assert.ok(inbound)
 const begun=await inbound.beginSetup({token:JSON.stringify({token:'700001:'+'A'.repeat(24)}),name:'Packed Telegram',dedicatedBot:true})
 const code=new URL(begun.deepLink).searchParams.get('start');assert.ok(code)
 queue.push({update_id:100,message:{message_id:1,date:Math.ceil(Date.now()/1000),chat:{id:41,type:'private'},from:{id:41,is_bot:false,first_name:'Person'},text:'/start '+code,entities:[{type:'bot_command',offset:0,length:6}]}})
 try {await wait(()=>inbound.setupStatus(begun.setupId).status==='candidate')} catch(error) {console.error(JSON.stringify({offsets:offsets.slice(-5),queue:queue.length,health:inbound.list().bots.map(bot=>bot.health),status:inbound.setupStatus(begun.setupId)}));throw error}
 const status=inbound.setupStatus(begun.setupId)
 await inbound.activateSetup(begun.setupId,{activate:true,expectedRevision:status.inboundRevision,candidateUserId:'41',permissions:['respond','start']})
 assert.equal(inbound.list().grants.length,1)
 await wait(()=>sent.length>0)
 const group=await inbound.beginSetup({token:JSON.stringify({token:'700001:'+'A'.repeat(24)}),name:'Packed group',dedicatedBot:true})
 const groupCode=new URL(group.deepLink).searchParams.get('start');assert.ok(groupCode)
 queue.push({update_id:101,message:{message_id:2,date:Math.ceil(Date.now()/1000),chat:{id:-42,type:'supergroup',title:'Packed group'},from:{id:41,is_bot:false,first_name:'Person'},text:'/start@cezar_bot '+groupCode,entities:[{type:'bot_command',offset:0,length:16}]}})
 await wait(()=>inbound.setupStatus(group.setupId).candidate?.chatType==='group')
 assert.equal(inbound.setupStatus(group.setupId).candidate.comparisonCode,undefined)
 queue.push({update_id:102,message:{message_id:3,date:Math.ceil(Date.now()/1000),chat:{id:41,type:'private'},from:{id:41,is_bot:false,first_name:'Person'},text:'/start '+groupCode,entities:[{type:'bot_command',offset:0,length:6}]}})
 await wait(()=>!!inbound.setupStatus(group.setupId).candidate?.comparisonCode)
 const groupStatus=inbound.setupStatus(group.setupId)
 const granted=await inbound.activateSetup(group.setupId,{activate:true,expectedRevision:groupStatus.inboundRevision,candidateUserId:'41',permissions:['respond'],comparisonVerified:true,groupVisibilityAccepted:true})
 assert.equal(granted.grant.chatId,'-42')
 assert.equal(inbound.list().grants.length,2)
 queue.push({update_id:103,message:{message_id:4,date:Math.ceil(Date.now()/1000),chat:{id:41,type:'private'},from:{id:41,is_bot:false},text:'/task investigate packed runtime',entities:[{type:'bot_command',offset:0,length:5}]}})
 await wait(()=>sent.some(row=>row.reply_markup?.inline_keyboard?.flat().some(button=>button.text==='Confirm')))
 assert.equal(started.length,0,'a preview must never start an agent')
 const preview=sent.find(row=>row.reply_markup?.inline_keyboard?.flat().some(button=>button.text==='Confirm'))
 const button=preview.reply_markup.inline_keyboard.flat().find(button=>button.text==='Confirm')
 const tap=id=>({update_id:id,callback_query:{id:'tap-'+id,data:button.callback_data,from:{id:41,is_bot:false},message:{message_id:preview.receipt.message_id,chat:{id:41,type:'private'}}}})
 queue.push(tap(104));await wait(()=>started.length===1)
 queue.push(tap(105));await wait(()=>offsets.includes(106))
 assert.equal(started.length,1,'repeated Confirm must not create a second task')
 assert.match(started[0].options.task,/investigate packed runtime/)
 assert.equal(started[0].options.chatSource.provider,provider)
 await close();await open();await manager.restore()
 const restored=service.chats.get(provider);assert.ok(restored)
 assert.equal(restored.list().grants.length,2)
 await wait(()=>offsets.includes(106))
 await manager.setEnabled('open-mercato.telegram',false)
 assert.equal(service.chats.has(provider),false)
 await manager.setEnabled('open-mercato.telegram',true)
 assert.equal(service.chats.get(provider).list().grants.length,2)
 console.log('PACKED_TELEGRAM_PAIR_RESTART_OK')
} finally {await close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
