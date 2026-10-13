import { createServer } from 'node:http';
import { randomBytes, createHmac } from 'node:crypto';
import { strict as assert } from 'node:assert';
import { createRelay, openCompletedStore } from '/recipes/webhook-relay.mjs';
const key=randomBytes(32), secret='whsec_'+key.toString('base64'); let posts=0, fail=false;
const post=async()=>{posts++; if(fail){fail=false;throw Error('fixture failure')}};
let handler=createRelay({secrets:[secret],store:await openCompletedStore('/test/completed.json'),post});
const server=createServer(async(req,res)=>{const chunks=[];for await(const c of req)chunks.push(c); const code=await handler({raw:Buffer.concat(chunks),headers:req.headers});res.writeHead(code).end()});
await new Promise(r=>server.listen(8788,'127.0.0.1',r));
function input(id){const body=JSON.stringify({id,type:'webhook.test',schemaVersion:1,occurredAt:new Date().toISOString(),data:{test:true,format:'cezar.json.v1'}});const timestamp=String(Math.floor(Date.now()/1000));return {body,headers:{'content-type':'application/json','webhook-id':id,'webhook-timestamp':timestamp,'webhook-signature':'v1,'+createHmac('sha256',key).update(`${id}.${timestamp}.${body}`).digest('base64')}}}
async function send(value){const response=await fetch('http://127.0.0.1:5678/webhook/cezar-lifecycle',{method:'POST',...value,signal:AbortSignal.timeout(10000)});const body=await response.text();console.log('response',response.status,body.slice(0,100));return response.status}
try{
for(let i=0;i<100;i++){try{if((await fetch('http://127.0.0.1:5678/healthz/readiness')).ok)break}catch{}await new Promise(r=>setTimeout(r,200))}
const a=input('evt_first'); let initial; for(let i=0;i<100;i++){initial=await send(a);if(initial!==404)break;await new Promise(r=>setTimeout(r,200))} assert.equal(initial,204); assert.equal(posts,1); assert.equal(await send(a),204);assert.equal(posts,1);
const bad={...a,body:a.body+' '};assert.equal(await send(bad),401);assert.equal(posts,1);
fail=true;const b=input('evt_retry');assert.equal(await send(b),503);assert.equal(await send(b),204);assert.equal(posts,3);
const c=input('evt_concurrent');assert.deepEqual(await Promise.all([send(c),send(c)]),[204,204]);assert.equal(posts,4);
handler=createRelay({secrets:[secret],store:await openCompletedStore('/test/completed.json'),post});assert.equal(await send(c),204);assert.equal(posts,4);
console.log('PASS n8n 2.43.4 raw bytes, signature rejection, successful dedupe, failed-chat retry, concurrent duplicates and durable restart');
}finally{await new Promise(r=>server.close(r))}
