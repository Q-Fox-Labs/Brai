// ABOUTME: Проверяет ограничения v0 и одну отправку через управляемый HTTP upstream.
// ABOUTME: Не использует секреты или платные API; NATS проверяется отдельным fixture.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { MODEL, createDecider, Failure } from "../dist/core.js";
import { liteLLMPort } from "../dist/http.js";
import { validRequest, validResponse } from "../dist/schema.js";
const request = () => ({requestId:randomUUID(),ownerId:"acceptance",provider:"typesafe",model:MODEL,state:"synthetic",questions:{decision:{type:"noul",instructions:"synthetic"}},deadlineAt:new Date(Date.now()+10000).toISOString()});
const result = () => ({model:MODEL,answers:{decision:{type:"noul",noul:0.3141592653589793}},usage:{input_tokens:12,output_tokens:3}});
async function upstream(t, handler) {
  let calls=0;
  const server=createServer((req,res)=>{calls++; handler(req,res);});
  server.listen(0,"127.0.0.1"); await once(server,"listening");
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  return {port:liteLLMPort(`http://127.0.0.1:${server.address().port}`), calls:()=>calls};
}
test("closed request, exactly one noul and finite input",()=>{
  assert.equal(validRequest(request()),true);
  for(const input of [{...request(),api_key:"secret"},{...request(),model:"jev-latest"},{...request(),state:""},{...request(),deadlineAt:"2026-02-30T12:00:00Z"},{...request(),state:"x".repeat(16385)},{...request(),questions:{a:{type:"noul",instructions:"x",criteria:{}}}},{...request(),questions:{a:{type:"noul",instructions:"x"},b:{type:"noul",instructions:"y"}}}]) assert.equal(validRequest(input),false);
});
test("one POST, exact wire and precision; nullable usage",async t=>{
  const fixture=await upstream(t,async (req,res)=>{
    assert.equal(req.url,"/v1/systemone"); assert.equal(req.method,"POST");
    let body=""; for await(const chunk of req) body+=chunk;
    const data=JSON.parse(body); assert.deepEqual(Object.keys(data).sort(),["model","num_retries","questions","state"]); assert.equal(data.num_retries,0);
    res.end(JSON.stringify(result()));
  });
  const input=request();const answer=await createDecider(fixture.port)(input);
  assert.equal(answer.requestId,input.requestId);assert.equal(answer.actualModel,MODEL);assert.equal(validResponse(answer),true);
  assert.equal(answer.answers.decision.noul,0.3141592653589793);assert.deepEqual(answer.usage,{inputTokens:12,outputTokens:3});assert.equal(fixture.calls(),1);
  const noUsage=result();delete noUsage.usage;assert.equal((await createDecider(async()=>noUsage)(request())).usage,null);
});
for(const [status,code,outcome] of [[401,"UPSTREAM_ACCESS","failed"],[429,"UPSTREAM_RATE_LIMIT","failed"],[500,"UPSTREAM_FAILURE","unknown"],[503,"UPSTREAM_FAILURE","unknown"]]) test(`HTTP ${status}: safe error, one attempt`,async t=>{
  const fixture=await upstream(t,(_req,res)=>{res.writeHead(status);res.end("PRIVATE_UPSTREAM_TEXT");});
  await assert.rejects(createDecider(fixture.port)(request()),e=>e instanceof Failure && e.code===code && e.outcome===outcome && !JSON.stringify(e).includes("PRIVATE"));
  assert.equal(fixture.calls(),1);
});
for(const [name,payload] of [["malformed","{"],["bad probability",JSON.stringify({...result(),answers:{decision:{type:"noul",noul:1.01}}})],["wrong answer key",JSON.stringify({...result(),answers:{other:{type:"noul",noul:0.5}}})],["wrong model",JSON.stringify({...result(),model:"jev-latest"})],["oversized","x".repeat(16385)]]) test(`${name}: safe protocol error and one attempt`,async t=>{
  const fixture=await upstream(t,(_req,res)=>res.end(payload));
  await assert.rejects(createDecider(fixture.port)(request()),e=>e instanceof Failure && e.outcome==="unknown");assert.equal(fixture.calls(),1);
});
test("connection lost after body: unknown, no retry",async t=>{
  const fixture=await upstream(t,async(req,res)=>{for await(const _chunk of req) {} res.destroy();});
  await assert.rejects(createDecider(fixture.port)(request()),e=>e.code==="OUTCOME_UNKNOWN");assert.equal(fixture.calls(),1);
});
test("deadline aborts slow response and does not retry",async t=>{
  const fixture=await upstream(t,(_req,res)=>{res.writeHead(200);res.flushHeaders();});
  const input=request();input.deadlineAt=new Date(Date.now()+100).toISOString();
  await assert.rejects(createDecider(fixture.port)(input),e=>e.code==="OUTCOME_UNKNOWN");assert.equal(fixture.calls(),1);
});
test("reject expired, capacity 2, retain slot until port settles",async()=>{
  let calls=0;const releases=[];const decider=createDecider(()=>{calls++;return new Promise(resolve=>releases.push(()=>resolve(result())));});
  await assert.rejects(decider({...request(),deadlineAt:new Date(0).toISOString()}),e=>e.code==="DEADLINE_EXCEEDED");
  const first=decider(request()),second=decider(request());await assert.rejects(decider(request()),e=>e.code==="OVERLOADED" && e.outcome==="not_sent");assert.equal(calls,2);
  releases.forEach(release=>release());await Promise.all([first,second]);
});
