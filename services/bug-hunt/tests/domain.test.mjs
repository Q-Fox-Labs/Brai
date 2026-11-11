// ABOUTME: Проверяет право разбора и отказ до вызова хранилища.
// ABOUTME: Ядро проверяется независимо от транспорта и PostgreSQL.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHandlers} from '../dist/domain.js';
const principal={ownerId:'owner',actorId:'fixture',source:'codex',reviewer:false};
test('обычный агент не вызывает review/status и операторский список',async()=>{
 let calls=0;const core=createHandlers({evidence:async()=>{},store:new Proxy({},{get:()=>async()=>{calls++;return {};}})});
 const review={request_id:'r',case_id:'00000000-0000-4000-8000-000000000001',expected_revision:1,review_state:'triaged',explanation:'Почему'};
 for(const [op,input,operator] of [['review',review,false],['status',{},false],['list',{},true]])await assert.rejects(core.invoke(op,principal,input,operator),e=>e.code==='FORBIDDEN');
 assert.equal(calls,0);
 await core.invoke('review',{...principal,source:'web',reviewer:true},review);
 assert.equal(calls,1);
});
