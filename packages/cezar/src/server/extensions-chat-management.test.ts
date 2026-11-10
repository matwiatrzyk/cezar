import {extensionInventoryResponseSchema} from '@open-mercato/cezar-contract';
import {execFileSync} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Hono} from 'hono';
import {expect,it,vi} from 'vitest';
import {RunStore} from '../runs/store.ts';
import {WebhookService} from '../webhooks/service.ts';
import {WebhookScheduler} from '../webhooks/scheduler.ts';
import type {ProjectContext} from './project-context.ts';
import {extensionRoutes,globalExtensionRoutes,closeProjectExtensions} from './extensions.ts';
const spawned=vi.hoisted(()=>vi.fn());
vi.mock('../extensions/worker-process.ts',async original=>{
 const actual=await original<typeof import('../extensions/worker-process.ts')>();
 return {...actual,spawnWorkerProcess:(...args:Parameters<typeof actual.spawnWorkerProcess>)=>{spawned();return actual.spawnWorkerProcess(...args)}};
});
it('allows only verified shipped enable/disable through the flag-off HTTP policy without a worker',async()=>{
 const root=await mkdtemp(join(tmpdir(),'chat-management-'));const dataDir=join(root,'.ai/cezar');
 execFileSync('git',['init','-q'],{cwd:root,timeout:5000});
 vi.stubEnv('CEZ_HOME',join(root,'home'));vi.stubEnv('CEZ_EXTENSIONS','0');vi.stubEnv('CEZ_WEBHOOKS','1');
 const store=RunStore.open(dataDir),project={id:'project',root,dataDir,store} as ProjectContext;
 const service=await WebhookService.open({root,dataDir,projectId:'project',mode:'local',serverPorts:()=>[],scheduler:new WebhookScheduler()});
 const app=new Hono<{Variables:{project:ProjectContext}}>().use('*',async(c,next)=>{c.set('project',project);await next()}).route('/api/v1',extensionRoutes(()=> 'flag disabled',()=>true)).route('/api/v1',globalExtensionRoutes(project,()=> 'flag disabled'));
 const post=(path:string,body:unknown={})=>app.request('/api/v1/extensions/'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
 try {
  const inventory=extensionInventoryResponseSchema.parse(await (await app.request('/api/v1/extensions/inventory')).json());
  expect(inventory.extensions.find(row=>row.record.manifest.id==='open-mercato.telegram')).toMatchObject({provenance:{kind:'bundled'},management:{enable:false,disable:true,update:false,uninstall:false}});
  const enabled=await post('open-mercato.telegram/enable',{integrity:inventory.extensions.find(row=>row.record.manifest.id==='open-mercato.telegram')!.record.integrity});
  expect(enabled.status,await enabled.text()).toBe(200);
  expect((await post('unknown/enable')).status).toBe(409);
  expect((await post('unknown/disable')).status).toBe(409);
  expect((await post('open-mercato.telegram/prepare-update')).status).toBe(409);
  expect((await app.request('/api/v1/extensions/open-mercato.telegram',{method:'DELETE'})).status).toBe(409);
  expect((await post('open-mercato.telegram/disable')).status).toBe(200);
  expect(spawned).not.toHaveBeenCalled();
 } finally {await service?.dispose();await closeProjectExtensions(project);store.flush();vi.unstubAllEnvs();await rm(root,{recursive:true,force:true});}
},20000);
