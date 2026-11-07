// ABOUTME: Проверяет защиту lifecycle подтверждений и опубликованные DTO Auth.
// ABOUTME: Подменённая БД проверяет решения, реальные блокировки проверяются интеграционно.
import test from "node:test";
import assert from "node:assert/strict";
import { lifecycleWorker } from "../dist/lifecycle.js";
import { validate } from "../dist/schema.js";
import { v2 } from "../dist/v2.js";

function fixture(overrides={}) {
 const row={id:"op",user_id:"u",generation:2,lifecycle_generation:2,kind:"prepare",state:"running",status:"provisioning",lease_token:"secret",valid_lease:true,activate_on_success:true,...overrides};
 const writes=[];
 const client={async query(sql,values) {
  if(sql.startsWith("SELECT o.*"))return {rowCount:1,rows:[row]};
  if(sql.startsWith("SELECT id,request_id"))return {rowCount:1,rows:[{id:"op",requestId:"r",userId:"u",generation:2,kind:row.kind,state:row.state,errorCode:null}]};
  if(sql.startsWith("UPDATE"))writes.push({sql,values});
  return {rowCount:0,rows:[]};
 },release(){}};
 return {pool:{async connect(){return client;}},writes};
}
test("only latest live provisioning prepare can activate",async()=>{
 const f=fixture();
 const response=await lifecycleWorker(f.pool,"complete",{operationId:"op",leaseToken:"secret",success:true});
 assert.equal(response.accepted,true);
 assert.ok(f.writes.some(w=>w.sql.includes("status='active'")));
 assert.equal(JSON.stringify(response).includes("secret"),false);
 for(const overrides of [{generation:1},{valid_lease:false},{status:"blocked"},{state:"failed"}]) {
  const stale=fixture(overrides);
  assert.equal((await lifecycleWorker(stale.pool,"complete",{operationId:"op",leaseToken:"secret",success:true})).accepted,false);
  assert.equal(stale.writes.length,0);
 }
 const forged=fixture();
 assert.equal((await lifecycleWorker(forged.pool,"renew",{operationId:"op",leaseToken:"forged"})).accepted,false);
 assert.equal(forged.writes.length,0);
});
test("cancelled completion releases own lease without activation; failures remain terminal",async()=>{
 const cancelled=fixture({state:"cancelled",lifecycle_generation:3});
 assert.equal((await lifecycleWorker(cancelled.pool,"complete",{operationId:"op",leaseToken:"secret",success:false})).accepted,false);
 assert.equal(cancelled.writes.length,1);
 assert.match(cancelled.writes[0].sql,/lease_token=NULL/);
 assert.equal(cancelled.writes.some(w=>w.sql.includes("status='active'")),false);
 const failed=fixture();
 assert.equal((await lifecycleWorker(failed.pool,"complete",{operationId:"op",leaseToken:"secret",success:false,errorCode:"PROFILE_FAILED"})).accepted,true);
 assert.deepEqual(failed.writes[0].values,["op","failed","PROFILE_FAILED"]);
});
test("trusted lifecycle and web admin DTOs enforce exact boundaries",async()=>{
 const cfg={identityMode:"telegram"};
 for(const telegramId of ["0","001"]){
  const input={headers:{origin:"https://fixture.example"},body:{requestId:"r",telegramId}};
  assert.throws(()=>validate("AdminAddRequest",input));
  await assert.rejects(()=>v2("users-add",input,cfg,{},()=>{}),/Invalid/);
 }
 validate("AdminAddRequest",{headers:{origin:"https://fixture.example"},body:{requestId:"r",telegramId:"123"}});
 validate("LifecycleCompleteRequest",{operationId:"o",leaseToken:"t",success:false,errorCode:"PROFILE_FAILED"});
 assert.throws(()=>validate("AdminAddRequest",{headers:{},body:{requestId:"r",telegramId:"123",role:"admin"}}));
 assert.throws(()=>validate("LifecycleCompleteRequest",{operationId:"o",leaseToken:"t",success:false,errorCode:"secret data"}));
 await assert.rejects(()=>v2("lifecycle-claim",{workerId:"w",headers:{}},cfg,{},()=>{}),/Invalid/);
 await assert.rejects(()=>v2("users-revoke",{headers:{},body:{userId:"u"}},cfg,{},()=>{}),/Invalid/);
});
