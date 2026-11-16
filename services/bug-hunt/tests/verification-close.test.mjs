// ABOUTME: Проверяет, что engine удерживает ownership до подтверждённого выхода собственного native child.
// ABOUTME: Fake exit разрешается явно; тест не ждёт remote turn, не использует серверы или таймеры.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createVerificationEngine} from '../dist/verification-engine.js';
import {verificationProcess,shutdownVerification} from '../dist/verification-process.js';
import {verificationPolicy} from '../dist/verification.js';
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function fixture({cancel=false,infrastructure=false}={}){
 let exit,closing,guardHeld=false,executors=0,modelStarts=0,owner;
 const exited=new Promise(resolve=>exit=resolve),closeEntered=new Promise(resolve=>closing=resolve),events=[];
 const candidate={claim:'Synthetic unavailable proof',expected:'Known requirement',facts:[],verdict:'insufficient_evidence',reproduction_outcome:'not_attempted',observed_failure:'unknown',requirement_id:null,source_id:null,runner_id:null,evidence_ids:[],missing:['No recipe'],limitations:['Synthetic']};
 const row={id:'own',installation_id:'synthetic',owner_id:'owner',stage:'investigate',executor:'codex_app_server',cancel_requested:cancel,code:infrastructure?'WORKER_STOPPING':null,deadline_at:null,policy:verificationPolicy({}),snapshot:{cases:[],source:null,group:null},model:{id:'gpt-6.1-sol',effort:'high'}};
 const model={id:'model:investigator',kind:'model',step_key:'investigator',intent:{phase:'investigator'},checkpoint:{state:'running',native:{threadId:'owned-thread',turnId:'owned-turn'}}},ledger=new Map([[model.id,model]]);
 const store={async guard(id,run){if(guardHeld)return null;guardHeld=true;try{return await run(row);}finally{guardHeld=false;events.push('guard-released');}},async terminal(){return false;},async allowed(){return true;},async cancelRequested(){return cancel;},async requestStop(){row.code='WORKER_STOPPING';return true;},async effects(){return [...ledger.values()];},async effect(r,kind,key,intent){const id=kind+':'+key;if(!ledger.has(id))ledger.set(id,{id,kind,step_key:key,intent,fresh:true,checkpoint:{state:'not_sent',native:{}}});return ledger.get(id);},async checkpoint(r,id,checkpoint){ledger.get(id).checkpoint=checkpoint;},async set(r,state,code,stage=r.stage,model=r.model){Object.assign(r,{state,code,stage,model});},async evidenceByIds(){return [];}};
 const engine=createVerificationEngine({store,sources:{},runner:{},recipes:[],activeOwner:async()=>true,stopping:()=>owner?.stopping??false,executor(){const sequence=++executors;return {
  async preflight(){throw Error('pinned intent must not preflight');},
  async inspectStep(){return {state:'completed',native:{},result:candidate,code:null,usage:null};},
  async startStep(){modelStarts++;return {state:'blocked',native:{},result:null,code:'FIXTURE_REVIEW_BLOCKED',usage:null};},
  async cancelStep(intent,checkpoint){events.push('cancel-owned');return {...checkpoint,state:infrastructure?'unknown':'failed',code:infrastructure?'CANCEL_UNKNOWN':'CANCELLED'};},
  close(){events.push('child-stop:'+sequence);if(sequence!==1)return Promise.resolve();closing();return exited.then(()=>{events.push('child-exit:'+sequence);});}
 };}});
 owner=verificationProcess(engine);
 return {engine,owner,row,model,events,closeEntered,exit,get guardHeld(){return guardHeld;},get executors(){return executors;},get modelStarts(){return modelStarts;}};
}
test('review readiness and the next phase wait for child exit while the PG guard remains held',async()=>{
 const f=fixture();assert.equal((await f.owner.advance('own')).code,'ENGINE_PENDING');await f.closeEntered;
 assert.equal(f.row.stage,'review');assert.equal(f.guardHeld,true);assert.equal(f.executors,1);
 assert.equal((await f.owner.advance('own')).code,'ENGINE_PENDING');assert.equal((await f.owner.advance('other')).code,'BUSY');assert.equal((await f.engine.advance('own')).code,'BUSY');assert.equal(f.modelStarts,0);
 f.exit();await flush();assert.equal((await f.owner.advance('own')).code,'REVIEW_PENDING');assert.equal(f.guardHeld,false);assert.deepEqual(f.events.slice(-2),['child-exit:1','guard-released']);
 assert.equal((await f.owner.advance('own')).code,'ENGINE_PENDING');await flush();assert.equal(f.executors,2);assert.equal(f.modelStarts,1);assert.equal((await f.owner.advance('own')).code,'FIXTURE_REVIEW_BLOCKED');
});
test('human cancel checkpoints and return wait for cancellation child exit',async()=>{
 const f=fixture({cancel:true});let settled=false;const done=f.engine.advance('own').finally(()=>{settled=true;});await f.closeEntered;await flush();
 assert.equal(settled,false);assert.equal(f.guardHeld,true);assert.equal(f.model.checkpoint.state,'running');assert.notEqual(f.row.state,'cancelled');
 f.exit();assert.equal((await done).code,'CANCELLED');assert.equal(f.model.checkpoint.state,'failed');assert.equal(f.guardHeld,false);assert.equal(f.modelStarts,0);
});
test('worker drain waits for local child exit and then preserves remote unknown without polling it',async()=>{
 const f=fixture({infrastructure:true});await f.owner.advance('own');await f.closeEntered;const ports=[];let drained=false;
 const drain=shutdownVerification(Promise.resolve(),f.owner.stop(),[async()=>ports.push('nats'),async()=>ports.push('pg')]);const rejected=assert.rejects(drain,/VERIFICATION_STOP_UNKNOWN/).then(()=>{drained=true;});await flush();
 assert.equal(drained,false);assert.deepEqual(ports,[]);assert.equal(f.guardHeld,true);
 f.exit();await rejected;assert.equal(drained,true);assert.deepEqual(ports,['nats','pg']);assert.equal(f.row.code,'WORKER_STOP_UNKNOWN');assert.equal(f.modelStarts,0);assert.equal(f.executors,2);
});
