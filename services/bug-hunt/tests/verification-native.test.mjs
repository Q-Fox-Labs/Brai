// ABOUTME: Проверяет bootstrap и stdio границы приватного native без OpenAI и настоящих credentials.
// ABOUTME: Дочерний fixture сохраняет историю и позволяет воспроизвести ранние события, EOF и потерянные ACK.
import test from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdtemp,readFile,readdir,rm,stat} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {once} from "node:events";
import {createServer,Socket} from "node:net";
import {nativeProcessRpc,projectNativeCatalog,credentialCall,investigatorOwnerBlock} from "../dist/verification-native.js";
import {codexExecutor,nativeThreadConfig} from "../dist/verification-models.js";
const catalog=()=>({etag:"fixture",models:[{slug:"gpt-6.1-sol",visibility:"list",tool_mode:"code_mode_only",context_window:500000,effective_context_window_percent:95,supported_reasoning_levels:[{effort:"low"},{effort:"high"}],unknown_future_metadata:{preserve:true}},{slug:"gpt-9-sol-preview",visibility:"list",tool_mode:"code_mode_only",context_window:1,supported_reasoning_levels:[{effort:"high"}]}]});
const sourceRef="a".repeat(64),bearer="PRIVATE_ACCESS_NEVER_PERSIST_"+Math.random();
const owner=()=>({ready:true,code:"READY",binding:"fixture-binding",accountId:"fixture-account",expiresAt:Date.now()/1000+3600,baseUrl:"https://chatgpt.com/backend-api/codex",sourceRef});
const script=String.raw`
 const fs=require('node:fs'),rl=require('node:readline').createInterface({input:process.stdin});
 const mode=process.argv[1],root=process.argv[2],file=root+'/history.json',calls=root+'/calls.jsonl';
 const send=p=>process.stdout.write(JSON.stringify(p)+'\n'),reply=(p,result)=>send({id:p.id,result});
 const model={id:mode==='alias'?'alias-sol':'gpt-6.1-sol',model:'gpt-6.1-sol',supportedReasoningEfforts:[{reasoningEffort:'high'}]};
 rl.on('line',line=>{const p=JSON.parse(line);fs.appendFileSync(calls,JSON.stringify(p)+'\n');
  if(p.id===88&&!p.method){fs.writeFileSync(file,JSON.stringify({id:'turn-owned',status:'completed',items:[{type:'agentMessage',text:'{"verdict":"insufficient_evidence"}'}]}));send({method:'thread/tokenUsage/updated',params:{threadId:'thread-owned',turnId:'turn-owned',tokenUsage:{total:{inputTokens:3,outputTokens:2,totalTokens:5},modelContextWindow:475000}}});send({method:'turn/completed',params:{threadId:'thread-owned',turn:{id:'turn-owned',status:'completed'}}});return;}
  if(!p.method||p.method==='initialized')return;
  if(p.method==='initialize')return reply(p,{userAgent:'codex/99.0.0 compatible'});
  if(p.method==='account/read')return reply(p,{account:null});
  if(p.method==='model/list')return reply(p,{data:[model,{id:'gpt-99-sol',model:'gpt-99-sol',supportedReasoningEfforts:[{reasoningEffort:'high'}]}],nextCursor:null});
  if(p.method==='config/read')return reply(p,{config:{}});
  if(p.method==='large/fixture')return reply(p,{text:'x'.repeat(4194305)});
  if(p.method==='mcpServerStatus/list')return reply(p,{data:[],nextCursor:null});
  if(p.method==='thread/start'){fs.writeFileSync(file,JSON.stringify({id:'turn-owned',status:'inProgress',items:[]}));if(mode==='lost-thread')return process.exit(0);return reply(p,{thread:{id:'thread-owned'},sandbox:{type:'readOnly'},approvalPolicy:'never'});}
  if(p.method==='turn/start'){
   if(mode==='lost-turn')return process.exit(0);
   if(mode==='eof'){reply(p,{turn:{id:'turn-owned'}});return process.exit(0);}
   if(mode==='quiet')return reply(p,{turn:{id:'turn-owned'}});
   send({id:88,method:'item/tool/call',params:{threadId:'thread-owned',turnId:'turn-owned',callId:'call-owned',tool:'evidence_list',arguments:{}}});
   return reply(p,{turn:{id:'turn-owned'}});
  }
  if(p.method==='thread/resume')return reply(p,{thread:{id:'thread-owned'},sandbox:{type:'readOnly'},approvalPolicy:'never'});
  if(p.method==='thread/turns/list')return reply(p,{data:[JSON.parse(fs.readFileSync(file,'utf8'))],nextCursor:null});
  if(p.method==='thread/archive'||p.method==='turn/interrupt')return reply(p,{});
  send({id:p.id,error:{code:-32601,message:'unknown'}});
 });`;
