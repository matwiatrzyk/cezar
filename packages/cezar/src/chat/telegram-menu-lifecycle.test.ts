import { it, expect, vi } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomInt } from 'node:crypto';
import type { AddressInfo } from 'node:net';
// Redirect only the wire destination: preserve production preparation, guards and real undici cancellation.
const wire = vi.hoisted(() => ({ url: '', signals: [] as AbortSignal[] }));
vi.mock('undici', async original => {
 const actual = await original<typeof import('undici')>();
 return { ...actual, request: (url: string, options: Parameters<typeof actual.request>[1]) => {
  wire.signals.push(options!.signal as AbortSignal);
  return actual.request(wire.url + new URL(url).pathname.split('/').at(-1), { ...options, dispatcher: undefined });
 } };
});
import { telegramClient } from './providers/telegram/client.ts';
import { telegramTransport } from './providers/telegram/transport.ts';
import { telegramSession } from './providers/telegram/session.ts';
import { telegramPresentation } from './providers/telegram/presentation.ts';
import { ChatBotRuntime } from './runtime.ts';
import { BotLease } from './ownership.ts';
import { freshState, InboundStateStore } from './state.ts';
import { Pairings } from './test-support/telegram-testing.testkit.ts';
const options = { token: async () => '123456789:' + 'A'.repeat(35), policy: { mode: 'local' as const, allowLocalNetwork: false, serverPorts: [] }, lookup: async () => [{ address: '8.8.8.8', family: 4 }] };
it('settles and cancels real HTTP menu before runtime stop releases ownership', async () => {
 const botId = String(randomInt(100000,99999999));
 let finishMenu!: () => void, menuDone = false, menuReceived = false;
 const server = createServer((req,res) => {
  const finish = (result: unknown) => res.end(JSON.stringify({ok:true,result}));
  if (req.url === '/getMe') finish({id:Number(botId),username:'test_bot'});
  else if (req.url === '/setMyCommands') { menuReceived = true; finishMenu = () => {menuDone = true; finish(true);}; }
 });
 server.listen(0,'127.0.0.1'); await once(server,'listening');
 wire.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`; wire.signals=[];
 const lease = await BotLease.acquire(botId);
 const binding = await lease.bind({projectId:'project', installationId:'installation',root:'/project'});
 const state = new InboundStateStore(freshState(botId,binding),{assertOwner:()=>lease.assertOwner(),async write(){}});
 const pairings = new Pairings(); pairings.create({receiverId:'receiver',botId,chatId:'456',deliveryRevision:1},'test_bot');
 let closed=false, menuSettled=false;
 const real = telegramClient(options);
 const transport = telegramTransport(async (...args) => {
  try { return await real(...args); } finally { if(args[0]==='setMyCommands') menuSettled=true; }
 }).guarded(()=> {try {lease.assertOwner();return !closed;}catch{return false;}});
 const runtime = new ChatBotRuntime({botId,state,lease,pairings,session:transport,presentation:telegramPresentation,
  connect: opts=>transport.connect(state,opts), receiver:()=>undefined,receivers:()=>[],assertCredentials:async()=>{},context:vi.fn(),deliver:vi.fn(),episode:()=>undefined,changed(){}});
 try {
  await runtime.start(); await vi.waitFor(()=>expect(menuReceived).toBe(true));
  closed=true; expect(await runtime.stop()).toBe(true);
  expect(menuSettled).toBe(true);
  await lease.release();
  const replacement=await BotLease.acquire(botId);
  try {expect(menuSettled).toBe(true); expect(menuDone).toBe(false);
   // getMe is first, menu second; shutdown must cancel the real request.
   expect(wire.signals[1]!.aborted).toBe(true);
   finishMenu(); await vi.waitFor(()=>expect(menuSettled).toBe(true)); expect(menuDone).toBe(true);
  } finally {await replacement.release();}
 } finally {finishMenu?.(); await runtime.stop(); await lease.release(); server.closeAllConnections(); await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
it('final production guard blocks menu after delayed token resolution and disposal', async()=>{
 let resolve!: (token:string)=>void, valid=true;
 const before=wire.signals.length;
 const client=telegramClient({...options,token:()=>new Promise(r=>resolve=r)});
 const pending=client('setMyCommands',{},undefined,{valid:()=>valid});
 valid=false;resolve(await options.token());
 await expect(pending).rejects.toMatchObject({code:'policy'}); expect(wire.signals.length).toBe(before);
});
it('production client translates raw vault failure into transient session error',async()=>{
 const session=telegramSession(telegramClient({...options,token:async()=>{throw new Error('vault temporarily locked');}}));
 await expect(session.identify()).rejects.toMatchObject({failure:{kind:'transient'}});
});
it('production menu deadline cancels stalled real HTTP within ten seconds',async()=>{
 let received=false;
 const server=createServer(()=>{received=true;}); server.listen(0,'127.0.0.1'); await once(server,'listening');
 wire.url=`http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
 const started=Date.now();
 try {
  await expect(telegramClient(options)('setMyCommands',{})).rejects.toMatchObject({code:'network'});
  expect(received).toBe(true);expect(Date.now()-started).toBeGreaterThanOrEqual(9900);expect(Date.now()-started).toBeLessThan(12000);
 } finally {server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
},15000);
it('baseline startup signal cancels already handed-off real HTTP menu',async()=>{
 let received=false;
 const server=createServer(()=>{received=true;}); server.listen(0,'127.0.0.1'); await once(server,'listening');
 wire.url=`http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
 const controller=new AbortController();
 try {
  const pending=telegramClient(options)('setMyCommands',{},controller.signal);
  const rejected=expect(pending).rejects.toMatchObject({code:'network'});
  await vi.waitFor(()=>expect(received).toBe(true));controller.abort();await rejected;
  expect(wire.signals.at(-1)!.aborted).toBe(true);
 } finally {server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});
it.each([200, 500])('menu response %s leaves startup and polling independent', async status => {
 let menuReceived = false;
 const server = createServer((req, res) => {
  menuReceived = true; res.statusCode = status;
  res.end(JSON.stringify({ ok: status === 200, result: true }));
 });
 server.listen(0, '127.0.0.1'); await once(server, 'listening');
 wire.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
 const journal = { recover: vi.fn(async () => {}), assertReady() {}, prepareReceive: vi.fn(), snapshot: () => ({ epoch: 'epoch', nextOffset: null }), duplicate: () => false, finish: vi.fn(), touch: vi.fn(), flush: vi.fn() };
 let menuSettled = false;
 const real = telegramClient(options);
 const connection = telegramTransport(async (...args) => {
  try { return await real(...args); } finally { menuSettled = true; }
 }).connect(journal, {
  needed: () => false, assertCredentials: async () => {}, process: async () => {}, accept: async () => {}, onHealth() {},
 });
 try {
  connection.start();
  await vi.waitFor(() => expect(menuReceived && menuSettled).toBe(true));
  await connection.stop();
  expect(journal.recover).toHaveBeenCalledOnce();
  expect(connection.health().state).toBe('stopped');
 } finally { await connection.stop(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
});
it('connection stop settles delayed menu credentials without starting a request', async () => {
 let resolve!: (token: string) => void;
 const before = wire.signals.length;
 let settled = false;
 const real = telegramClient({ ...options, token: () => new Promise(r => resolve = r) });
 const connection = telegramTransport(async (...args) => {
  try { return await real(...args); } finally { settled = true; }
 }).connect({ recover: async () => {}, assertReady() {}, prepareReceive: async () => {}, snapshot: () => ({ epoch: 'epoch', nextOffset: null }), duplicate: () => false, finish: async () => {}, touch: async () => {}, flush: async () => {} }, {
  needed: () => false, assertCredentials: async () => {}, process: async () => {}, accept: async () => {}, onHealth() {},
 });
 try {
  await connection.stop();
  expect(settled).toBe(true);
  resolve(await options.token());
  await new Promise(r => setTimeout(r, 20));
  expect(wire.signals.length).toBe(before);
 } finally { resolve(await options.token()); await connection.stop(); }
});
it('stop waits for menu settlement after cancellation is delivered', async () => {
 let release!: () => void, cancelled = false, stopped = false;
 const settlement = new Promise<void>(resolve => release = resolve);
 const real = telegramClient({ ...options, token: () => new Promise<string>(() => {}) });
 const connection = telegramTransport(async (...args) => {
  try { return await real(...args); } finally { cancelled = true; await settlement; }
 }).connect({ recover: async () => {}, assertReady() {}, prepareReceive: async () => {}, snapshot: () => ({ epoch: 'epoch', nextOffset: null }), duplicate: () => false, finish: async () => {}, touch: async () => {}, flush: async () => {} }, {
  needed: () => false, assertCredentials: async () => {}, process: async () => {}, accept: async () => {}, onHealth() {},
 });
 const stopping = connection.stop().then(() => { stopped = true; });
 try {
  await vi.waitFor(() => expect(cancelled).toBe(true));
  expect(stopped).toBe(false);
 } finally { release(); await stopping; }
 expect(stopped).toBe(true);
});
