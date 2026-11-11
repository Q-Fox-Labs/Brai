// ABOUTME: Проверяет native протокол v3, владение tools и восстановление неизвестного старта.
// ABOUTME: Это управляемый протокольный fixture, не приёмка настоящего inference или авторизации.
import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {codexExecutor,providersExecutor,parseProvidersCandidate} from "../dist/verification-models.js";
import {VerificationFault as VF} from "../dist/verification.js";
const profile={socketUrl:"ws+unix:///synthetic.sock:",generation:"fixture-generation",serverVersion:"0.166.0",cwd:"/work",schema_sha256:"a".repeat(64),filesystem_isolation_verified:true,qualified_models:["gpt-6.1-sol"],tool_policy_version:"no-environment-scoped-tools-v2"};
const intent=()=>({id:randomUUID(),scope:{installation_id:"fixture",owner_id:"owner",investigation_id:randomUUID()},phase:"investigator",executor:"codex_app_server",config_hash:"b".repeat(64),model:{id:"gpt-6.1-sol",effort:"high",catalog_revision:"fixture",resolver_version:"sol-stable-numeric-v1"},deadline_at:new Date(Date.now()+3000).toISOString(),input:{output_schema:{type:"object"}},input_hash:"c".repeat(64)});
function fixture(options={}){
 const calls=[],sent=[],listeners=new Set();let tools=0,reserves=0,closed=false,interrupted=false;
 const emit=p=>{for(const fn of listeners)fn(p);};
 const rpc={async connect(){},close(){closed=true;},subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},send(p){sent.push(p);},
 async call(method,params){calls.push({method,params});
  if(method==="initialize")return {userAgent:"codex/0.166.0 (linux)"};
  if(method==="account/read")return {account:options.noAuth?null:{type:"chatgpt"}};
  if(method==="model/list")return {data:[{id:"gpt-6.1-sol",supportedReasoningEfforts:[{reasoningEffort:"high"}]}],nextCursor:null};
  if(method==="config/read")return {config:{mcp_servers:{},plugins:{"synthetic-plugin":{}}}};
  if(method==="mcpServerStatus/list")return {data:options.openMcp?[{name:"synthetic",runtimeStatus:"ready"}]:[],nextCursor:null};
  if(method==="thread/start"){if(options.lostThreadAck)throw new VF("NATIVE_RPC_TIMEOUT","unknown");return {thread:{id:"own-thread"},sandbox:{type:"readOnly"},approvalPolicy:"never"};}
  if(method==="turn/start"){
   if(options.lostTurnAck)throw new VF("NATIVE_RPC_TIMEOUT","unknown");
   setTimeout(()=>{
    emit({id:91,method:"item/tool/call",params:{threadId:"foreign-thread",turnId:"own-turn",callId:"foreign",tool:"evidence_list",arguments:{}}});
    emit({id:92,method:"item/tool/call",params:{threadId:"own-thread",turnId:"foreign-turn",callId:"foreign-turn",tool:"evidence_list",arguments:{}}});
    for(let n=0;n<200;n++)emit({method:"item/agentMessage/delta",params:{threadId:"own-thread",turnId:"own-turn",delta:"partial"}});
    emit({method:"item/tool/call.delta",params:{threadId:"own-thread",turnId:"own-turn",argumentsDelta:"partial"}});
    emit({id:93,method:options.approval?"item/commandExecution/requestApproval":"item/tool/call",params:{threadId:"own-thread",turnId:"own-turn",callId:"own",tool:"evidence_list",arguments:{}}});
    emit({method:"turn/completed",params:{threadId:"own-thread",turn:{id:"own-turn",status:"completed"}}});
   },5);
   return {turn:{id:"own-turn"}};
  }
  if(method==="thread/turns/list")return {data:[{id:"own-turn",status:interrupted?"interrupted":options.pending?"inProgress":options.failed?"failed":"completed",items:[{type:"agentMessage",text:'{"verdict":"insufficient_evidence"}'}]}],nextCursor:null};
  if(method==="turn/interrupt"){if(options.lostInterrupt)throw new VF("NATIVE_RPC_TIMEOUT","unknown");interrupted=true;return {};}
  if(method==="thread/archive")return {};
  throw Error("Unexpected RPC "+method);
 }};
 const dispatch={tools:()=>[{type:"function",function:{name:"evidence_list",parameters:{type:"object",properties:{},required:[],additionalProperties:false}}}],call:async()=>{tools++;return {items:[]};},reserve:async()=>{reserves++;},allowed:async()=>true};
 return {executor:codexExecutor(profile,dispatch,rpc),calls,sent,get tools(){return tools;},get reserves(){return reserves;},get closed(){return closed;}};
}
test("native full tool request is scoped, delta and foreign requests have no effect",async()=>{
 const f=fixture(),states=[];const cp=await f.executor.startStep(intent(),async x=>states.push(structuredClone(x)));
 assert.equal(cp.state,"completed");assert.equal(f.tools,1);assert.equal(f.reserves,1);
 assert.equal(f.sent.filter(p=>p.id===93).length,1);assert.equal(f.sent.filter(p=>p.id===91||p.id===92).length,0);
 assert.equal(states[0].state,"dispatching");assert.equal(f.calls.find(p=>p.method==="thread/start").params.config["features.shell_tool"],false);
 f.executor.close();assert.equal(f.closed,true);
});
test("lost thread or turn ACK stays unknown and inspect never starts another resource",async()=>{
 for(const option of ["lostThreadAck","lostTurnAck"]){const f=fixture({[option]:true}),i=intent();const cp=await f.executor.startStep(i,async()=>{});assert.equal(cp.state,"unknown");const before=f.calls.filter(p=>p.method.endsWith("/start")).length;await f.executor.inspectStep(i,cp,async()=>{});assert.equal(f.calls.filter(p=>p.method.endsWith("/start")).length,before);}
});
test("missing subscription auth has no model start and no Providers path",async()=>{
 const f=fixture({noAuth:true});const cp=await f.executor.startStep(intent(),async()=>{});assert.equal(cp.state,"blocked");assert.equal(f.calls.filter(p=>p.method.endsWith("/start")).length,0);assert.equal(f.reserves,0);
});
test("approval blocks only own turn; failed native completion is never a candidate",async()=>{
 const blocked=fixture({approval:true}),cp=await blocked.executor.startStep(intent(),async()=>{});assert.equal(cp.state,"failed");assert.equal(blocked.tools,0);assert.deepEqual(blocked.calls.find(x=>x.method==="turn/interrupt").params,{threadId:"own-thread",turnId:"own-turn"});
 const failed=fixture({failed:true});assert.equal((await failed.executor.startStep(intent(),async()=>{})).state,"failed");
});

