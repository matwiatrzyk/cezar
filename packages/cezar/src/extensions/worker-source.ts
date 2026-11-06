/** Executed in a separate Node process. Stdout is reserved for bounded RPC frames. */
export const workerSource = String.raw`
import { pathToFileURL } from 'node:url';
let extension, context, generation, manifest, disposed, stopping = false, seq = 0;
const commands = new Map(), panels = new Map(), forms = new Map(), chatProviders = new Map(), adapters = new Map(), pending = new Map(), listeners = new Set();
const events = []; let delivering = false;
async function deliverEvents() {
 if(delivering)return; delivering=true;
 try { while(events.length && !stopping) { const event=events.shift(); for(const listener of [...listeners]) { try { await listener(event); } catch {} } } }
 finally { delivering=false; }
}
const output = process.stdout.write.bind(process.stdout);
function send(value) { const frame = JSON.stringify(value); if(Buffer.byteLength(frame)>1048576) throw Error('extension IPC frame exceeds 1 MiB'); output(frame+'\n'); }
console.log = console.info = console.warn = console.error = () => {};
function request(method, params) {
 if(stopping) return Promise.reject(Error('extension stopped'));
 if(pending.size >= 100) return Promise.reject(Error('too many pending host calls'));
 const requestId = 'host-'+(++seq);
 return new Promise((resolve,reject) => {
  const timer=setTimeout(()=>{pending.delete(requestId);reject(Error('host RPC timed out'));},30000);
  pending.set(requestId,{resolve,reject,timer});
  try { send({type:'hostRequest',requestId,generation,method,params}); } catch(e) {clearTimeout(timer);pending.delete(requestId);reject(e);}
 });
}
function register(map, allowed, id, handler) {
 if(stopping || !allowed.some(item=>item.id===id)) throw Error('extension contribution is not declared');
 if(map.has(id)) throw Error('duplicate extension contribution');
 map.set(id,handler); return { dispose: async()=>{if(map.get(id)===handler) map.delete(id);} };
}
async function handle(m) {
 if(m.type==='hostResponse') {
  if(m.generation!==generation) return;
  const p=pending.get(m.requestId); if(!p)return; pending.delete(m.requestId);clearTimeout(p.timer);
  m.ok?p.resolve(m.result):p.reject(Error(m.error?.message ?? 'host call failed'));return;
 }
 if(m.type==='event') { if(m.generation===generation&&!stopping) { if(events.length>=64) { events.length=0; events.push({type:'resyncRequired'}); } else events.push(m.event); void deliverEvents(); } return; }
 if(m.type!=='request'||typeof m.requestId!=='string')return;
 try {
  let result;
  if(m.method==='activate') {
   if(extension) throw Error('already active');
   generation=m.generation; manifest=m.params.manifest;
   context=Object.freeze({ ...m.params.context,
    commands:{register:(id,handler)=>register(commands,[...manifest.actions,...(manifest.contributes?.commands??[])],id,handler)},
    panels:{register:(id,handler)=>register(panels,[...manifest.panels,...(manifest.contributes?.panels??[])],id,handler)},
    chat:{register:(id,factory)=>register(chatProviders,manifest.contributes?.chatProviders??[],id,factory)},
    forms:{register:(id,handler)=>register(forms,manifest.contributes?.forms??[],id,handler)},
    tasks:{list:()=>request('tasks.list',{}),propose:input=>request('tasks.propose',input)},
    storage:{get:key=>request('storage.get',{key}),set:(key,value)=>request('storage.set',{key,value})},
    secrets:{get:key=>request('secrets.get',{key}),set:(key,value)=>request('secrets.set',{key,value})},
    logger:{info:message=>request('logger.info',{message}),error:message=>request('logger.error',{message})},
    taskEvents:{subscribe:handler=>{if(manifest.capabilities && !manifest.capabilities.includes('taskEvents'))throw Error('taskEvents capability is not declared');listeners.add(handler);return {dispose:async()=>listeners.delete(handler)};}}
   });
   const module=await import(pathToFileURL(m.params.entry).href); extension=module.default??module.extension??module;
   disposed=await extension.activate?.(context);
   for(const declaration of manifest.contributes?.chatProviders??[]) if(!chatProviders.has(declaration.id))throw Error('chat provider has no factory');
  } else {
   if(m.generation!==generation)throw Error('stale generation');
   if(m.method==='deactivate') {
    stopping=true; for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('extension stopped'));}pending.clear();
    for(const adapter of adapters.values()) await (await adapter).dispose?.(); adapters.clear(); chatProviders.clear();
    await disposed?.dispose?.(); await extension?.deactivate?.();commands.clear();panels.clear();forms.clear();listeners.clear();events.length=0;
   } else if(stopping) throw Error('extension stopped');
   else if(m.method==='invoke') {
    const action=[...manifest.actions,...(manifest.contributes?.commands??[])].find(a=>a.id===m.params.actionId);
    if(!action)throw Error('extension action is not declared');
    const handler=commands.get(action.id);
    if(handler) result=await handler(m.params.input,context);
    else if(extension.onAction) result=await extension.onAction(action.id,m.params.input,context);
    else throw Error('extension command has no handler');
   } else if(m.method==='chat') {
    const {providerId,credential,operation,input}=m.params;
    if(!chatProviders.has(providerId))throw Error('chat provider is not declared');
    const key=JSON.stringify([providerId,credential]);
    if(!adapters.has(key)) {
      if(adapters.size>=20)throw Error('too many chat connections');
      adapters.set(key,Promise.resolve(chatProviders.get(providerId)(JSON.parse(credential))));
    }
    const adapter=await adapters.get(key);
    if(stopping || m.generation!==generation)throw Error('stale generation');
    if(operation==='identify')result=await adapter.identify();
    else if(operation==='inspect')result=await adapter.inspect(input.chatId);
    else if(operation==='send')result=await adapter.send(input.chatId,input.message);
    else if(operation==='clearButtons')result=await adapter.clearButtons(input);
    else if(operation==='acknowledge')result=await adapter.acknowledge(input.eventId,input.text);
    else if(operation==='isMember')result=await adapter.isMember(input.chatId,input.userId);
    else if(operation==='receive')result=await adapter.receive(input.after);
    else throw Error('unknown chat operation');
   } else if(m.method==='form') {
    const declaration=(manifest.contributes?.forms??[]).find(p=>p.id===m.params.formId);
    if(!declaration)throw Error('extension form is not declared');
    result=forms.has(declaration.id)?await forms.get(declaration.id)():declaration;
   } else if(m.method==='panel') {
    const declaration=[...manifest.panels,...(manifest.contributes?.panels??[])].find(p=>p.id===m.params.panelId);
    if(!declaration)throw Error('extension panel is not declared');
    result=panels.has(declaration.id)?await panels.get(declaration.id)():declaration;
   } else throw Error('unknown method');
  }
  send({type:'response',requestId:m.requestId,generation:m.generation,ok:true,result});
 } catch(e) {send({type:'response',requestId:m.requestId,generation:m.generation,ok:false,error:{code:'EXTENSION_ERROR',message:e instanceof Error?e.message:String(e),...(e?.failure ? {failure:e.failure} : {})}});}
}
let buffer=Buffer.alloc(0);
process.stdin.on('data',chunk=>{
 buffer=Buffer.concat([buffer,chunk]); let end;
 while((end=buffer.indexOf(10))!==-1){if(end>1048576)process.exit(31);const line=buffer.subarray(0,end);buffer=buffer.subarray(end+1);try{void handle(JSON.parse(line.toString()));}catch{process.exit(32);}}
 if(buffer.length>1048576)process.exit(31);
});
process.stdin.on('end',()=>process.exit(0));
`
