// ABOUTME: Проверяет одноразовый внешний dispatch при повторе внутреннего LiteLLM POST.
// ABOUTME: Использует управляемые HTTP-соседи, секреты и реальные модели не вызываются.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { createEgressGuard } from "../dist/egress.js";
import { liteLLMPort } from "../dist/http.js";
import { MODEL, createDecider } from "../dist/core.js";
const request=()=>({requestId:randomUUID(),ownerId:"fixture",provider:"typesafe",model:MODEL,state:"synthetic",questions:{check:{type:"noul",instructions:"synthetic"}},deadlineAt:new Date(Date.now()+30000).toISOString()});
async function server(t,handler){const s=createServer(handler);s.listen(0,"127.0.0.1");await once(s,"listening");t.after(()=>new Promise(resolve=>{s.closeAllConnections();s.close(resolve);}));return `http://127.0.0.1:${s.address().port}`;}
const call=(url,input)=>fetch(url+"/v1/systemone",{method:"POST",headers:{"content-type":"application/json",authorization:"Bearer TEST_ONLY"},body:JSON.stringify({model:input.model,state:input.state,questions:input.questions})});
test("claim precedes upstream; drop after body, replay/late/unknown denied",async t=>{
 let attempts=0;const up=await server(t,async(req,res)=>{for await(const _ of req){}attempts++;res.destroy();});
 const guard=await createEgressGuard({host:"127.0.0.1",port:0,upstream:up+"/v1/systemone"});t.after(()=>guard.close());
 const input=request(),dispatch=guard.allocate(input,new AbortController().signal);
 const [first,replay]=await Promise.all([call(dispatch.apiBase,input),call(dispatch.apiBase,input)]);
 assert.deepEqual([first.status,replay.status].sort(),[409,502]);assert.equal(attempts,1);
 assert.equal((await call(dispatch.apiBase,input)).status,409);assert.equal(attempts,1);
 await dispatch.release();assert.equal((await call(dispatch.apiBase,input)).status,409);assert.equal(attempts,1);
});
test("proxy-normalized missing usage restored to null; raw counts preserved",async t=>{
 for(const usage of [undefined,{input_tokens:11,output_tokens:0}]){
  let attempts=0;const up=await server(t,(_req,res)=>{attempts++;res.end(JSON.stringify({model:MODEL,answers:{check:{type:"noul",noul:0.5}},...(usage?{usage}:{})}));});
  const guard=await createEgressGuard({host:"127.0.0.1",port:0,upstream:up+"/v1/systemone"});t.after(()=>guard.close());
  const proxy=await server(t,async(req,res)=>{let bytes="";for await(const chunk of req)bytes+=chunk;const data=JSON.parse(bytes);const response=await call(data.api_base,data);const body=await response.json();body.usage??={input_tokens:0,output_tokens:0};res.end(JSON.stringify(body));});
  const answer=await createDecider(liteLLMPort(proxy,guard))(request());assert.deepEqual(answer.usage,usage?{inputTokens:11,outputTokens:0}:null);assert.equal(attempts,1);
 }
});
test("nonce capacity bounded; distinct repeated requestId does not deduplicate",async t=>{
 const up=await server(t,(_req,res)=>res.end("{}"));const guard=await createEgressGuard({host:"127.0.0.1",port:0,upstream:up+"/v1/systemone"});t.after(()=>guard.close());
 const input=request(),signal=new AbortController().signal,a=guard.allocate(input,signal),b=guard.allocate(input,signal);assert.notEqual(a.apiBase,b.apiBase);assert.throws(()=>guard.allocate(input,signal),e=>e.code==="OVERLOADED");await a.release();await b.release();
});
test("v1 structured state and choice/score metadata cross HTTP proxy/egress intact",async t=>{
 const {liteLLMDecidePort}=await import('../dist/http.js');const {createOperations}=await import('../dist/operations.js');
 const input={operationId:randomUUID(),ownerId:'fixture',provider:'typesafe',model:MODEL,state:[{event:'synthetic'}],questions:{department:{type:'choice',instructions:'synthetic',criteria:{a:'x',b:null}},level:{type:'score',instructions:'synthetic',criteria:['low','high']}},deadlineAt:new Date(Date.now()+30000).toISOString()};
 const value={model:MODEL,answers:{department:{type:'choice',choice:'a',probabilities:{a:.9,b:.1},confidence:.8},level:{type:'score',score:.1,probabilities:{0:.9,1:.1},legend:{0:'low',1:'high'},confidence:.8}}};
 let calls=0;const up=await server(t,async(req,res)=>{let bytes='';for await(const chunk of req)bytes+=chunk;assert.deepEqual(JSON.parse(bytes),{model:input.model,state:input.state,questions:input.questions});calls++;res.end(JSON.stringify(value));});
 const guard=await createEgressGuard({host:'127.0.0.1',port:0,upstream:up+'/v1/systemone'});t.after(()=>guard.close());
 const proxy=await server(t,async(req,res)=>{let bytes='';for await(const chunk of req)bytes+=chunk;const data=JSON.parse(bytes);assert.equal(data.num_retries,0);const response=await call(data.api_base,data);res.end(await response.text());});
 const actual=await liteLLMDecidePort(proxy,guard)(input,new AbortController().signal);assert.deepEqual(actual.answers,value.answers);assert.equal(actual.usage,null);assert.equal(calls,1);
});
test('v1 rejects metadata loss in normalized proxy response without fallback',async t=>{
 const {liteLLMDecidePort}=await import('../dist/http.js');let calls=0;
 const input={...request(),operationId:randomUUID()};delete input.requestId;
 input.questions={check:{type:'choice',instructions:'synthetic',criteria:{a:null,b:null}}};
 const raw={model:MODEL,answers:{check:{type:'choice',choice:'a',probabilities:{a:.9,b:.1},confidence:.8}}};
 const up=await server(t,(_req,res)=>{calls++;res.end(JSON.stringify(raw));});const guard=await createEgressGuard({host:'127.0.0.1',port:0,upstream:up+'/v1/systemone'});t.after(()=>guard.close());
 const proxy=await server(t,async(req,res)=>{let bytes='';for await(const chunk of req)bytes+=chunk;const data=JSON.parse(bytes);const response=await call(data.api_base,data);const modified=await response.json();modified.answers.check.confidence=.7;res.end(JSON.stringify(modified));});
 await assert.rejects(liteLLMDecidePort(proxy,guard)(input,new AbortController().signal),e=>e.code==='UPSTREAM_PROTOCOL');assert.equal(calls,1);
});
