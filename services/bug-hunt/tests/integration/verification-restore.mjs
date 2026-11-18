// ABOUTME: Сверяет originals и v3 данные после настоящего pg_dump/pg_restore и повторяет квитанцию.
// ABOUTME: Работает только с изолированной synthetic source/restore; моделей и workflow не запускает.
import test from "node:test";
import {fixtureNetwork,fixtureDatabase} from "./fixture-network.mjs";
import assert from "node:assert/strict";
import {readPrivate} from "../../dist/config.js";
import {Pool} from "pg";
import {createVerificationStore,verificationHash as hash} from "../../dist/verification-store.js";
import {verificationPolicy} from "../../dist/verification.js";
assert.ok(process.env.BUG_HUNT_FLOW_DB_CONFIG,"BUG_HUNT_FLOW_DB_CONFIG is required");
assert.ok(process.env.BUG_HUNT_FLOW_RESTORED_CONFIG,"BUG_HUNT_FLOW_RESTORED_CONFIG is required");
const fixture=readPrivate(process.env.BUG_HUNT_FLOW_DB_CONFIG),restored=readPrivate(process.env.BUG_HUNT_FLOW_RESTORED_CONFIG);
const proof=fixtureNetwork();
const sourceURL=fixtureDatabase(fixture.ownerURL,'owner','brai_bug_hunt_test',proof);
const restoredURL=fixtureDatabase(restored.appURL,'app','brai_bug_hunt_restore_test',proof);
const v3Tables=["verification_run","verification_schedule","verification_investigation","verification_mutation","verification_effect","verification_evidence","verification_result","verification_review","verification_budget"];
const originalTables=["bug_case","report","review","mutation"];
test("v3 dump/restore preserves snapshots, effect intents, evidence, results, reviews and spent budget",async()=>{
 const source=new Pool({connectionString:sourceURL.href,max:1}),restored=new Pool({connectionString:restoredURL.href,max:2});
 try{
  for(const table of [...v3Tables,...originalTables]){const query="SELECT to_jsonb(t) AS value FROM "+table+" t ORDER BY to_jsonb(t)::text";const a=(await source.query(query)).rows,b=(await restored.query(query)).rows;if(v3Tables.includes(table)||table==="bug_case"||table==="report")assert.ok(a.length>0,table+" must contain real fixture data");assert.equal(hash(b),hash(a),table);}
  const client=await restored.connect();
  try{for(const table of ["verification_mutation","verification_result","verification_review","verification_evidence"]){
   await client.query("BEGIN");try{await assert.rejects(client.query("DELETE FROM "+table),e=>e.code==="42501");}finally{await client.query("ROLLBACK");}
  }}finally{client.release();}
  // AIDEV-NOTE: Replay допускает только flow seed и отдельный SQL-store seed с их исходными actor/scope.
  const row=(await restored.query("SELECT m.*,i.id AS investigation_id,i.snapshot FROM verification_mutation m JOIN verification_investigation i ON i.id=(m.result->'investigation_ids'->>0)::uuid AND i.installation_id=m.installation_id AND i.owner_id=m.owner_id WHERE m.operation='run-request' AND ((m.actor_id='fixture' AND m.installation_id LIKE 'flow-%') OR (m.actor_id='fixture:one' AND m.installation_id ~ '^v3-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')) AND jsonb_array_length(m.result->'investigation_ids')=1 AND i.snapshot->'group'='null'::jsonb ORDER BY i.registered_at DESC LIMIT 1")).rows[0];assert.ok(row);
  const input={request_id:row.request_id,target:{kind:"case",id:row.snapshot.cases[0].case_id}};assert.equal(hash(input),row.input_hash);
  const policy=verificationPolicy({externalAllowedOwners:[row.owner_id]}),store=createVerificationStore(restored,{installationId:row.installation_id,cursorKey:"synthetic-restored-verification-key-32bytes",policy:()=>policy,maxDatabaseBytes:1073741824});
  const before=hash((await restored.query("SELECT to_jsonb(e) AS value FROM verification_effect e ORDER BY id")).rows);
  const receipt=await store.request({ownerId:row.owner_id,actorId:row.actor_id,source:"codex",reviewer:false},input);assert.deepEqual(receipt,{...row.result,replayed:true});
  assert.equal(hash((await restored.query("SELECT to_jsonb(e) AS value FROM verification_effect e ORDER BY id")).rows),before,"replay cannot create or dispatch a new effect");
 }finally{await Promise.all([source.end(),restored.end()]);}
});
