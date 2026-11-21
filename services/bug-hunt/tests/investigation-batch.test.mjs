// ABOUTME: Проверяет границы снимка очереди и параллельное выполнение расследований.
// ABOUTME: Использует поддельные MCP и модель, без обращения к DEV и провайдеру.
import test from "node:test";
import assert from "node:assert/strict";
import {diagnosticWindows,runBatch,snapshotQueue} from "../dist/investigation-batch.js";

const fixed={verdict:"fixed",description:"Known issue",scope:{commit_sha:"test"},evidence:[]};
const facts={component:"hermes",facts:[]};

test("snapshot reads each page with the same cutoff and preserves an event window",async()=>{
 const at=new Date("2026-11-18T18:00:00.999Z");
 const early="2026-11-16T00:00:00.000Z";
 const card=(id,component="hermes")=>({id,component_id:component,revision:1,owner_id:"owner",installation_id:"installation",registered_at:"2026-11-17T01:02:03.001Z",review_state:"new"});
 const read=[];
 const call=async (tool,input)=>{
  if (tool==="list") {
   read.push(input.filters.registered_to);
   return input.cursor?{items:[card("b","nats"),card("c")],next_cursor:null}:{items:[card("a")],next_cursor:"second"};
  }
  const id=input.case_id;
  return {case:card(id),report:{observation:{component_id:"hermes",client_occurred_at:early}},
   investigation:{state:id==="c"?"outcome_unknown":"pending",applicability:"none"}};
 };
 const snapshot=await snapshotQueue(call,at);
 assert.deepEqual(read,[at.toISOString(),at.toISOString()]);
 assert.equal(snapshot.examined,3);
 assert.equal(snapshot.outcome_unknown,1);
 assert.deepEqual(snapshot.candidates.map(card=>card.id),["a","b"]);
 assert.deepEqual(diagnosticWindows(snapshot),[
  {id:"a",component:"hermes",since:"2026-11-16T00:00:00Z",until:"2026-11-17T01:02:03Z"},
  {id:"b",component:"nats",since:"2026-11-16T00:00:00Z",until:"2026-11-17T01:02:03Z"},
 ]);
});

test("batch bounds model overlap, handles exact repeats and leaves unknown outcomes alone",async()=>{
 const candidates=[
  {id:"a",signature:"same"},{id:"repeat",signature:"same"},{id:"b"},{id:"c"},
  {id:"unsupported",component:"nats"},{id:"read-failed",component:"agent"},{id:"unknown",component:"unknown"},{id:"changed"},
 ].map(card=>({revision:1,component:"hermes",...card}));
 const snapshot={as_of:"now",examined:candidates.length+1,candidates,outcome_unknown:1};
 const known=new Set();
 const completed=[];
 const started=[];
 let providerChecks=0;
 let bothStarted;
 const paired=new Promise(resolve=>{bothStarted=resolve;});
 const call=async (operation,args)=>{
  const id=args.case_id;
  if (operation==="get") return {case:{id,revision:id==="changed"?2:1,review_state:"new",owner_id:"owner"},
   report:{observation:id==="unknown"?{}:{title:"Safe description"}},
   investigation:{state:"pending",applicability:known.has(id)?"exact":"none",result:known.has(id)?fixed:undefined}};
  if (operation==="investigation_claim") {
   return {state:"running",replayed:false,investigation_id:id,case_revision:1,projection:id==="unknown"?null:"safe technical details"};
  }
  if (operation==="investigation_complete") {
   completed.push([args.investigation_id,args.result]);
   return {state:"completed"};
  }
  throw Error("unexpected "+operation);
 };
 const sources={diagnostics:{a:facts,b:facts,c:facts},components_without_reader:["nats","unknown"],failed_components:["agent"]};
 const outcome=await runBatch(call,snapshot,sources,2,async()=>{providerChecks++;return null;},async (job,diagnostic,onDispatch)=>{
  onDispatch();
  const id=job.investigation_id;
  started.push(id);
  if (started.length===2) bothStarted();
  await paired;
  if (id==="a") {
   known.add("repeat");
   return "completed";
  }
  if (id==="b") throw Error("unknown model outcome");
  if (id==="unsupported" || id==="read-failed") {
   assert.equal(diagnostic.unavailable,id==="unsupported"?"no_reader":"read_failed");
   assert.ok(!("facts" in diagnostic));
   return "completed";
  }
  return "failed";
 });
 assert.deepEqual(started.slice().sort(),["a","b","c","read-failed","unsupported"]);
 assert.deepEqual(completed.map(([id])=>id).sort(),["repeat","unknown"]);
 const missing=completed.find(([id])=>id==="unknown")[1];
 assert.equal(missing.verdict,"insufficient_evidence");
 assert.match(missing.description,/операции.*время события.*строка журнала/);
 assert.ok(providerChecks>1);
 assert.deepEqual(outcome,{as_of:"now",examined:9,candidates:8,reused:1,completed:4,completed_without_diagnostics:3,failed:1,skipped:1,unresolved:2,blocked:0,model_started:5,model_peak:2,blocked_code:null});
});