test("actual own-thread MCP connection blocks model before turn",async()=>{
 const f=fixture({openMcp:true});const cp=await f.executor.startStep(intent(),async()=>{});
 assert.equal(cp.state,"blocked");assert.equal(cp.code,"NATIVE_MCP_ISOLATION_UNPROVEN");assert.equal(f.reserves,1);
 assert.equal(f.calls.filter(p=>p.method==="turn/start").length,0);
 assert.equal(f.calls.find(p=>p.method==="mcpServerStatus/list").params.threadId,"own-thread");
 assert.equal(f.calls.find(p=>p.method==="thread/start").params.config['plugins."synthetic-plugin".enabled'],false);
});

test("restart enforces persisted model deadline and interrupts only the owned turn",async()=>{
 const f=fixture({pending:true}),i=intent(),cp={state:"running",native:{generation:profile.generation,threadId:"own-thread",turnId:"own-turn",call_deadline_at:new Date(Date.now()-1000).toISOString()},result:null,code:null,usage:null};
 const saved=[];const pending=await f.executor.inspectStep(i,cp,async v=>saved.push(structuredClone(v)));
 assert.equal(pending.state,"unknown");assert.equal(saved.at(-1).native.cancel_reason,"MODEL_DEADLINE");
 assert.deepEqual(f.calls.find(c=>c.method==="turn/interrupt").params,{threadId:"own-thread",turnId:"own-turn"});
 assert.equal((await f.executor.inspectStep(i,pending,async()=>{})).state,"failed");
 assert.equal(f.calls.filter(c=>c.method.endsWith("/start")).length,0);
});
test("lost interrupt ACK keeps unexpected native request unknown until terminal observation",async()=>{
 const f=fixture({approval:true,pending:true,lostInterrupt:true}),i=intent();const cp=await f.executor.startStep(i,async()=>{});
 assert.equal(cp.state,"unknown");assert.equal(cp.native.cancel_reason,"NATIVE_UNEXPECTED_REQUEST");
 assert.equal((await f.executor.inspectStep(i,cp,async()=>{})).state,"unknown");
 assert.equal(f.calls.filter(c=>c.method==="turn/start").length,1);
});

