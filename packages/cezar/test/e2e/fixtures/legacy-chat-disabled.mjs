import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {readFile} from 'node:fs/promises';
const [legacy,project]=process.argv.slice(2);
const load=path=>import(pathToFileURL(join(legacy,'packages/cezar/src',path)).href);
const {WebhookService}=await load('webhooks/service.ts');
const {WebhookScheduler}=await load('webhooks/scheduler.ts');
const {readInboundState}=await load('chat/state.ts');
const dataDir=join(project,'.ai/cezar'),directory=join(dataDir,'webhooks/chat/telegram');
const before=await readFile(join(directory,'700001.json'),'utf8');
const saved=await readInboundState(directory,'700001');
assert.equal(saved.grants.length,2);assert.ok(saved.receivers.every(row=>!row.enabled));
let effects=0;
const forbidden=async()=>{effects++;throw Error('Old host must not activate disabled adapter')};
const service=await WebhookService.open({root:project,dataDir,projectId:'project',mode:'local',serverPorts:()=>[],scheduler:new WebhookScheduler(),telegramCall:()=>forbidden,send:forbidden});
assert.ok(service);
try {
 await service.telegram.start();
 assert.equal(service.telegram.list().grants.length,2);
 assert.ok(service.telegram.list().receivers.every(row=>row.state==='disabled'));
 assert.ok(service.endpoints.live().filter(row=>row.format==='telegram.v1').every(row=>row.state==='paused'));
 assert.equal(effects,0);
 assert.equal(await readFile(join(directory,'700001.json'),'utf8'),before);
} finally {await service.dispose()}
console.log('OLD_875_DISABLED_COMPATIBLE');