test("a shared authorization block leaves model work unclaimed and reports the cause once",async()=>{
 const caseFor=id=>({id,revision:1,review_state:"new",owner_id:"owner"});
 const entries=["a","b","known"];
 const snapshot={as_of:"now",examined:entries.length,candidates:entries.map(id=>({id,revision:1,component:"hermes",known:id==="known"}))};
 const claims=[];
 let providerChecks=0;
 const call=async (operation,args)=>{
  const id=args.case_id;
  if (operation==="get") return {case:caseFor(id),report:{observation:{title:"Safe description"}},
   investigation:{state:"pending",applicability:id==="known"?"exact":"none",result:id==="known"?fixed:undefined}};
  if (operation==="investigation_claim") {
   claims.push(id);
   return {state:"running",replayed:false,investigation_id:id,case_revision:1};
  }
  assert.equal(operation,"investigation_complete");
  assert.deepEqual(args.result,fixed);
  return {state:"completed"};
 };
 const outcome=await runBatch(call,snapshot,{diagnostics:{},components_without_reader:[],failed_components:[]},2,
  async()=>{providerChecks++;return "OWNER_OUTCOME_UNKNOWN";},
  async()=>assert.fail("no model should run"));
 assert.equal(providerChecks,1);
 assert.deepEqual(claims,["known"]);
 assert.equal(outcome.blocked,2);
 assert.equal(outcome.blocked_code,"OWNER_OUTCOME_UNKNOWN");
 assert.equal(outcome.unresolved,0);
 assert.equal(outcome.reused,1);
});


test("loss of authorization mid-batch blocks the next claim",async()=>{
 const claims=[];
 const candidates=["first","later"].map(id=>({id,revision:1,component:"hermes"}));
 const call=async(operation,args)=>{
  if(operation==="get")return {case:{id:args.case_id,revision:1,review_state:"new",owner_id:"owner"},
   hints:{has_projection:true},investigation:{state:"pending",applicability:"none"}};
  assert.equal(operation,"investigation_claim");
  claims.push(args.case_id);
  return {state:"running",replayed:false,investigation_id:args.case_id,case_revision:1,projection:"safe"};
 };
 let checks=0;
 const outcome=await runBatch(call,{as_of:"now",examined:2,candidates},
  {diagnostics:{},components_without_reader:[],failed_components:[]},1,
  async()=>++checks===1 ? null : "OWNER_OUTCOME_UNKNOWN",async()=>"completed");
 assert.deepEqual(claims,["first"]);
 assert.equal(outcome.blocked,1);
 assert.equal(outcome.blocked_code,"OWNER_OUTCOME_UNKNOWN");
 assert.equal(outcome.completed,1);
});
