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
