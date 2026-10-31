// ABOUTME: Проверяет согласованность профиля, снимка и квитанций через порты ядра.
// ABOUTME: Транзакционная конкуренция и права БД проверяются отдельной интеграцией.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createService,observe,snapshot,newer} from '../dist/domain.js';
const q=(extra={})=>({operationId:randomUUID(),packetId:randomUUID(),ownerId:'owner',sourceId:'telegram',identity:{namespace:'telegram',externalId:'123'},observedAt:'2026-10-31T10:00:00.000001Z',profile:{name:'Alice'},...extra});
const origin=(extra={})=>({observedAt:'2026-10-31T10:00:00.000001Z',sourceId:'telegram',callerId:'intake',operationId:'a',...extra});
const current=()=>({id:randomUUID(),contactId:randomUUID(),ownerId:'owner',namespace:'telegram',externalId:'123',name:null,username:null,photoArtifactId:null,fieldOrigins:{name:null,username:null,photoArtifactId:null},firstObservedAt:'2026-10-31T10:00:00.000001Z',lastObservedAt:'2026-10-31T10:00:00.000001Z'});
function fixture(){
 const rows=new Map(),receipts=new Map();const key=(c,o,id)=>JSON.stringify([c,o,id]);
 const r={async lock(){},async ready(){},async timestamp(v){return v??'2026-10-31T12:00:00.000001Z';},async operation(c,o,id){return receipts.get(key(c,o,id))??null;},async saveOperation(c,op,q,h,result){receipts.set(key(c,q.ownerId,q.operationId),{operation:op,inputHash:h,result:structuredClone(result)});},async identity(o,id){return rows.get(key('',o,id))??null;},async createIdentity(v){rows.set(key('',v.ownerId,v.externalId),structuredClone(v));},async updateIdentity(v){rows.set(key('',v.ownerId,v.externalId),structuredClone(v));}};
 const callers={intake:{ownerIds:['owner','other'],sourceIds:['telegram','another_bot'],operations:['resolve','profile.observe','operations.get']}},service=createService({async transaction(ctx,work){return work(r);}},callers,Buffer.alloc(32,7));
 return {rows,receipts,callers,run:(op,v)=>service.execute(op,'intake',v,{deadline:performance.now()+5000})};
}
test('per-field ordering, microseconds, stable tie and immutable observation snapshot',()=>{
 const old=current(),a=observe(old,{name:'Alice',username:'u'},origin()).identity;
 const b=observe(a,{name:'Stale'},origin({observedAt:'2026-10-31T10:00:00.000000Z'})).identity;
 assert.equal(b.name,'Alice');assert.deepEqual(snapshot({name:'Stale'}),{name:'Stale',username:null,photoArtifactId:null,observedFields:['name']});
 const c=observe(b,{name:null},origin({operationId:'z'})).identity;assert.equal(c.name,null);assert.equal(c.username,'u');assert.equal(old.name,null);assert.ok(newer(origin({operationId:'z'}),origin()));
 assert.deepEqual(observe(c,{},origin({operationId:'zz'})).identity.name,null);
});
test('same external identity across sources gives one contact; owner and external ID isolate',async()=>{
 const f=fixture(),first=await f.run('resolve',q()),second=await f.run('resolve',q({sourceId:'another_bot'}));
 assert.equal(first.contactId,second.contactId);assert.notEqual(first.contactId,(await f.run('resolve',q({ownerId:'other'}))).contactId);
 assert.notEqual(first.contactId,(await f.run('resolve',q({identity:{namespace:'telegram',externalId:'456'}}))).contactId);
});
test('exact replay returns receipt after newer profile, changed operation conflicts',async()=>{
 const f=fixture(),request=q(),first=await f.run('resolve',request);
 await f.run('resolve',q({observedAt:'2026-10-31T11:00:00.000001Z',profile:{name:'New'}}));
 assert.deepEqual(await f.run('resolve',request),first);
 await assert.rejects(f.run('resolve',{...request,profile:{name:'Changed'}}),{code:'REQUEST_ID_CONFLICT'});
 const {packetId,...observe}=request;await assert.rejects(f.run('profile.observe',observe),{code:'REQUEST_ID_CONFLICT'});
 assert.equal(first.historyEvents.length,1);assert.equal(first.historyEvents[0].data.name,undefined);
});
test('read and replay check current caller grants; observe does not create unknown account',async()=>{
 const f=fixture(),request=q();await f.run('resolve',request);f.callers.intake.sourceIds=[];
 await assert.rejects(f.run('resolve',request),{code:'FORBIDDEN'});
 const g=fixture(),{packetId,...observation}=q();await assert.rejects(g.run('profile.observe',observation),{code:'NOT_FOUND'});
});
test('confirming same value advances origin without another update fact',async()=>{
 const f=fixture();await f.run('resolve',q());const result=await f.run('resolve',q({observedAt:'2026-10-31T11:00:00.000001Z'}));assert.deepEqual(result.historyEvents,[]);
});
