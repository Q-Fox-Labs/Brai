// ABOUTME: Проверяет закрытые v2 DTO, границы полномочий и безопасные ошибки.
// ABOUTME: Не использует БД, Auth, транспорт или реальные пользовательские данные.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {validateSystem,invokeSystem,systemFailure,SystemFault,systemOperations} from '../dist/system-contracts.js';
import {Fault} from '../dist/contracts.js';
const p={ownerId:'fixture',actorId:'codex:fixture',source:'codex',reviewer:false};
const fault=code=>e=>e.code===code;
test('closed v2 inputs reject scope injection, Unicode, excess fields and invalid limits',()=>{
 assert.equal(systemOperations.length,8);
 for(const value of [{query:'q',owner_id:'foreign'},{query:'q',filters:{unknown:'x'}},{query:'q',limit:51},{query:'\ud800'},{query:'\u0000'}])assert.throws(()=>validateSystem('search',value),fault('INVALID_ARGUMENT'));
 assert.throws(()=>validateSystem('search',{query:'x'.repeat(65536)}),fault('REQUEST_TOO_LARGE'));
 validateSystem('search',{query:'точный%_\\путь',filters:{error_code:'E_100'},limit:50});
 validateSystem('membership-update',{request_id:'a',case_ids:[randomUUID()],expected_revisions:[],explanation:'Объяснение'});
 assert.throws(()=>validateSystem('classification-override',{request_id:'a',case_id:randomUUID(),expected_revision:0,labels:{},explanation:'Объяснение'}),fault('INVALID_ARGUMENT'));
});
test('untrusted source cannot execute reviewer mutations and closed outputs are checked',async()=>{
 let calls=0;
 const store={membershipUpdate:async()=>{calls++;return{};},search:async()=>({secret:'never expose'})};
 await assert.rejects(invokeSystem(store,'membership-update',p,{request_id:'a',case_ids:[randomUUID()],expected_revisions:[],explanation:'Объяснение'}),fault('FORBIDDEN'));assert.equal(calls,0);
 await assert.rejects(invokeSystem(store,'search',p,{query:'q'}),fault('INTERNAL'));
 await assert.rejects(invokeSystem(store,'search',{...p,ownerId:''},{query:'q'}),fault('UNAUTHENTICATED'));
});
test('safe faults do not disclose implementation detail',()=>{
 assert.deepEqual(systemFailure(new SystemFault('CURSOR_STALE')),{code:'CURSOR_STALE',message:'CURSOR_STALE',outcome:'not_accepted',retryable:false});
 assert.equal(systemFailure(new Error('private SQL'),true).outcome,'unknown');
 assert.equal(systemFailure(new Fault('UNAUTHENTICATED')).code,'UNAUTHENTICATED');
});
