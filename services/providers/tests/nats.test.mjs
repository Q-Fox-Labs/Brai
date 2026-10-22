// ABOUTME: Проверяет реальный NATS Services wire без внешних модельных API.
// ABOUTME: Использует только отдельный NATS fixture, не действующие consumers.
import test from "node:test";
import assert from "node:assert/strict";
import { connect } from "nats";
import { randomUUID } from "node:crypto";
import { registerProviders, SUBJECT } from "../dist/nats.js";
import { MODEL } from "../dist/core.js";
test("NATS Services identity, DTO, safe errors and counters",{skip:!process.env.PROVIDERS_TEST_NATS_URL},async t=>{
  const nc=await connect({servers:process.env.PROVIDERS_TEST_NATS_URL,reconnect:false});t.after(()=>nc.close());
  let attempts=0;const service=await registerProviders(nc,async()=>{attempts++;return {model:MODEL,answers:{check:{type:"noul",noul:0.5}},usage:{input_tokens:10,output_tokens:2}};});t.after(()=>service.stop());
  const input={requestId:randomUUID(),ownerId:"fixture",provider:"typesafe",model:MODEL,state:"synthetic",questions:{check:{type:"noul",instructions:"synthetic"}},deadlineAt:new Date(Date.now()+30000).toISOString()};
  const ping=await nc.request("$SRV.PING.brai_providers","",{timeout:2000});assert.equal(ping.json().name,"brai_providers");assert.ok(ping.json().id);
  const info=(await nc.request("$SRV.INFO.brai_providers","",{timeout:2000})).json();assert.equal(info.endpoints[0].subject,SUBJECT);
  const msg=await nc.request(SUBJECT,JSON.stringify(input),{timeout:2000});assert.equal(msg.json().requestId,input.requestId);assert.equal(attempts,1);
  for(const payload of ["{",JSON.stringify({...input,unknown:true}),"x".repeat(32769)]) {
    const error=await nc.request(SUBJECT,payload,{timeout:2000});assert.equal(error.headers.get("Nats-Service-Error"),"INVALID_REQUEST");assert.equal(error.headers.get("Nats-Service-Error-Code"),"500");assert.equal(error.json().outcome,"not_sent");
  }
  assert.equal(attempts,1);const stats=(await nc.request("$SRV.STATS.brai_providers","",{timeout:2000})).json();assert.equal(stats.endpoints[0].num_requests,4);
});
