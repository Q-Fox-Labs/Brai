// ABOUTME: Проверяет узкую границу Контактов и прежние дефекты пустых полей/аудита.
// ABOUTME: Не создаёт runtime Контактов или внешние сервисы.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {contactInput,checkContact,contactError} from '../dist/contact-contract.js';
import {contactResult} from './contact-fixture.mjs';
import {createPorts} from '../dist/ports.js';
const packet=()=>({id:randomUUID(),ownerId:'owner',source:'telegram',receivedAt:'2026-10-31T00:00:00.000001Z',original:{type:'message.incoming',data:{author:{kind:'human',id:'123',name:'',username:null},text:'private',attachments:[]}}});
test('empty strings omitted, null kept and original unchanged across five profile cases',()=>{
 for(const input of [{},{name:'',username:''},{name:null,username:null},{name:' Alice ',username:'Alice'},{name:'',username:null}]){
  const p=packet();Object.assign(p.original.data,{author:{kind:'human',id:'123',...input}});const old=JSON.stringify(p.original),q=contactInput(p).request;
  assert.deepEqual(q.profile,Object.fromEntries(Object.entries(input).filter(([,v])=>v!=='')));assert.equal(JSON.stringify(p.original),old);assert.equal(q.text,undefined);
 }
});
test('full result rejects spoofed references, hostile JSON, snapshots and audit facts',()=>{
 const p=packet();p.contactRequest=contactInput(p).request;const correct=contactResult(p.contactRequest);checkContact(p,correct);
 for(const mutate of [v=>v.ownerId='other',v=>v.packetId=randomUUID(),v=>v.identity.externalId='999',v=>v.observedAt='2026-10-31T00:00:00.000002Z',v=>v.senderSnapshot.name='Current profile',v=>v.senderSnapshot.username='\u0000',v=>v.historyEvents=[{id:randomUUID(),type_id:103,occurred_at:p.receivedAt,scope_type:'user',scope_id:p.ownerId,data:{}}]]){const v=structuredClone(correct);mutate(v);assert.throws(()=>checkContact(p,v),{code:'INVALID_CONTACT_RESULT'});}
});
test('optional photo failure cannot block file preparation or become explicit null',async()=>{
 const p=packet();p.original.data.author.photoArtifactId=randomUUID();
 const ports=createPorts({async request(){throw Error('offline');}},null,{});
 const intent=await ports.prepareContact(p);assert.equal(Object.hasOwn(intent.request.profile,'photoArtifactId'),false);assert.equal(intent.diagnostics.at(-1).code,'PHOTO_UNAVAILABLE');assert.deepEqual(await ports.prepareFiles(p),[]);
});
test('known transient and permanent service errors preserve safe policy',()=>{
 assert.equal(contactError({code:'DATABASE_UNAVAILABLE',message:'safe',retryable:true},503).retryable,true);
 assert.equal(contactError({code:'FORBIDDEN',message:'safe',retryable:false},403).code,'FORBIDDEN');
 assert.equal(contactError({code:'INTERNAL',message:'safe',retryable:false},500).retryable,false);
 assert.equal(contactError({code:'INTERNAL',message:'safe',retryable:true},500).code,'INVALID_CONTACT_RESULT');
});

test('malformed Contact audit receipts never allow the Intake complete fact',async()=>{
 const p=packet();p.original.data.author.name='Alice';p.contactRequest=contactInput(p).request;p.contact=contactResult(p.contactRequest);p.completedAt=p.receivedAt;
 const fact={id:randomUUID(),type_id:101,occurred_at:p.receivedAt,actor_id:null,scope_type:'user',scope_id:p.ownerId,object_type:'contact',object_id:p.contact.contactId,data:{operationId:p.contactRequest.operationId,identityId:p.contact.identityId,changedFields:['name']}};
 p.contact.historyEvents=[fact];
 const valid={event:{...fact,source:'service_contacts',recorded_at:p.receivedAt}};
 for(const bad of [{event:{...fact,source:'service_contacts'}},{...valid,stored:false},{event:{...valid.event,recorded_at:'invalid'}},{event:{...valid.event,extra:true}},{event:{...valid.event,data:{...fact.data,invalid:'\u0000'}}},{event:{...valid.event,data:{large:'x'.repeat(524289)}}}]){
  const calls=[],nc={async request(subject){calls.push(subject);return {data:Buffer.from(JSON.stringify(subject.endsWith('service_contacts')?bad:{}))};}};
  const ports=createPorts(nc,null,{});
  await assert.rejects(ports.history(p,'complete'),{code:'INVALID_CONTACT_HISTORY_RESULT'});
  assert.deepEqual(calls,['brai.history.v1.append.service_contacts']);
 }
 const oversizedCalls=[],oversized={async request(subject){oversizedCalls.push(subject);return {data:Buffer.from(' '.repeat(524289)+JSON.stringify(valid))};}};
 await assert.rejects(createPorts(oversized,null,{}).history(p,'complete'),{code:'INVALID_CONTACT_HISTORY_RESULT'});assert.deepEqual(oversizedCalls,['brai.history.v1.append.service_contacts']);
 const calls=[],nc={async request(subject){calls.push(subject);return {data:Buffer.from(JSON.stringify(subject.endsWith('service_contacts')?valid:{}))};}};
 await createPorts(nc,null,{}).history(p,'complete');assert.deepEqual(calls,['brai.history.v1.append.service_contacts','brai.history.v1.append.service_intake']);
});