async function fixture(t,{mode="normal",version="99.0.0",stateRoot,credential,fetcher,onTool}={}){
 const root=stateRoot??await mkdtemp(path.join(tmpdir(),"bug-hunt-native-test-"));if(!stateRoot)t.after(()=>rm(root,{recursive:true,force:true}));
 const profile={generation:"stable-state-generation",filesystem_isolation_verified:true,tool_policy_version:"no-environment-scoped-tools-v2",cwd:root,process:{binary:"/accepted/codex",python:"/accepted/python",credentialClient:"/accepted/client.py",credentialSocket:"/private/owner.sock",stateRoot:root,catalogPath:path.join(root,"model-catalog.json"),sourceRef,launcher:{binary:"/accepted/bwrap",args:["--unshare-all","--share-net","--clearenv"]}}};
 const requests=[],launches=[],children=[];let toolCalls=0;
 const rpc=nativeProcessRpc(profile.process,nativeThreadConfig([]),{version:async()=>version,credential:credential??(async(socket,method,params)=>{requests.push({method,params});return {...owner(),...(method==="resolve"?{access:bearer}:{})};}),fetch:fetcher??(async(url,options)=>{assert.match(url,/client_version=99.0.0/);assert.equal(options.headers.Authorization,"Bearer "+bearer);return {ok:true,json:async()=>catalog()};}),launch:(binary,args,options)=>{launches.push({binary,args,options});const child=spawn(process.execPath,["-e",script,mode,root],options);children.push(child);return child;}});
 const dispatch={tools:()=>[{type:"function",function:{name:"evidence_list",parameters:{type:"object"}}}],allowed:async()=>true,reserve:async()=>{},call:async(id)=>{assert.equal(id,"call-owned");toolCalls++;onTool?.();return {items:[]};}};
 const executor=codexExecutor(profile,dispatch,rpc);t.after(()=>executor.close());
 return {root,profile,rpc,executor,requests,launches,children,get toolCalls(){return toolCalls;},async intent(){const ready=await executor.preflight();return {id:"intent",phase:"investigator",model:{id:ready.models[0].id,effort:"high",catalog_revision:ready.catalog_revision},deadline_at:null,input:{output_schema:{type:"object"}}};},async calls(){return (await readFile(path.join(root,"calls.jsonl"),"utf8")).trim().split("\n").map(JSON.parse);}};
}
test("catalog projection changes only selected stable model tool_mode, preserves metadata and rejects missing high",()=>{
 const raw=catalog(),expected=structuredClone(raw);expected.models[0].tool_mode="direct";const value=projectNativeCatalog(raw);
 assert.deepEqual(value.catalog,expected);assert.equal(raw.models[0].tool_mode,"code_mode_only");assert.equal(value.contextWindow,500000);assert.equal(value.models.length,1);
 raw.models.push({...raw.models[0],slug:"gpt-7-sol",supported_reasoning_levels:[{effort:"low"}]});assert.throws(()=>projectNativeCatalog(raw),e=>e.code==="SOL_HIGH_UNAVAILABLE");
 assert.throws(()=>projectNativeCatalog({models:[...catalog().models,catalog().models[0]]}),e=>e.code==="NATIVE_CATALOG_INVALID");
});
test("stdio retains pre-ACK tool, actual usage, private state and never writes bearer",async t=>{
 const f=await fixture(t),i=await f.intent();assert.equal(i.model.id,"gpt-6.1-sol");
 const cp=await f.executor.startStep(i,async()=>{});assert.equal(cp.state,"completed");assert.equal(f.toolCalls,1);assert.equal(cp.native.providerBinding,owner().binding);assert.equal(cp.native.effective_context_window,475000);assert.match(cp.native.effective_catalog_revision,/^[a-f0-9]{64}$/);assert.equal(cp.usage.totalTokens,5);
 assert.equal(f.requests.filter(p=>p.method==="resolve").length,1);assert.equal((await stat(f.profile.process.catalogPath)).mode&0o777,0o400);
 assert.equal(JSON.stringify(f.launches).includes(bearer),false);assert.equal(JSON.stringify(cp).includes(bearer),false);
 assert.ok(f.launches[0].args.includes("stdio://"));assert.ok(f.launches[0].args.some(a=>a.includes('requires_openai_auth=false')));assert.ok(f.launches[0].args.some(a=>a.includes('request_max_retries=0')));
 for(const name of await readdir(f.root)){const info=await stat(path.join(f.root,name));if(info.isFile())assert.equal((await readFile(path.join(f.root,name))).includes(Buffer.from(bearer)),false);}
 const exited=once(f.children[0],"exit");f.executor.close();await exited;assert.ok(await stat(path.join(f.root,"history.json")));
 const restarted=await fixture(t,{stateRoot:f.root});const recovered=await restarted.executor.inspectStep(i,{...cp,state:"unknown",native:{...cp.native,cleanup:null}},async()=>{});
 assert.equal(recovered.state,"completed");const calls=await restarted.calls();assert.equal(calls.filter(p=>p.method==="turn/start").length,1);assert.equal(calls.filter(p=>p.method==="thread/start").length,1);assert.ok(calls.some(p=>p.method==="thread/resume"));
 const stopped=once(restarted.children[0],"exit");restarted.executor.close();await stopped;
 const cancelling=await fixture(t,{stateRoot:f.root});await cancelling.executor.cancelStep(i,{...cp,state:"unknown"});
 const cancelledCalls=await cancelling.calls();assert.equal(cancelledCalls.filter(p=>p.method==="turn/start").length,1);assert.equal(cancelledCalls.filter(p=>p.method==="thread/start").length,1);assert.deepEqual(cancelledCalls.find(p=>p.method==="turn/interrupt").params,{threadId:"thread-owned",turnId:"turn-owned"});
});
test("EOF releases pending RPC and an unbounded native wait; lost ACK never dispatches again",{timeout:5000},async t=>{
 for(const mode of ["eof","lost-thread","lost-turn"]){const f=await fixture(t,{mode}),i=await f.intent();const cp=await f.executor.startStep(i,async()=>{});assert.equal(cp.state,"unknown",mode);assert.equal(cp.code,"NATIVE_CONNECTION_LOST");const before=(await f.calls()).filter(p=>p.method?.endsWith("/start")).length;const restart=await fixture(t,{stateRoot:f.root});await restart.executor.inspectStep(i,cp,async()=>{});assert.equal((await restart.calls()).filter(p=>p.method?.endsWith("/start")).length,before);}
});
test("mixed bundled model catalog cannot replace authoritative selection; alias is rejected",async t=>{
 const f=await fixture(t,{mode:"alias"});await assert.rejects(f.executor.preflight(),e=>e.code==="NATIVE_MODEL_CATALOG_MISMATCH");assert.equal((await f.calls()).filter(p=>p.method?.endsWith("/start")).length,0);
});
test("binding, source and account changes fail closed before effects",async t=>{
 for(const changed of [{binding:"changed"},{accountId:"changed"},{sourceRef:"b".repeat(64)},{ready:false}]){
  let status=0;const f=await fixture(t,{credential:async(socket,method)=>({...owner(),...(method==="resolve"?{access:bearer}:++status>2?changed:{})})});
  const ready=await f.executor.preflight();const cp=await f.executor.startStep({phase:"investigator",model:{id:ready.models[0].id,effort:"high",catalog_revision:ready.catalog_revision},deadline_at:null,input:{output_schema:{type:"object"}}},async()=>{});
  assert.equal(cp.state,"blocked");assert.equal(cp.code,"NATIVE_CREDENTIAL_BINDING_CHANGED");assert.equal((await f.calls()).filter(p=>p.method?.endsWith("/start")).length,0);
 }
});
test("quiet unlimited native wait fences owner binding changes and interrupts its own turn",{timeout:3000},async t=>{
 let f;f=await fixture(t,{mode:"quiet",credential:async(socket,method)=>{
  const sent=method==="status"?await readFile(path.join(f.root,"calls.jsonl"),"utf8").catch(()=>""):"";
  return {...owner(),...(method==="resolve"?{access:bearer}:sent.includes('"method":"turn/start"')?{binding:"new-binding"}:{})};
 }});
 const cp=await f.executor.startStep(await f.intent(),async()=>{});
 assert.equal(cp.state,"unknown");assert.equal(cp.code,"NATIVE_CREDENTIAL_BINDING_CHANGED");assert.equal(cp.native.cancel_reason,"NATIVE_CREDENTIAL_BINDING_CHANGED");assert.equal(f.toolCalls,0);
 const calls=await f.calls();assert.equal(calls.filter(p=>p.method==="turn/start").length,1);assert.deepEqual(calls.find(p=>p.method==="turn/interrupt").params,{threadId:"thread-owned",turnId:"turn-owned"});
});
test("binding changes during tool execution prevent reply and model continuation",async t=>{
 let revoked=false;const f=await fixture(t,{onTool:()=>{revoked=true;},credential:async(socket,method)=>({...owner(),...(method==="resolve"?{access:bearer}:revoked?{binding:"new-binding"}:{})})});
 const cp=await f.executor.startStep(await f.intent(),async()=>{});assert.equal(cp.state,"unknown");assert.equal(cp.code,"NATIVE_CREDENTIAL_BINDING_CHANGED");assert.equal(f.toolCalls,1);
 const calls=await f.calls();assert.equal(calls.filter(p=>p.id===88).length,0);assert.equal(calls.filter(p=>p.method==="turn/interrupt").length,1);
});
test("catalog known 401 has one resolve and one GET, no native child or retry",async t=>{
 let resolves=0,gets=0;const f=await fixture(t,{credential:async()=>{resolves++;return {...owner(),access:bearer};},fetcher:async()=>{gets++;return {ok:false,status:401};}});
 await assert.rejects(f.executor.preflight(),e=>e.code==="NATIVE_AUTH_REJECTED");assert.equal(resolves,1);assert.equal(gets,1);assert.equal(f.children.length,0);
});
test("owner RPC is newline JSONRPC2, exposes no bearer from status and fails closed on socket EOF",async t=>{
 const root=await mkdtemp(path.join(tmpdir(),"bug-hunt-owner-test-"));t.after(()=>rm(root,{recursive:true,force:true}));const socket=path.join(root,"owner.sock");
 const received=[];const server=createServer(connection=>{connection.once("data",data=>{const request=JSON.parse(data.toString());received.push({method:request.method,params:request.params});assert.equal(request.jsonrpc,"2.0");assert.equal(typeof request.id,"string");if(request.method==="credentials.status")connection.end(JSON.stringify({jsonrpc:"2.0",id:request.id,result:owner()})+"\n");else connection.end();});});
 server.listen(socket);await once(server,"listening");t.after(()=>server.close());assert.equal((await credentialCall(socket,"status")).ready,true);await assert.rejects(credentialCall(socket,"resolve",{expectedBinding:"opaque"}),e=>e.code==="NATIVE_CREDENTIAL_UNAVAILABLE");assert.deepEqual(received,[{method:"credentials.status",params:{}},{method:"credentials.resolve",params:{expectedBinding:"opaque"}}]);
});

