// ABOUTME: Проверяет предметные гарантии через входы/выходы без реальных соседей.
// ABOUTME: Fake store существует только в тесте; runtime использует PostgreSQL.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {parseEvent,inputHash} from '../dist/contracts.js';
import {ingest,lookup} from '../dist/domain.js';
import {Fault} from '../dist/types.js';
const binding={ownerId:'owner',types:['event.recorded','message.incoming','operation.result','processing.resume'],recipients:['logs'],read:true,resume:true};
function event(type='event.recorded',data={recipient:'logs',payload:{value:1}}){return {version:1,eventId:randomUUID(),source:'source',type,occurredAt:'2026-10-30T00:00:00Z',correlationId:'chain',causationId:null,data};}
function fixture(){
 const packets=new Map(), controls=new Map();let starts=0,publishes=0,signals=0;
 const store={async register(e,b,h){const old=[...packets.values()].find(p=>p.eventId===e.eventId);if(controls.has(e.source+'/'+e.eventId))throw new Fault('EVENT_ID_CONFLICT');if(old){if(old.inputHash!==h)throw new Fault('EVENT_ID_CONFLICT');return structuredClone(old);}const p={id:randomUUID(),ownerId:b.ownerId,source:e.source,eventId:e.eventId,inputHash:h,original:e,mode:e.type==='event.recorded'?'jetstream':'temporal',state:'registered',dispatch:{},jobs:{},attempts:{},resumeVersion:0};packets.set(p.id,p);return structuredClone(p);},async get(id){return packets.has(id)?structuredClone(packets.get(id)):null;},async find(s,id){return [...packets.values()].find(p=>p.source===s&&p.eventId===id)??null;},async update(id,fn,identity){const p=structuredClone(packets.get(id));if(identity){const key=identity.source+'/'+identity.eventId,prior=controls.get(key);if([...packets.values()].some(v=>v.source===identity.source&&v.eventId===identity.eventId)||prior&&JSON.stringify(prior)!==JSON.stringify(identity))throw new Fault('EVENT_ID_CONFLICT');if(prior)return p;fn(p);controls.set(key,structuredClone(identity));}else fn(p);packets.set(id,p);return structuredClone(p);},async reject(){},async ready(){}};
 const ports={async startWorkflow(){starts++;},async publish(){publishes++;},async signalWorkflow(){signals++;}};
 return {store,ports,packets,counts:()=>({starts,publishes,signals})};
}
const delivery={source:'source',stream:'TEST',sequence:1};
test('hash ignores object key order, preserves arrays and changed payload',()=>{
 assert.equal(inputHash({b:1,a:[1,2]}),inputHash({a:[1,2],b:1}));
 assert.notEqual(inputHash([1,2]),inputHash([2,1]));
});
test('generic event needs no contact, message or files',()=>{
 const e=event();assert.deepEqual(parseEvent(Buffer.from(JSON.stringify(e))),e);
});
test('invalid UTF-8, NUL, lone surrogate, excess bytes and unknown fields rejected',()=>{
 for(const bytes of [Buffer.from([255]),Buffer.from(JSON.stringify({...event(),bad:1})),Buffer.from(JSON.stringify(event('event.recorded',{recipient:'logs',payload:{bad:'\u0000'}}))),Buffer.from(JSON.stringify(event('event.recorded',{recipient:'logs',payload:{bad:'\ud800'}}))),Buffer.alloc(131073)]) assert.throws(()=>parseEvent(bytes));
});
test('source spoof and forbidden recipient have no effects',async()=>{
 const f=fixture();
 await assert.rejects(ingest(f.store,f.ports,{source:binding},{...event(),source:'other'},delivery),{code:'FORBIDDEN'});
 await assert.rejects(ingest(f.store,f.ports,{source:binding},event('event.recorded',{recipient:'admin',payload:{}}),delivery),{code:'FORBIDDEN'});
 assert.equal(f.packets.size,0);
});
test('duplicate stream event forwards once and retains original',async()=>{
 const f=fixture(),e=event();
 await ingest(f.store,f.ports,{source:binding},e,delivery);await ingest(f.store,f.ports,{source:binding},e,delivery);
 assert.equal(f.counts().publishes,1);assert.equal([...f.packets.values()][0].state,'forwarded');
 await assert.rejects(ingest(f.store,f.ports,{source:binding},{...e,data:{recipient:'logs',payload:{changed:true}}},delivery),{code:'EVENT_ID_CONFLICT'});
});
test('failed publication remains registered; redelivery resumes',async()=>{
 const f=fixture(),e=event();let attempts=0;
 f.ports.publish=async()=>{if(++attempts===1)throw Error('lost');};
 await assert.rejects(ingest(f.store,f.ports,{source:binding},e,delivery));
 assert.equal([...f.packets.values()][0].state,'registered');
 await ingest(f.store,f.ports,{source:binding},e,delivery);assert.equal(f.packets.size,1);
});
test('database first registration survives failed Temporal start',async()=>{
 const f=fixture(),e=event('message.incoming',{});let attempts=0;
 f.ports.startWorkflow=async()=>{if(++attempts===1)throw Error('down');};
 await assert.rejects(ingest(f.store,f.ports,{source:binding},e,delivery));
 await ingest(f.store,f.ports,{source:binding},e,delivery);
 assert.equal(f.packets.size,1);assert.equal(attempts,2);
});
test('foreign result cannot complete another job; lost signal redelivers safely',async()=>{
 const f=fixture(),e=event();await ingest(f.store,f.ports,{source:binding},e,delivery);
 const p=[...f.packets.values()][0];p.jobs.job={id:'job',kind:'hermes',state:'pending',expectedSource:'source'};
 const result=event('operation.result',{packetId:p.id,operationId:'job',outcome:'succeeded',result:{ref:'stored'}});
 let n=0;f.ports.signalWorkflow=async()=>{if(++n===1)throw Error('lost');};
 await assert.rejects(ingest(f.store,f.ports,{source:binding},result,delivery));
 await ingest(f.store,f.ports,{source:binding},result,delivery);
 assert.equal((await f.store.get(p.id)).jobs.job.state,'succeeded');
 await assert.rejects(ingest(f.store,f.ports,{source:{...binding,ownerId:'foreign'}},result,delivery),{code:'NOT_FOUND'});
 await assert.rejects(ingest(f.store,f.ports,{source:binding},{...result,eventId:randomUUID(),data:{...result.data,result:{ref:'other'}}},delivery),{code:'RESULT_CONFLICT'});
});
test('resume compare-and-set never increments twice on redelivery',async()=>{
 const f=fixture(),e=event();await ingest(f.store,f.ports,{source:binding},e,delivery);
 const p=[...f.packets.values()][0];p.state='needs_attention';
 const resume=event('processing.resume',{packetId:p.id,expectedResumeVersion:0});
 await ingest(f.store,f.ports,{source:binding},resume,delivery);await ingest(f.store,f.ports,{source:binding},resume,delivery);
 assert.equal((await f.store.get(p.id)).resumeVersion,1);
});
test('read hides foreign owner and detects expected hash mismatch',async()=>{
 const f=fixture(),e=event();await ingest(f.store,f.ports,{source:binding},e,delivery);
 await assert.rejects(lookup(f.store,{...binding,ownerId:'foreign'},'source',e.eventId),{code:'NOT_FOUND'});
 await assert.rejects(lookup(f.store,binding,'source',e.eventId,'wrong'),{code:'EVENT_ID_CONFLICT'});
});

