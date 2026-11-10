import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createSlackAdapter} from '../dist/adapter.js';
import {test} from 'node:test';
for(const failedSlot of ['app','bot'])test('accepts an ACKed event before '+failedSlot+' renewal fails',async t=>{
let now=1800000000000; t.mock.method(Date,'now',()=>now);
let socket; const ack=[],accepted=[],tokens=[];
class Socket extends EventEmitter {readyState=1;send(x){ack.push(JSON.parse(x))}terminate(){this.emit('close')}}
const controller=new AbortController();
const adapter=createSlackAdapter({},async(method)=>{
 if(method==='auth.test')return {team_id:'T1',user_id:'U1'};
 if(method==='apps.connections.open')return {url:'wss://slack.com/socket'};
 if(method==='conversations.info')return {channel:{id:'C1',is_im:false,is_member:true}};
 throw Error(method);
},{lookup:async()=>[{address:'93.184.216.34',family:4}],socket:()=>{socket=new Socket();queueMicrotask(()=>socket.emit('open'));return socket}}, {credentials:{accessToken:async(slot)=>{tokens.push(slot);if(slot===failedSlot)throw Error('renewal unavailable');return 'fixture-token'}}});
const pending=adapter.receiveSession({signal:controller.signal,assertActive:async()=>controller.signal.throwIfAborted(),accept:async(x)=>{accepted.push(x)},health:async()=>{}});
await new Promise(r=>setImmediate(r)); now+=24000;
socket.emit('message',Buffer.from(JSON.stringify({envelope_id:'acked-before-renewal',type:'events_api',payload:{team_id:'T1',authorizations:[{user_id:'U1',is_bot:true}],event:{type:'message',channel:'C1',user:'U2',ts:'1800000024.000001',text:'<@U1> /task preserve me'}}})));
let error;try{await pending}catch(e){error=e.message}finally{await adapter.dispose()}
assert.equal(error,'renewal unavailable');assert.deepEqual(tokens,failedSlot==='app'?['app']:['app','bot']);
assert.equal(ack.length,1);
assert.equal(accepted.length,1,'An ACKed normalized event must reach receive acceptance before unrelated renewal failure');

});