test("credential RPC waits for owner reply without a client socket timeout or an added payload cap",async t=>{
 const root=await mkdtemp(path.join(tmpdir(),"bug-hunt-owner-wait-test-"));t.after(()=>rm(root,{recursive:true,force:true}));const socket=path.join(root,"owner.sock"),timeouts=[];
 t.mock.method(Socket.prototype,"setTimeout",function(value){timeouts.push(value);return this;});
 let respond,observed;const requestReceived=new Promise(resolve=>observed=resolve);
 const server=createServer(connection=>{connection.once("data",data=>{const request=JSON.parse(data.toString());respond=()=>connection.end(JSON.stringify({jsonrpc:"2.0",id:request.id,result:{...owner(),access:"x".repeat(4194305)}})+"\n");observed();});});
 server.listen(socket);await once(server,"listening");t.after(()=>server.close());let settled=false;
 const pending=credentialCall(socket,"resolve").finally(()=>{settled=true;});await requestReceived;await new Promise(resolve=>setImmediate(resolve));assert.equal(settled,false);assert.deepEqual(timeouts,[]);respond();const value=await pending;assert.equal(value.access.length,4194305);assert.deepEqual(timeouts,[]);
});
test("stdio RPC applies no additional payload cap to valid native responses",async t=>{
 const f=await fixture(t);await f.rpc.prepare();await f.rpc.connect();const result=await f.rpc.call("large/fixture",{});assert.equal(result.text.length,4194305);
});


