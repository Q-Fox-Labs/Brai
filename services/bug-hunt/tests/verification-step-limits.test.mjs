// ABOUTME: Проверяет длинное расследование через настоящий общий dispatcher и сохранённые effects.
// ABOUTME: Модель и хранилище заменены портами; лимиты времени, отмены и явной политики сохраняются.
import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {createVerificationEngine} from "../dist/verification-engine.js";
import {verificationPolicy} from "../dist/verification.js";
function fixture({toolCalls=null,allowed=true,remainingMs=60000}={}){
 const row={id:randomUUID(),installation_id:"synthetic",owner_id:"owner",stage:"investigate",executor:"codex_app_server",cancel_requested:false,deadline_at:new Date(Date.now()+remainingMs),policy:verificationPolicy({budgets:{toolCalls}}),snapshot:{cases:[]},model:{id:"gpt-6.1-sol",effort:"high"}};
 const ledger=new Map(),reads=[];let code=null;
 const model={id:"model:investigator",kind:"model",step_key:"investigator",intent:{phase:"investigator"},checkpoint:{state:"running",native:{}}};ledger.set(model.id,model);
 const store={
  guard:async(id,run)=>run(row),allowed:async()=>allowed,effects:async()=>[...ledger.values()],
  effect:async(r,kind,key,intent)=>{const id=kind+":"+key;if(!ledger.has(id))ledger.set(id,{id,kind,step_key:key,intent,checkpoint:{state:"not_sent"}});return ledger.get(id);},
  checkpoint:async(r,id,cp)=>{ledger.get(id).checkpoint=structuredClone(cp);},
  evidencePage:async()=>{reads.push(1);return {items:[],next_cursor:null};},
  set:async(r,state,next,stage)=>{code=next;if(stage)r.stage=stage;},terminal:async()=>false
 };
 const candidate={claim:"Synthetic missing evidence",expected:"Known requirement",facts:[],verdict:"insufficient_evidence",reproduction_outcome:"not_attempted",observed_failure:"unknown",requirement_id:null,source_id:null,runner_id:null,evidence_ids:[],missing:["No recipe"],limitations:["Synthetic"]};
 const engine=createVerificationEngine({store,sources:{},runner:{},recipes:[],activeOwner:async()=>true,executor:(r,dispatch)=>({
  inspectStep:async()=>{
   await assert.rejects(dispatch.call("malformed","evidence_read",{evidence_id:"missing",offset:0,limit:10}),e=>e.code==="INVALID_TOOL_ARGUMENT");
   for(const args of [{after_id:"missing"},{limit:0},{limit:21},{limit:1.5}])await assert.rejects(dispatch.call("bad-page","evidence_list",args),e=>e.code==="INVALID_TOOL_ARGUMENT");
   for(let n=0;n<400;n++)await dispatch.call("step-"+n,"evidence_list",{});
   // Exact replay of one tool must not rerun its read.
   await dispatch.call("step-0","evidence_list",{});
   return {state:"completed",native:{},result:candidate,code:null,usage:null};
  }
 })});
 return {engine,row,reads,ledger,get code(){return code;}};
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
