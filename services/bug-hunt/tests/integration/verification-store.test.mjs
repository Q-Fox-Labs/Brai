// ABOUTME: Проверяет v3 на собственной настоящей PostgreSQL БД с конкуренцией и восстановлением.
// ABOUTME: Loopback fixture и новый installation ID исключают рабочие обращения и чужие задания.
import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {randomUUID} from "node:crypto";
import {Pool} from "pg";
import {migrate} from "../../dist/migrate.js";
import {createStore} from "../../dist/storage.js";
import {createVerificationStore,verificationHash as hash} from "../../dist/verification-store.js";
import {verificationPolicy,validateResult,VerificationFault as VF} from "../../dist/verification.js";
import {createVerificationEngine} from "../../dist/verification-engine.js";
import {verificationProcess} from "../../dist/verification-process.js";
const fixture=JSON.parse(readFileSync(new URL("../../../../tmp/bug-hunt-test.json",import.meta.url),"utf8"));
for(const k of ["ownerURL","appURL"]){const u=new URL(fixture[k]);assert.equal(u.hostname,"127.0.0.1");assert.equal(u.pathname,"/brai_bug_hunt_test");}
test("v3 admission, timer, immutable data, fencing, ACL and replay use one scoped ledger",async t=>{
 const owner=new Pool({connectionString:fixture.ownerURL,max:1}),app=new Pool({connectionString:fixture.appURL,max:6});
 const installationId="v3-"+randomUUID(),p={ownerId:randomUUID(),actorId:"fixture:one",source:"codex",reviewer:false},foreign={...p,ownerId:randomUUID(),actorId:"fixture:foreign"};
 let policy=verificationPolicy({enabled:true,revision:"fixture-one",externalAllowedOwners:[p.ownerId],schedule:{maxInvestigationsPerRun:2}});
 try{
  await migrate(owner,"bug_hunt_owner","bug_hunt_app");await migrate(owner,"bug_hunt_owner","bug_hunt_app");
  const originals=createStore(app,{installationId,cursorKey:"fixture-cursor-key-at-least-32-bytes",maxReports:1000,reportsPerMinute:1000,maxDatabaseBytes:1073741824});
  let store=createVerificationStore(app,{installationId,cursorKey:"fixture-verification-cursor-key-32-bytes",policy:()=>policy,maxDatabaseBytes:1073741824});
  const report=(principal,input)=>originals.report(principal,input,async()=>{});
  const receipts=[];for(let i=0;i<8;i++)receipts.push(await report(p,{request_id:randomUUID(),observation:{title:"Synthetic "+i,operation:"accept zero",expected:"accepted",observed:"rejected",component_id:"fixture",commit_sha:"a".repeat(40)}}));
  const digest=async()=>hash((await owner.query("SELECT id,observation FROM report WHERE installation_id=$1 AND id=ANY($2::uuid[]) ORDER BY id",[installationId,receipts.map(r=>r.report_id)])).rows);
  const before=await digest();
  await t.test("first enable waits six hours, empty/limited ticks never call a model",async()=>{
   const now=new Date();assert.equal((await store.tick(now)).outcome,"not_due");
   assert.equal((await store.tick(new Date(+now+5*3600000))).selected,0);
   const due=await store.tick(new Date(+now+6*3600000+100));assert.equal(due.selected,2);
   assert.equal((await store.tick(new Date(+now+6*3600000+200))).outcome,"not_due");
   assert.equal((await store.pending()).length,2);
  });
  await t.test("owner without purpose permission cannot poison schedule admission",async()=>{const before=(await owner.query("SELECT count(*)::int AS n FROM verification_investigation WHERE installation_id=$1",[installationId])).rows[0];await assert.rejects(store.request(foreign,{request_id:randomUUID(),target:{kind:"pending"}}),e=>e.code==="POLICY_FORBIDDEN");assert.deepEqual((await owner.query("SELECT count(*)::int AS n FROM verification_investigation WHERE installation_id=$1",[installationId])).rows[0],before);});
  await t.test("nonterminal earlier cases do not block a later six-hour batch",async()=>{const schedule=(await store.status()).schedule;const due=new Date(new Date(schedule.next_due_at).getTime()+1);assert.equal((await store.tick(due)).selected,2);});
  let investigation;
  await t.test("concurrent manual requests share one snapshot and accepted receipt survives restart",async()=>{
   const input={request_id:randomUUID(),target:{kind:"case",id:receipts[4].case_id}};
   const parallel=await Promise.all(Array.from({length:8},()=>store.request(p,input)));
   assert.ok(parallel.every(x=>x.run_id===parallel[0].run_id));assert.equal(parallel[0].investigation_ids.length,1);
   investigation=parallel[0].investigation_ids[0];
   assert.equal((await store.request(p,{...input,request_id:randomUUID()})).investigation_ids[0],investigation);
   await assert.rejects(store.request(p,{...input,target:{kind:"case",id:receipts[5].case_id}}),e=>e.code==="IDEMPOTENCY_CONFLICT");
   store=createVerificationStore(app,{installationId,cursorKey:"fixture-verification-cursor-key-32-bytes",policy:()=>policy,maxDatabaseBytes:1073741824});
   assert.equal((await store.request(p,input)).run_id,parallel[0].run_id);
  });
  await t.test("owner and config pin survive one-key executor reload",async()=>{
   await assert.rejects(store.get(foreign,investigation),e=>e.code==="NOT_FOUND");
   policy={...policy,executor:"providers",revision:"fixture-two"};
   const old=await store.get(p,investigation);assert.equal(old.executor,"codex_app_server");assert.equal(old.config_revision,"fixture-one");
   const fresh=await store.request(p,{request_id:randomUUID(),target:{kind:"case",id:receipts[6].case_id}});
   assert.equal((await store.get(p,fresh.investigation_ids[0])).executor,"providers");
  });
  await t.test("unlimited guard remains null after four active hours and explicit finite policies retain their deadline",async()=>{
   await owner.query("UPDATE verification_investigation SET active_ms=$2 WHERE id=$1",[investigation,4*60*60*1000]);
   await store.guard(investigation,async r=>{assert.equal(r.policy.budgets.attemptMs,null);assert.equal(r.deadline_at,null);});
   const finite=await store.request(p,{request_id:randomUUID(),target:{kind:"case",id:receipts[7].case_id}});
   const finiteId=finite.investigation_ids[0];
   await owner.query("UPDATE verification_investigation SET policy=jsonb_set(policy,'{budgets,attemptMs}','3600000'::jsonb),active_ms=0 WHERE id=$1",[finiteId]);
   await store.guard(finiteId,async r=>{assert.ok(r.deadline_at.getTime()>Date.now()+3500000);});
  });
  await t.test("session guard fences stale writes and unknown intents are not replaced",async()=>{
   let stale;
   await store.guard(investigation,async r=>{stale=r;const intent={id:randomUUID(),value:"intent"};const a=await store.effect(r,"model","investigator",intent);await store.checkpoint(r,a.id,{state:"unknown",native:{operationId:randomUUID()},result:null,code:"ACK_LOST",usage:null});const replay=await store.effect(r,"model","investigator",intent);assert.equal(replay.id,a.id);assert.equal(replay.checkpoint.state,"unknown");await assert.rejects(store.effect(r,"model","investigator",{...intent,value:"other"}),e=>e.code==="IDEMPOTENCY_CONFLICT");});
   await store.guard(investigation,async()=>{});
   await assert.rejects(store.set(stale,"completed"),e=>e.code==="STALE_FENCE");
  });
  await t.test("native actual usage is monotonic, transactional and idempotent across replay",async()=>{
   await store.guard(investigation,async r=>{
    const day=await store.reserve(r,0),effect=await store.effect(r,"model","usage-fixture",{id:randomUUID(),fixture:"usage"});
    const before=Number((await owner.query("SELECT tokens FROM verification_budget WHERE installation_id=$1 AND owner_id=$2 AND day=$3",[installationId,p.ownerId,day])).rows[0].tokens);
    const checkpoint={state:"running",native:{budget_day:day},result:null,code:null,usage:{totalTokens:100}};
    await store.checkpoint(r,effect.id,checkpoint);await store.checkpoint(r,effect.id,checkpoint);
    await store.checkpoint(r,effect.id,{...checkpoint,usage:{totalTokens:80}});
    await store.checkpoint(r,effect.id,{...checkpoint,usage:{totalTokens:130}});
    assert.equal(Number((await owner.query("SELECT tokens FROM verification_budget WHERE installation_id=$1 AND owner_id=$2 AND day=$3",[installationId,p.ownerId,day])).rows[0].tokens),before+130);
   });
  });
  await t.test("evidence after the first fifty remains readable, paged and usable as positive proof",async()=>{
   await store.guard(investigation,async r=>{
    const scope={installation_id:installationId,owner_id:p.ownerId,investigation_id:r.id};
    const evidence=(kind,text,provenance={},late=false)=>({id:(late?"ffffffff-ffff-4fff-8fff-":"00000000-0000-4000-8000-")+randomUUID().slice(-12),scope,kind,text,sha256:hash(text),provenance,availability:"available",external_allowed:true});
    for(let n=0;n<60;n++)await store.putEvidence(r,evidence("diagnostic","Synthetic prior evidence "+n));
    const provenance={source_id:r.snapshot.source.id,commit:r.snapshot.source.commit,blob_sha256:hash("blob")};
    const requirement=evidence("requirement","Accept zero",{...provenance,path:"CONTRACT.md"},true),source=evidence("source","Rejects zero",{...provenance,path:"src/fixture.ts"},true);
    await store.putEvidence(r,requirement);await store.putEvidence(r,source);
    const oracle={requirement_id:requirement.id,requirement_sha256:requirement.sha256,expected:"accepted",version:"fixture",confirms_claim:"Valid zero rejected"};
    const receipt={execution_id:randomUUID(),scope,recipe_id:"fixture",recipe_version:"1",source_commit:r.snapshot.source.commit,source_sha256:source.provenance.blob_sha256,source_tree_sha256:hash("tree"),node_sha256:hash("node"),dependencies_sha256:hash("deps"),spec_sha256:hash("spec"),oracle_sha256:hash(oracle),started_at:"2026-11-11T00:00:00Z",finished_at:"2026-11-11T00:00:01Z",exit_code:0,outcome:"reproduced",assertions:[{name:"zero",expected:"accepted",actual:"rejected",passed:false}],log_sha256:hash("log"),fidelity:"synthetic",substituted_boundaries:["network"],cleanup:"done",state:"completed"};
    const runner=evidence("runner",JSON.stringify(receipt),{execution_id:receipt.execution_id},true);await store.putEvidence(r,runner);
    const all=await store.evidenceAll(r),refs=[requirement.id,source.id,runner.id];
    for(const id of refs)assert.ok(all.findIndex(e=>e.id===id)>=50);
    const seen=[];let cursor=null;
    do{const page=await store.evidencePage(r,cursor,20);assert.ok(page.items.length<=20);assert.ok(page.items.every(item=>!Object.hasOwn(item,"text")));seen.push(...page.items.map(e=>e.id));cursor=page.next_cursor;}while(cursor);
    assert.deepEqual(seen,all.map(e=>e.id));assert.equal(new Set(seen).size,seen.length);
    assert.equal((await store.evidenceByIds(r,[runner.id]))[0].text,runner.text);
    assert.deepEqual(await store.evidenceByIds({...r,owner_id:foreign.ownerId},refs),[]);
    assert.equal((await store.evidenceSource(r,"requirement",r.snapshot.source.id,"CONTRACT.md",provenance.blob_sha256)).id,requirement.id);
    assert.equal(await store.evidenceSource(r,"requirement","foreign","CONTRACT.md",provenance.blob_sha256),null);
    const candidate={claim:oracle.confirms_claim,expected:oracle.expected,facts:["Synthetic receipt rejects zero"],verdict:"confirmed",reproduction_outcome:"reproduced",observed_failure:"verified",requirement_id:requirement.id,source_id:source.id,runner_id:runner.id,evidence_ids:refs,missing:[],limitations:["Synthetic"]};
    const candidateHash=hash(candidate),review={accepted:true,candidate_sha256:candidateHash,evidence_ids:refs,limitations:[]};
    assert.equal(validateResult({scope,snapshot:r.snapshot,candidate,candidateHash,review,evidence:await store.evidenceByIds(r,refs),receipt,oracle,hash}).verdict,"confirmed");
   });
  });
  await t.test("manual review history remains readable with full Unicode explanations",async()=>{
   for(let revision=0;revision<13;revision++)await store.review({...p,reviewer:true},{request_id:randomUUID(),investigation_id:investigation,expected_revision:revision,verdict:"insufficient_evidence",explanation:"😀".repeat(4000)});
   const first=await store.get(p,investigation);assert.equal(first.reviews.length,10);assert.equal(first.next_review_revision,4);assert.ok(Buffer.byteLength(JSON.stringify(first))<258048);
   const second=await store.get(p,investigation,first.next_review_revision);assert.equal(second.reviews.length,3);assert.equal(second.next_review_revision,null);
   assert.equal(first.snapshot.cases[0].observation,undefined);
  });
  await t.test("append-only originals, receipts and results are protected by runtime grants",async()=>{
   for(const table of ["verification_mutation","verification_evidence","verification_result","verification_review"]){
    await assert.rejects(app.query("DELETE FROM "+table),e=>e.code==="42501");
   }
   await assert.rejects(app.query("UPDATE verification_investigation SET snapshot=snapshot"),e=>e.code==="42501");
   assert.equal(await digest(),before);
  });
  await t.test("cancellation with no external effect finishes without choosing another executor",async()=>{
   const fresh=await store.request(p,{request_id:randomUUID(),target:{kind:"case",id:receipts[7].case_id}});
   const id=fresh.investigation_ids[0];await store.cancel(p,{request_id:randomUUID(),investigation_id:id,reason:"Synthetic cancellation"});
   let models=0;
   const engine=createVerificationEngine({store,sources:{read:async()=>{throw Error();}},runner:{get:async()=>null,cancel:async()=>{throw Error();},start:async()=>{throw Error();}},recipes:[],activeOwner:async()=>true,executor:()=>{models++;throw Error("must not create executor");}});
   assert.equal((await engine.advance(id)).terminal,true);assert.equal((await store.get(p,id)).state,"cancelled");assert.equal(models,0);
  });
  await t.test("cancellation closes each executor and never confirms unknown external stop",async()=>{
   for(const outcome of ["throw","completed"]){
    const receipt=await report(p,{request_id:randomUUID(),observation:{title:"Cancel transport "+outcome,operation:"cancel",expected:"stopped",observed:"pending"}});
    const admitted=await store.request(p,{request_id:randomUUID(),target:{kind:"case",id:receipt.case_id}}),id=admitted.investigation_ids[0];
    await store.guard(id,async r=>{const effect=await store.effect(r,"model","investigator",{id:randomUUID()});await store.checkpoint(r,effect.id,{state:"blocked",native:{threadId:"synthetic-own",turnId:"synthetic-turn"},result:null,code:"NATIVE_UNEXPECTED_REQUEST",usage:null});});
    await store.cancel(p,{request_id:randomUUID(),investigation_id:id,reason:"synthetic stop"});
    let closes=0,cancels=0;const engine=createVerificationEngine({store,sources:{},runner:{},recipes:[],activeOwner:async()=>true,executor:()=>({cancelStep:async(i,c)=>{cancels++;if(outcome==="throw")throw Error("ACK lost");return {...c,state:"completed"};},close:()=>closes++})});
    const step=await engine.advance(id);assert.equal(cancels,1);assert.equal(closes,1);assert.equal(step.terminal,outcome==="completed");assert.equal((await store.get(p,id)).state,outcome==="completed"?"cancelled":"outcome_unknown");
   }
  });
  await t.test("runner recovery preserves never-sent initial start and forbids a second unknown execution",async()=>{
   for(const crash of ["before_dispatch","lost_ack"]){
   const receipt=await report(p,{request_id:randomUUID(),observation:{title:"Unknown runner receipt "+crash,operation:"evaluate zero",expected:"accepted",observed:"rejected",component_id:"fixture",commit_sha:"c".repeat(40)}});
   const admitted=await store.request(p,{request_id:randomUUID(),target:{kind:"case",id:receipt.case_id}}),id=admitted.investigation_ids[0],sourceText="source",requirementText="requirement";
   await store.guard(id,async r=>{
    await store.set(r,"running",null,r.stage,{id:"synthetic-model",effort:null,catalog_revision:"fixture",resolver_version:"fixture"});
    for(const [kind,path,text]of [["source","index.mjs",sourceText],["requirement","CONTRACT.md",requirementText]])await store.putEvidence(r,{id:randomUUID(),scope:{installation_id:installationId,owner_id:p.ownerId,investigation_id:id},kind,text,sha256:hash(text),provenance:{source_id:"fixture",commit:"c".repeat(40),path,blob_sha256:hash(text)},availability:"available",external_allowed:true});
   });
   let starts=0,first,second,block=crash==="before_dispatch";
   const guarded={...store,checkpoint:async(r,id,cp)=>{if(block&&cp.state==="dispatching"&&(await store.effects(r)).some(e=>e.id===id&&e.kind==="runner")){block=false;throw new VF("SYNTHETIC_CRASH","unknown");}return store.checkpoint(r,id,cp);}};
   const engine=createVerificationEngine({store:guarded,sources:{},runner:{start:async()=>{starts++;throw new VF("RUNNER_TIMEOUT","unknown");},get:async()=>null},activeOwner:async()=>true,recipes:[{ref:"fixture",recipe_id:"regression",recipe_version:"1",source_id:"fixture",source_commit:"c".repeat(40),source_path:"index.mjs",source_sha256:hash(sourceText),source_tree_sha256:"d".repeat(64),requirement_path:"CONTRACT.md",requirement_sha256:hash(requirementText),expected:"accepted",fixture_ref:"zero"}],executor:(r,d)=>({startStep:async()=>{
    first=await d.call("first","reproduction_run",{spec_ref:"fixture"});
    second=await d.call("second","reproduction_run",{spec_ref:"fixture"});
    return {state:"unknown",native:{},result:null,code:"SYNTHETIC_STOP",usage:null};
   }})});
   if(crash==="before_dispatch"){await engine.advance(id);assert.equal(starts,0);}
   await engine.advance(id);assert.equal(starts,1);assert.equal(first.state,"outcome_unknown");assert.equal(second.execution_id,first.execution_id);assert.equal(second.code,"RUNNER_RECOVERY_REQUIRED");
   assert.equal(Number((await owner.query("SELECT count(*) FROM verification_effect WHERE investigation_id=$1 AND kind='runner'",[id])).rows[0].count),1);
   }
  });
  await t.test("accepted cancellation wins publication under the same parent row lock",async()=>{
   const receipt=await report(p,{request_id:randomUUID(),observation:{title:"Cancel before publish",operation:"cancel",expected:"cancelled",observed:"review in flight"}});
   const admitted=await store.request(p,{request_id:randomUUID(),target:{kind:"case",id:receipt.case_id}}),id=admitted.investigation_ids[0];
   await store.guard(id,async r=>{const cancelled=await store.cancel(p,{request_id:randomUUID(),investigation_id:id,reason:"cancel before model review returns"});assert.equal(cancelled.cancel_requested,true);await assert.rejects(store.publish(r,{verdict:"insufficient_evidence"},{}),e=>e.code==="CANCEL_REQUESTED");});
   assert.equal(Number((await owner.query("SELECT count(*) FROM verification_result WHERE investigation_id=$1",[id])).rows[0].count),0);
  });
  await t.test("lost publication ACK never reopens terminal state or duplicates results after manual review",async()=>{
   for(const manual of [false,true]){
    const receipt=await report(p,{request_id:randomUUID(),observation:{title:"Publication ACK "+manual,operation:"publish",expected:"one result",observed:"ACK lost"}});
    const admitted=await store.request(p,{request_id:randomUUID(),target:{kind:"case",id:receipt.case_id}}),id=admitted.investigation_ids[0];
    await store.guard(id,async r=>{
     if(manual)await store.review({...p,reviewer:true},{request_id:randomUUID(),investigation_id:id,expected_revision:0,verdict:"insufficient_evidence",explanation:"Synthetic prior manual authority"});
     const result=await store.publish(r,{verdict:"insufficient_evidence"},{fixture:true});
     await store.set(r,"outcome_unknown","DATABASE_COMMIT_ACK_LOST");
     assert.equal((await store.get(p,id)).state,"completed");
     assert.equal(await store.publish(r,{verdict:"insufficient_evidence"},{fixture:true}),result);
     assert.equal((await store.get(p,id)).manual_revision,manual?1:0);
    });
    assert.equal(Number((await owner.query("SELECT count(*) FROM verification_result WHERE investigation_id=$1",[id])).rows[0].count),1);
   }
  });
  await t.test("fresh workflow intent is delivered ahead of old blocked workflows",async()=>{const ids=(await owner.query("SELECT id FROM verification_investigation WHERE installation_id=$1 ORDER BY registered_at",[installationId])).rows.map(r=>r.id);for(const id of ids)await store.workflow(id,"active");await store.workflow(investigation,"pending");assert.equal((await store.pending())[0].id,investigation);});
  await t.test("process status replies retain the actual PG session guard until owned execution settles",async()=>{
   const receipt=await report(p,{request_id:randomUUID(),observation:{title:"Owned guard",operation:"wait",expected:"same owner",observed:"status returned"}});
   const id=(await store.request(p,{request_id:randomUUID(),target:{kind:"case",id:receipt.case_id}})).investigation_ids[0];
   let enter,finish,task,calls=0;const entered=new Promise(r=>enter=r),held=new Promise(r=>finish=r);
   const process=verificationProcess({advance:async id=>{calls++;task=store.guard(id,async r=>{assert.equal(r.deadline_at,null);enter();return held;});return task;},requestStopOwned:async()=>({ids:[],unknown:false})});
   await process.advance(id);await entered;
   assert.equal(await store.guard(id,async()=>{throw Error("guard must remain owned");}),null);
   for(let n=0;n<400;n++)assert.equal((await process.advance(id)).code,"ENGINE_PENDING");
   assert.equal(calls,1);finish({terminal:false,wait_ms:1,code:"REVIEW_PENDING"});await task;await new Promise(r=>setImmediate(r));
   assert.equal((await process.advance(id)).code,"REVIEW_PENDING");assert.equal(calls,1);
  });
  await t.test("fenced cleanup registry retains runners from multiple completed engine passes",async()=>{
   const ids=[],executions=[],cancelled=[];
   const narrowPool=new Pool({connectionString:fixture.appURL,max:3,connectionTimeoutMillis:2000});
   const limited=createVerificationStore(narrowPool,{installationId,cursorKey:"fixture-verification-cursor-key-32-bytes",policy:()=>policy,maxDatabaseBytes:1073741824});
   try{
   const candidate={claim:"Synthetic missing evidence",expected:"Known requirement",facts:[],verdict:"insufficient_evidence",reproduction_outcome:"not_attempted",observed_failure:"unknown",requirement_id:null,source_id:null,runner_id:null,evidence_ids:[],missing:["No proof"],limitations:["Synthetic"]};
   const engine=createVerificationEngine({store:limited,sources:{},recipes:[],activeOwner:async()=>true,runner:{cancel:async(scope,id)=>{cancelled.push({scope,id});return {finished_at:new Date().toISOString()};}},executor:()=>({preflight:async()=>({ready:true,models:[{id:"gpt-6.1-sol",supportedReasoningEfforts:[{reasoningEffort:"high"}]}],catalog_revision:"fixture"}),startStep:async()=>({state:"completed",native:{},result:candidate,usage:null,code:null})})});
   const execution=verificationProcess(engine);
   for(let n=0;n<3;n++){
    const receipt=await report(p,{request_id:randomUUID(),observation:{title:"Unsettled runner "+n,operation:"stop",expected:"owned cleanup",observed:"model phase completed"}});
    const id=(await store.request(p,{request_id:randomUUID(),target:{kind:"case",id:receipt.case_id}})).investigation_ids[0],executionId=randomUUID();ids.push(id);executions.push(executionId);
    await store.guard(id,async r=>{const effect=await store.effect(r,"runner",executionId,{id:randomUUID(),execution_id:executionId});await store.checkpoint(r,effect.id,{state:"running",native:{},result:null,usage:null,code:null});});
    let status;do{status=await execution.advance(id);if(status.code==="ENGINE_PENDING")await new Promise(r=>setImmediate(r));}while(status.code==="ENGINE_PENDING");
    assert.equal(status.code,"REVIEW_PENDING");
   }
   await execution.stop();
   for(const id of ids){const detail=await limited.get(p,id);assert.equal(detail.code,"WORKER_STOPPED");assert.equal(detail.cancel_requested,false);}
   assert.deepEqual(cancelled.map(r=>r.id).sort(),executions.sort());assert.ok(cancelled.every(r=>r.scope.owner_id===p.ownerId&&ids.includes(r.scope.investigation_id)));
   assert.deepEqual(await engine.requestStopOwned(),{ids:[],unknown:false});
   }finally{await narrowPool.end();}
  });
  await t.test("a BUSY loser and a stale scoped fence cannot stop another live investigation",async()=>{
   const receipt=await report(p,{request_id:randomUUID(),observation:{title:"Fence stop",operation:"stop",expected:"owner only",observed:"another worker owns guard"}});
   const id=(await store.request(p,{request_id:randomUUID(),target:{kind:"case",id:receipt.case_id}})).investigation_ids[0];
   const engine=createVerificationEngine({store,sources:{},runner:{},recipes:[],activeOwner:async()=>true,executor:()=>{throw Error("must not dispatch");}});
   let stale;
   await store.guard(id,async r=>{stale=r;assert.equal((await engine.advance(id)).code,"BUSY");assert.deepEqual(await engine.requestStopOwned(),{ids:[],unknown:false});assert.equal((await store.get(p,id)).code,null);});
   await store.guard(id,async r=>{assert.equal(await store.requestStop(stale),false);assert.equal(await store.requestStop({...r,owner_id:foreign.ownerId}),false);assert.equal((await store.get(p,id)).code,null);});
  });
  assert.equal(await digest(),before);
 }finally{await Promise.all([app.end(),owner.end()]);}
});
