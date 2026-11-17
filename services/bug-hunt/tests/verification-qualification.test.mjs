// ABOUTME: Проверяет qualification через настоящий её сценарий и управляемый native transport.
// ABOUTME: Random oracle появляется у модели только из callback; OpenAI и credentials не используются.
import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm,writeFile,mkdir} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {qualification} from "../runtime/qualification.mjs";
import {VerificationFault as VF} from "../dist/verification.js";
async function fixture(t,{unexpected=false,lostAck=false,lostThreadAck=false,eof=false,authStore=false,openMcp=false}={}){
 const root=await mkdtemp(path.join(tmpdir(),"bug-hunt-qualification-test-"));t.after(()=>rm(root,{recursive:true,force:true}));if(authStore){await mkdir(path.join(root,".codex"));await writeFile(path.join(root,".codex/auth.json"),'{}');}
 const cfg={verificationRuntime:{nativeProfiles:{own:{generation:"state-generation",filesystem_isolation_verified:true,tool_policy_version:"no-environment-scoped-tools-v2",cwd:root,process:{stateRoot:root}}}}};
 const listeners=new Set(),disconnects=new Set(),calls=[],sent=[];let connected=false,closed=false,reply=null;
 const emit=p=>{for(const fn of listeners)fn(p);};
 const rpc={async prepare(){return {model:"gpt-99.3-sol",contextWindow:812345,sourceRef:"a".repeat(64),catalog_revision:"b".repeat(64),effective_catalog_revision:"c".repeat(64)};},async checkBinding(){},async connect(){connected=true;},connected:()=>connected,onDisconnect(fn){disconnects.add(fn);return()=>disconnects.delete(fn);},subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},close(){closed=true;connected=false;for(const fn of disconnects)fn();},send(packet){sent.push(packet);if(packet.id===17){reply=packet.result.contentItems[0].text;assert.ok(reply.startsWith("BHQ-"));assert.ok(!JSON.stringify(calls).includes(reply));emit({method:"thread/tokenUsage/updated",params:{threadId:"owned-thread",turnId:"owned-turn",tokenUsage:{modelContextWindow:771727}}});emit({method:"item/completed",params:{threadId:"owned-thread",turnId:"owned-turn",item:{type:"agentMessage",text:reply}}});emit({method:"turn/completed",params:{threadId:"owned-thread",turn:{id:"owned-turn",status:"completed"}}});}},
 async call(method,params){calls.push({method,params});
  if(method==="initialize")return {};
  if(method==="config/read")return {config:{mcp_servers:{configured:{}},plugins:{configured:{}}}};
  if(method==="model/list")return {data:[{id:"gpt-99.3-sol",model:"gpt-99.3-sol",supportedReasoningEfforts:[{reasoningEffort:"high"}]}],nextCursor:null};
  if(method==="thread/start"){if(lostThreadAck)throw new VF("NATIVE_RPC_TIMEOUT","unknown");return {thread:{id:"owned-thread"},sandbox:{type:"readOnly"},approvalPolicy:"never"};}
  if(method==="mcpServerStatus/list")return {data:[{runtimeStatus:openMcp?"ready":"disabled"}],nextCursor:null};
  if(method==="turn/start"){
   if(lostAck)throw new VF("NATIVE_RPC_TIMEOUT","unknown");
   if(eof)setImmediate(()=>{connected=false;for(const fn of disconnects)fn();});
   else emit({id:17,method:unexpected?"item/commandExecution/requestApproval":"item/tool/call",params:{threadId:"owned-thread",turnId:"owned-turn",callId:"owned-call",tool:"probe_echo",arguments:{value:"qualification"}}});
   return {turn:{id:"owned-turn"}};
  }
  if(method==="thread/turns/list")return {data:[{id:"owned-turn",status:"completed",items:[{type:"agentMessage",text:reply}]}],nextCursor:null};
  if(method==="thread/archive"||method==="turn/interrupt")return {};
  throw Error("unexpected test RPC");
 }};
 return {cfg,rpc,calls,sent,get closed(){return closed;},get marker(){return reply;},run:()=>qualification(cfg,{rpcFactory:()=>rpc})};
}
test("one pre-ACK callback returns a fresh random oracle, actual context and safe provenance",async t=>{
 const first=await fixture(t),result=await first.run(),second=await fixture(t);assert.equal((await second.run()).state,"verified");
 assert.equal(result.state,"verified");assert.equal(result.model,"gpt-99.3-sol");assert.equal(result.contextWindow,771727);assert.equal(result.toolCalls,1);assert.equal(result.oracleMatched,true);assert.equal(result.authStoreAbsent,true);assert.equal(result.bearerPersisted,"unknown");assert.equal(first.closed,true);assert.notEqual(first.marker,second.marker);assert.equal(JSON.stringify(result).includes(first.marker),false);
 const thread=first.calls.find(p=>p.method==="thread/start").params;assert.deepEqual(thread.environments,[]);assert.equal(thread.approvalPolicy,"never");assert.equal(thread.config["features.shell_tool"],false);assert.equal(thread.config.mcp_servers.configured.enabled,false);assert.deepEqual(thread.dynamicTools.map(tool=>tool.name),["probe_echo"]);assert.equal(first.calls.find(p=>p.method==="turn/start").params.effort,"high");assert.equal(first.calls.filter(p=>p.method==="thread/archive").length,1);
});
test("unexpected approval request is refused, own turn interrupted and native always closed",async t=>{
 const f=await fixture(t,{unexpected:true}),result=await f.run();assert.equal(result.state,"failed");assert.equal(result.code,"NATIVE_UNEXPECTED_REQUEST");assert.equal(result.toolCalls,0);assert.equal(f.sent.some(p=>p.id===17),false);assert.deepEqual(f.calls.find(p=>p.method==="turn/interrupt").params,{threadId:"owned-thread",turnId:"owned-turn"});assert.equal(f.closed,true);
});
test("lost turn ACK and EOF are unknown without another start or hanging wait",{timeout:2000},async t=>{
 for(const options of [{lostAck:true},{lostThreadAck:true},{eof:true}]){const f=await fixture(t,options),result=await f.run();assert.equal(result.state,"unknown");assert.equal(f.calls.filter(p=>p.method==="turn/start").length,options.lostThreadAck?0:1);assert.equal(f.calls.filter(p=>p.method==="thread/start").length,1);assert.equal(f.closed,true);}
});
test("native auth.json prevents a verified qualification",async t=>{
 const f=await fixture(t,{authStore:true}),result=await f.run();assert.equal(result.state,"failed");assert.equal(result.code,"NATIVE_AUTH_STORE_PRESENT");assert.equal(result.authStoreAbsent,false);assert.equal(f.closed,true);
});

test("configured MCP connection is checked on own thread before any turn",async t=>{
 const f=await fixture(t,{openMcp:true}),result=await f.run();assert.equal(result.state,"failed");assert.equal(result.code,"NATIVE_MCP_ISOLATION_UNPROVEN");assert.equal(f.calls.filter(p=>p.method==="turn/start").length,0);assert.equal(f.calls.filter(p=>p.method==="thread/archive").length,1);assert.equal(f.closed,true);
});