function providerFixture({lostAck=false,invalid=false}={}){
 const requests=[],operations=new Map();let gets=0,tools=0,reserves=0;
 const result=(text,toolCalls=[])=>({partial:false,actualModel:"deepseek/deepseek-v3.2",finishReason:toolCalls.length?"tool_calls":"stop",text,toolCalls,usage:{inputTokens:2,outputTokens:3}});
 const client={async chat(input){requests.push(structuredClone(input));const op={operationId:input.operationId,phase:"succeeded",result:requests.length===1&&!invalid?result("",[{id:"tool-original",name:"evidence_list",arguments:{}}]):result(invalid?"not JSON":'{"verdict":"insufficient_evidence"}')};operations.set(input.operationId,op);if(lostAck&&requests.length===1)throw Error("Lost accepted ACK");return op;},async get(id){gets++;return operations.get(id);},async cancel(){throw Error("not used");}};
 const dispatch={tools:()=>[],allowed:async()=>true,remainingMs:()=>90000,reserve:async()=>{reserves++;},call:async(id,name,args)=>{assert.equal(id,"tool-original");tools++;return {items:[]};}};
 return {executor:providersExecutor(null,"owner",{connectionId:"fixture",provider:"openrouter",model:"deepseek/deepseek-v3.2",revision:"fixture",inboxPrefix:"_INBOX."},dispatch,client),requests,get gets(){return gets;},get tools(){return tools;},get reserves(){return reserves;}};
}
test("Providers completes exactly one tool round per durable Activity and preserves continuation IDs",async()=>{
 const f=providerFixture(),i=intent();let cp=await f.executor.startStep(i,async()=>{});
 assert.equal(cp.state,"running");assert.equal(f.requests.length,1);assert.equal(f.tools,1);
 const previous=f.requests[0].operationId;assert.equal(cp.native.previous,previous);assert.equal(cp.native.operationId,null);
 cp=await f.executor.inspectStep(i,structuredClone(cp),async()=>{});
 assert.equal(cp.state,"completed");assert.equal(f.requests.length,2);assert.equal(f.reserves,2);assert.equal(f.gets,0);
 assert.equal(f.requests[1].continuation.operationId,previous);assert.equal(f.requests[1].toolResults[0].id,"tool-original");
 assert.equal(Object.keys(cp.native.usage_totals).length,2);
});
test("Providers lost accepted ACK recovers only the same operationId via get",async()=>{
 const f=providerFixture({lostAck:true}),i=intent(),cp=await f.executor.startStep(i,async()=>{});
 assert.equal(cp.state,"unknown");const recovered=await f.executor.inspectStep(i,cp,async()=>{});
 assert.equal(recovered.state,"running");assert.equal(f.requests.length,1);assert.equal(f.gets,1);assert.equal(f.tools,1);
});
test("known terminal malformed Providers output fails instead of becoming unknown",async()=>{
 const f=providerFixture({invalid:true});const cp=await f.executor.startStep(intent(),async()=>{});
 assert.equal(cp.state,"failed");assert.equal(cp.code,"MODEL_OUTPUT_INVALID");assert.equal(f.requests.length,1);
});

test("terminal Providers presentation wrapper preserves complete JSON and refuses ambiguous or truncated output",()=>{
 const value={verdict:"insufficient_evidence",missing:["fixture"]},json=JSON.stringify(value);
 assert.deepEqual(parseProvidersCandidate(json),value);
 assert.deepEqual(parseProvidersCandidate("Комментарий вне результата.\n\n"+String.fromCharCode(96).repeat(3)+"json\n"+json+"\n"+String.fromCharCode(96).repeat(3)),value);
 for(const text of ["not JSON",json+" extra",String.fromCharCode(96).repeat(3)+"json\n"+json,Array(2).fill(String.fromCharCode(96).repeat(3)+"json\n"+json+"\n"+String.fromCharCode(96).repeat(3)).join("\n"),"[]","null"])assert.throws(()=>parseProvidersCandidate(text),e=>e.code==="MODEL_OUTPUT_INVALID");
});