test('deep JSON and non-finite input are rejected as data errors',()=>{
 let nested={value:1};for(let i=0;i<70;i++)nested={nested};
 assert.throws(()=>parseEvent(Buffer.from(JSON.stringify(event('event.recorded',{recipient:'logs',payload:nested})))),{code:'INVALID_ARGUMENT'});
 assert.throws(()=>parseEvent(Buffer.from(JSON.stringify(event()).replace('"value":1','"value":1e400'))),{code:'INVALID_ARGUMENT'});
});

test('prototype property names are ordinary allowed recipients and reach publication',async()=>{
 for(const recipient of ['constructor','tostring','hasownproperty']) {
  const f=fixture(),e=event('event.recorded',{recipient,payload:{}});
  await ingest(f.store,f.ports,{source:{...binding,recipients:[recipient]}},e,delivery);
  assert.equal(f.counts().publishes,1);assert.equal([...f.packets.values()][0].state,'forwarded');
 }
});
test('control event ID binds its complete input across results, resume and ordinary events',async()=>{
 const f=fixture();await ingest(f.store,f.ports,{source:binding},event(),delivery);
 const p=[...f.packets.values()][0];p.jobs.job={id:'job',kind:'hermes',state:'pending',expectedSource:'source'};
 const result=event('operation.result',{packetId:p.id,operationId:'job',outcome:'unknown',result:{}});
 await ingest(f.store,f.ports,{source:binding},result,delivery);
 await assert.rejects(ingest(f.store,f.ports,{source:binding},{...result,data:{...result.data,outcome:'succeeded'}},delivery),{code:'EVENT_ID_CONFLICT'});
 await ingest(f.store,f.ports,{source:binding},{...result,eventId:randomUUID(),data:{...result.data,outcome:'succeeded'}},delivery);
 await assert.rejects(ingest(f.store,f.ports,{source:binding},{...event(),eventId:result.eventId},delivery),{code:'EVENT_ID_CONFLICT'});
 const current=await f.store.get(p.id);current.state='needs_attention';f.packets.set(p.id,current);
 const resume=event('processing.resume',{packetId:p.id,expectedResumeVersion:0});
 await ingest(f.store,f.ports,{source:binding},resume,delivery);
 await assert.rejects(ingest(f.store,f.ports,{source:binding},{...resume,data:{...resume.data,expectedResumeVersion:1}},delivery),{code:'EVENT_ID_CONFLICT'});
 assert.equal((await f.store.get(p.id)).resumeVersion,1);
});
test('successful analysis and memory require matching durable references and provenance',async()=>{
 const f=fixture(),e=event('message.incoming',{materialId:'material',revision:1});
 await ingest(f.store,f.ports,{source:binding},e,delivery);const p=[...f.packets.values()][0];
 p.jobs.u={id:'u',kind:'understand',attempt:0,state:'pending',expectedSource:'source'};
 p.jobs.m={id:'m',kind:'memory',attempt:0,state:'pending',expectedSource:'source'};
 const provenance={packetId:p.id,materialId:'material',revision:1,inputHash:p.inputHash};
 const send=(id,result)=>ingest(f.store,f.ports,{source:binding},event('operation.result',{packetId:p.id,operationId:id,outcome:'succeeded',result}),delivery);
 for(const result of [{},{resultRef:'u'},{resultRef:'u',provenance:{...provenance,inputHash:'0'.repeat(64)}},{resultRef:'u',provenance:{...provenance,revision:2}}])await assert.rejects(send('u',result),{code:'INVALID_JOB_RESULT'});
 assert.equal((await f.store.get(p.id)).jobs.u.state,'pending');
 await send('u',{resultRef:'understanding/v1',provenance});
 for(const result of [{},{resultRef:'memory/v1',provenance},{resultRef:'memory/v1',provenance,understandingRef:'wrong'}])await assert.rejects(send('m',result),{code:'INVALID_JOB_RESULT'});
 await send('m',{resultRef:'memory/v1',provenance,understandingRef:'understanding/v1'});
 assert.equal((await f.store.get(p.id)).jobs.m.state,'succeeded');
});