test("an unknown shared credential is reconciled before claim only against its fresh binding",async()=>{
 const profile={credentialSocket:"/private/owner.sock",sourceRef};
 const status={...owner(),ready:false,code:"OWNER_OUTCOME_UNKNOWN",binding:"a".repeat(32)};
 const calls=[];
 const request=async(socket,method,params)=>{
  assert.equal(socket,profile.credentialSocket);
  calls.push({method,params});
  return method==="status"?status:{...status,ready:true,code:"READY",access:bearer};
 };
 assert.equal(await investigatorOwnerBlock(profile,request),null);
 assert.deepEqual(calls,[{method:"status",params:undefined},{method:"resolve",params:{expectedBinding:status.binding}}]);
 for(const selection of [{expiresAt:0},{sourceRef:"foreign"},{binding:"wrong"},{expiresAt:undefined}]) {
  await investigatorOwnerBlock(profile,async(_,method)=>{
   assert.equal(method,"status");
   return {...status,...selection};
  });
 }
 assert.equal(await investigatorOwnerBlock(profile,async(_,method)=>{
  if(method==="status")return status;
  throw Error("Synthetic unknown");
 }),"OWNER_OUTCOME_UNKNOWN");
 assert.equal(await investigatorOwnerBlock(profile,async(_,method)=>method==="status"?status:{...status,accountId:"other"}),
  "OWNER_OUTCOME_UNKNOWN");
});
