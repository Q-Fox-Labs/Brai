// ABOUTME: Проверяет длинное расследование через настоящий общий dispatcher и сохранённые effects.
// ABOUTME: Модель и хранилище заменены портами; лимиты времени, отмены и явной политики сохраняются.
import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {createVerificationEngine} from "../dist/verification-engine.js";
import {verificationPolicy} from "../dist/verification.js";
function fixture({toolCalls=null,allowed=true,remainingMs=60000,liveCancel=false}={}){
 const row={id:randomUUID(),installation_id:"synthetic",owner_id:"owner",stage:"investigate",executor:"codex_app_server",cancel_requested:false,deadline_at:new Date(Date.now()+remainingMs),policy:verificationPolicy({budgets:{toolCalls}}),snapshot:{cases:[]},model:{id:"gpt-6.1-sol",effort:"high"}};
 const ledger=new Map(),reads=[];let code=null,modelIntent=null,passes=0;const runnerCancels=[];
 const model={id:"model:investigator",kind:"model",step_key:"investigator",intent:{phase:"investigator"},checkpoint:{state:"running",native:{}}};ledger.set(model.id,model);
 if(liveCancel)ledger.set("runner:existing",{id:"runner:existing",kind:"runner",step_key:"existing",intent:{execution_id:randomUUID()},checkpoint:{state:"running"}});
 const store={
  guard:async(id,run)=>{row.cancel_requested=liveCancel&&passes++>0;return run(row);},allowed:async()=>allowed,cancelRequested:async()=>liveCancel,effects:async()=>[...ledger.values()],
  effect:async(r,kind,key,intent)=>{const id=kind+":"+key;if(!ledger.has(id))ledger.set(id,{id,kind,step_key:key,intent,checkpoint:{state:"not_sent"}});return ledger.get(id);},
  checkpoint:async(r,id,cp)=>{ledger.get(id).checkpoint=structuredClone(cp);},
  evidencePage:async()=>{reads.push(1);return {items:[],next_cursor:null};},
  set:async(r,state,next,stage)=>{code=next;if(stage)r.stage=stage;},terminal:async()=>false
 };
 const candidate={claim:"Synthetic missing evidence",expected:"Known requirement",facts:[],verdict:"insufficient_evidence",reproduction_outcome:"not_attempted",observed_failure:"unknown",requirement_id:null,source_id:null,runner_id:null,evidence_ids:[],missing:["No recipe"],limitations:["Synthetic"]};
 const engine=createVerificationEngine({store,sources:{},runner:{cancel:async(scope,id)=>{runnerCancels.push({scope,id});return {finished_at:new Date().toISOString()};}},recipes:[],activeOwner:async()=>true,executor:(r,dispatch)=>({
  startStep:async intent=>{modelIntent=intent;return {state:"completed",native:{},result:candidate,code:null,usage:null};},
  inspectStep:async()=>{
   if(liveCancel)return {state:"failed",native:{},result:null,code:"POLICY_REVOKED",usage:null};
   await assert.rejects(dispatch.call("malformed","evidence_read",{evidence_id:"missing",offset:0,limit:10}),e=>e.code==="INVALID_TOOL_ARGUMENT");
   for(const args of [{after_id:"missing"},{limit:0},{limit:21},{limit:1.5}])await assert.rejects(dispatch.call("bad-page","evidence_list",args),e=>e.code==="INVALID_TOOL_ARGUMENT");
   for(let n=0;n<400;n++)await dispatch.call("step-"+n,"evidence_list",{});
   // Exact replay of one tool must not rerun its read.
   await dispatch.call("step-0","evidence_list",{});
   return {state:"completed",native:{},result:candidate,code:null,usage:null};
  }
 })});
 return {engine,row,reads,ledger,runnerCancels,get code(){return code;},get modelIntent(){return modelIntent;}};
}
test("default shared dispatcher permits 400 reads and replays a completed tool without another read",async()=>{
 const f=fixture(),result=await f.engine.advance(f.row.id);
 assert.equal(result.code,"REVIEW_PENDING");assert.equal(f.reads.length,400);
 assert.equal([...f.ledger.values()].filter(e=>e.kind==="tool").length,400);
});
test("an explicitly configured historical tool quota remains effective",async()=>{
 const f=fixture({toolCalls:24}),result=await f.engine.advance(f.row.id);
 assert.equal(result.code,"TOOL_LIMIT");assert.equal(result.terminal,true);assert.equal(f.reads.length,24);
});
test("removing the step cap preserves deadline and owner-policy checks",async()=>{
 for(const [options,expected] of [[{remainingMs:-1000},"ATTEMPT_DEADLINE"],[{allowed:false},"POLICY_OR_OWNER_REVOKED"]]){
  const f=fixture(options);
  if(options.remainingMs)f.ledger.clear();
  const result=await f.engine.advance(f.row.id);assert.equal(result.code,expected);assert.equal(f.reads.length,0);
 }
});

test("fresh model intent inherits the remaining attempt deadline without a 90-second phase cap",async()=>{
 const f=fixture({remainingMs:900000});f.ledger.clear();
 const result=await f.engine.advance(f.row.id);
 assert.equal(result.code,"REVIEW_PENDING");
 assert.equal(f.modelIntent.deadline_at,f.row.deadline_at.toISOString());
});

test("live cancel seen by a quiet native turn still cancels its previously running runner",async()=>{
 const f=fixture({liveCancel:true}),runner=f.ledger.get("runner:existing");
 const first=await f.engine.advance(f.row.id);
 assert.equal(first.code,"CANCEL_REQUESTED");assert.equal(first.terminal,false);
 assert.equal(f.runnerCancels.length,0);assert.equal(f.ledger.get("model:investigator").checkpoint.state,"failed");
 const second=await f.engine.advance(f.row.id);
 assert.equal(second.code,"CANCELLED");assert.equal(second.terminal,true);
 assert.deepEqual(f.runnerCancels,[{scope:{installation_id:f.row.installation_id,owner_id:f.row.owner_id,investigation_id:f.row.id},id:runner.intent.execution_id}]);
});
