// ABOUTME: Сверяет всю v3 БД после настоящего pg_dump/pg_restore и повторяет сохранённую квитанцию.
// ABOUTME: Работает только с loopback synthetic source/restore; моделей и workflow не запускает.
import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {Pool} from "pg";
import {createVerificationStore,verificationHash as hash} from "../../dist/verification-store.js";
import {verificationPolicy} from "../../dist/verification.js";
const fixture=JSON.parse(readFileSync(new URL("../../../../tmp/bug-hunt-test.json",import.meta.url),"utf8"));
const sourceURL=new URL(fixture.ownerURL),restoredURL=new URL(fixture.appURL);
assert.equal(sourceURL.hostname,"127.0.0.1");assert.equal(sourceURL.pathname,"/brai_bug_hunt_test");
assert.equal(restoredURL.hostname,"127.0.0.1");restoredURL.pathname="/brai_bug_hunt_restore_stage2";
const tables=["verification_run","verification_schedule","verification_investigation","verification_mutation","verification_effect","verification_evidence","verification_result","verification_review","verification_budget"];
test("v3 dump/restore preserves snapshots, effect intents, evidence, results, reviews and spent budget",async()=>{
 const source=new Pool({connectionString:sourceURL.href,max:1}),restored=new Pool({connectionString:restoredURL.href,max:2});
 try{
  for(const table of tables){const query="SELECT to_jsonb(t) AS value FROM "+table+" t ORDER BY to_jsonb(t)::text";const a=(await source.query(query)).rows,b=(await restored.query(query)).rows;assert.ok(a.length>0,table+" must contain real fixture data");assert.equal(hash(b),hash(a),table);}
  for(const table of ["verification_mutation","verification_result","verification_review","verification_evidence"])await assert.rejects(restored.query("DELETE FROM "+table),e=>e.code==="42501");
  const row=(await restored.query("SELECT m.*,i.id AS investigation_id,i.snapshot FROM verification_mutation m JOIN verification_investigation i ON i.id=(m.result->'investigation_ids'->>0)::uuid AND i.installation_id=m.installation_id AND i.owner_id=m.owner_id WHERE m.operation='run-request' AND m.installation_id LIKE 'flow-%' AND jsonb_array_length(m.result->'investigation_ids')=1 ORDER BY i.registered_at DESC LIMIT 1")).rows[0];assert.ok(row);
  const input={request_id:row.request_id,target:{kind:"case",id:row.snapshot.cases[0].case_id}};assert.equal(hash(input),row.input_hash);
  const policy=verificationPolicy({externalAllowedOwners:[row.owner_id]}),store=createVerificationStore(restored,{installationId:row.installation_id,cursorKey:"synthetic-restored-verification-key-32bytes",policy:()=>policy,maxDatabaseBytes:1073741824});
  const before=hash((await restored.query("SELECT to_jsonb(e) AS value FROM verification_effect e ORDER BY id")).rows);
  const receipt=await store.request({ownerId:row.owner_id,actorId:row.actor_id,source:"codex",reviewer:false},input);assert.deepEqual(receipt,{...row.result,replayed:true});
  assert.equal(hash((await restored.query("SELECT to_jsonb(e) AS value FROM verification_effect e ORDER BY id")).rows),before,"replay cannot create or dispatch a new effect");
 }finally{await Promise.all([source.end(),restored.end()]);}
});
