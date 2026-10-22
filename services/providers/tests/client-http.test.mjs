// ABOUTME: Принимает публичный NATS client и HTTP fetch на actual PG/NATS и controlled HTTP upstream.
// ABOUTME: Проверяет эквивалентность tools, owner auth и recovery без повторного compute; платных вызовов нет.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {connect} from 'nats';
import {postgresStore} from '../dist/postgres.js';
import {createOperations} from '../dist/operations.js';
import {registerProvidersV1} from '../dist/nats-v1.js';
import {createProvidersClient,Failure} from '../dist/index.js';
import {createChatHttp} from '../dist/chat-http.js';
import {createChatAssembler,consumeSse,CHAT_MODEL} from '../dist/chat.js';
const pg=process.env.PROVIDERS_TEST_PG_URL,nats=process.env.PROVIDERS_TEST_NATS_URL;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const listen=async s=>{await new Promise(r=>s.listen(0,'127.0.0.1',r));return 'http://127.0.0.1:'+s.address().port;};
const close=s=>new Promise(r=>{s.close(r);s.closeAllConnections();});
const tool=name=>({type:'function',function:{name,parameters:{type:'object',properties:{value:{type:'integer'}},required:['value'],additionalProperties:false}}});
const tools=[tool('first'),tool('second')];
const calls=[{index:0,id:'tool_a',type:'function',function:{name:'first',arguments:'{"value":1}'},provider_signature:'opaque-fixture-a'},{index:1,id:'tool_b',type:'function',function:{name:'second',arguments:'{"value":2}'},provider_signature:'opaque-fixture-b'}];
test('actual NATS + PG + HTTP: one lifecycle, fetch JSON/SSE/tools/continuation, auth, gap/disconnect, malformed upstream',{skip:!pg||!nats},async t=>{
 assert.equal(new URL(pg).pathname,'/providers_v1_test');
 const store=postgresStore(pg);await store.migrate();await store.exclusive(()=>{});t.after(()=>store.close());
 const serviceNc=await connect({servers:nats,reconnect:false});t.after(()=>serviceNc.close());
 let nc=await connect({servers:nats,reconnect:false});t.after(()=>nc.close());
 let compute=0,rawMessages=[],mode='tools',dropped=0;const holds=[];
 const upstream=createServer(async(req,res)=>{
  compute++;let body='';for await(const part of req)body+=part;
  const input=JSON.parse(body);rawMessages.push(input.messages);
  res.writeHead(200,{'content-type':'text/event-stream'});
  const part=(delta,finish_reason=null)=>res.write('data: '+JSON.stringify({model:CHAT_MODEL,choices:[{index:0,delta,finish_reason}]})+'\n\n');
  if(mode==='malformed'){res.end('data: {broken\n\n');return;}
  part({role:'assistant',content:'prelude'});
  if(mode==='hold')await new Promise(resolve=>holds.push(resolve));
  if(input.messages.some(m=>m.role==='tool')){const assistant=input.messages.find(m=>m.role==='assistant');assert.equal(assistant.tool_calls[0].provider_signature,'opaque-fixture-a');assert.deepEqual(input.messages.filter(m=>m.role==='tool').map(m=>m.tool_call_id),['tool_a','tool_b']);part({content:' done'});part({},'stop');}
  else{part({tool_calls:calls,provider_state:'opaque-turn-fixture'});part({},'tool_calls');}
  res.end('data: '+JSON.stringify({model:CHAT_MODEL,choices:[],usage:{prompt_tokens:4,completion_tokens:3}})+'\n\ndata: [DONE]\n\n');
 });const upstreamURL=await listen(upstream);t.after(()=>close(upstream));
 const ops=createOperations(store,async()=>{throw Error('no decide');},{chatPort:async(r,m,signal,emit)=>{
   assert.equal((await store.find(r.ownerId,r.operationId,Date.now())).phase,'dispatching');
   const response=await fetch(upstreamURL,{method:'POST',body:JSON.stringify({messages:m}),signal});const assembler=createChatAssembler(r,emit);await consumeSse(response.body,assembler.push);return assembler.finish();
 }});
 let drop=false;
 const transport=new Proxy(serviceNc,{get(target,key){if(key==='publish')return(subject,data,options)=>{const e=JSON.parse(new TextDecoder().decode(data));if(drop&&e.sequence===2){dropped++;return;}return target.publish(subject,data,options);};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
 const service=await registerProvidersV1(transport,ops);t.after(()=>service.stop());
 const ownerId='client-http-fixture-'+randomUUID(),connectionId='fixture_'+randomUUID().replaceAll('-','');
 const bearer='synthetic-only-'+randomUUID(),otherBearer='synthetic-other-'+randomUUID();
 const server=createChatHttp(ops,[{token:bearer,ownerId,connectionId},{token:otherBearer,ownerId:ownerId+'-other',connectionId:'other'}]);const url=await listen(server);t.after(()=>close(server));
 const client=()=>createProvidersClient(nc,{ownerId,connectionId});
 const request=()=>({operationId:randomUUID(),provider:'openrouter',model:CHAT_MODEL,deadlineAt:new Date(Date.now()+90000).toISOString(),messages:[{role:'user',content:'synthetic only'}],tools,maxTokens:64,toolChoice:'auto'});
 const post=(r,extra={},token=bearer,headers={})=>fetch(url+'/v1/chat/completions',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json','x-request-id':r.operationId,'x-brai-deadline-at':r.deadlineAt,...headers},body:JSON.stringify({model:r.model,messages:r.messages,tools:r.tools,max_tokens:r.maxTokens,tool_choice:r.toolChoice,...extra})});
 const get=(id,token=bearer,headers={})=>fetch(url+'/v1/operations/'+id,{headers:{authorization:'Bearer '+token,...headers}});
 let first,viaHttp;
 await t.test('public exports, live NATS subscribe-before-invoke and equivalent HTTP JSON tools',async()=>{
  const r=request(),events=[];first=await client().chat(r,event=>events.push(event));assert.equal(first.phase,'succeeded');assert.equal(events[0].type,'started');assert.equal(events.filter(e=>e.type==='tool_call.ready').length,2);assert.equal(first.result.toolCalls.length,2);assert.equal(first.result.text,'prelude');
  const h=request(),response=await post(h);assert.equal(response.status,200);assert.equal(response.headers.get('x-request-id'),h.operationId);viaHttp=await response.json();assert.equal(viaHttp.id,h.operationId);assert.equal(viaHttp.choices[0].message.content,first.result.text);assert.deepEqual(viaHttp.choices[0].message.tool_calls,first.result.toolCalls.map(c=>({id:c.id,type:'function',function:{name:c.name,arguments:JSON.stringify(c.arguments)}})));assert.deepEqual(viaHttp.usage,{prompt_tokens:4,completion_tokens:3,total_tokens:7});
  const before=compute;assert.deepEqual(await (await post(h)).json(),viaHttp);assert.deepEqual(await (await get(h.operationId)).json(),viaHttp);assert.equal(compute,before);
  assert.equal((await post(h,{max_tokens:65})).status,409);assert.equal(compute,before);
 });
 await t.test('both callers continue exact tools and preserved provider state with new IDs',async()=>{
  const next={...request(),messages:[],continuation:{operationId:first.operationId},toolResults:[{id:'tool_a',content:'1'},{id:'tool_b',content:'2'}]};
  const result=await client().chat(next);assert.equal(result.result.text,'prelude done');
  const h=request(),response=await post(h,{stream:true,messages:[{role:'tool',tool_call_id:'tool_a',content:'1'},{role:'tool',tool_call_id:'tool_b',content:'2'}]},bearer,{'x-brai-continuation':viaHttp.id});
  assert.equal(response.status,200);const assembled=createChatAssembler({tools});await consumeSse(response.body,assembled.push);assert.equal(assembled.finish().text,result.result.text);assert.equal(rawMessages.at(-1).find(m=>m.role==='assistant').provider_state,'opaque-turn-fixture');
  const before=compute;
  for(const results of [[{id:'tool_a',content:'x'}],[{id:'tool_a',content:'x'},{id:'tool_a',content:'y'}],[{id:'tool_a',content:'x'},{id:'wrong',content:'y'}]]){
    await assert.rejects(client().chat({...next,operationId:randomUUID(),toolResults:results}),e=>e instanceof Failure&&e.code==='INVALID_CONTINUATION');
    const invalid=await post(request(),{messages:results.map(x=>({role:'tool',tool_call_id:x.id,content:x.content}))},bearer,{'x-brai-continuation':viaHttp.id});assert.equal(invalid.status,400);
  }
  assert.equal(compute,before);
 });
 await t.test('HTTP SSE has live text, complete tool IDs, finish, usage, DONE and durable replay',async()=>{
  const r=request(),response=await post(r,{stream:true,stream_options:{include_usage:true}});assert.match(response.headers.get('content-type'),/event-stream/);let chunks=[];await consumeSse(response.body,c=>chunks.push(c));
  assert.equal(chunks[0].choices[0].delta.content,'prelude');const assembler=createChatAssembler({tools});for(const c of chunks)assembler.push(c);const result=assembler.finish();assert.equal(result.toolCalls.length,2);assert.equal(result.finishReason,'tool_calls');assert.equal(chunks.at(-2).brai.continuation.operationId,r.operationId);
  const before=compute;const replay=await post(r,{stream:true});await consumeSse(replay.body,()=>{});assert.equal(compute,before);
 });
 await t.test('auth, forged owner, unknown params, malformed JSON and cross-owner continuation reject before compute',async()=>{
  const before=compute;
  assert.equal((await post(request(),{},'bad',{'x-owner-id':ownerId})).status,401);
  const hidden=await get(first.operationId,otherBearer,{'x-owner-id':ownerId});assert.equal(hidden.status,404);
  const wrong=await post(request(),{messages:[{role:'tool',tool_call_id:'tool_a',content:'1'},{role:'tool',tool_call_id:'tool_b',content:'2'}]},otherBearer,{'x-brai-continuation':first.operationId,'x-owner-id':ownerId});assert.equal(wrong.status,400);
  for(const body of [{temperature:0},{ownerId},{response_format:{}},{stream_options:{include_usage:false}},{n:2},{messages:[{role:'assistant',content:'fake'}]}])assert.equal((await post(request(),body)).status,400);
  const malformed=await fetch(url+'/v1/chat/completions',{method:'POST',headers:{authorization:'Bearer '+bearer,'content-type':'application/json','x-request-id':randomUUID(),'x-brai-deadline-at':new Date().toISOString()},body:'{broken'});assert.equal(malformed.status,400);
  assert.equal(compute,before);
 });
 await t.test('lost invoke response uses get once; another NATS owner cannot get the result',async()=>{
  const before=compute,r=request();let lost=true,gets=0;
  const connection=new Proxy(nc,{get(target,key){if(key==='request')return async(subject,...args)=>{if(subject.endsWith('operations.get'))gets++;const reply=await target.request(subject,...args);if(lost&&subject.endsWith('invoke.chat')){lost=false;throw Error('controlled lost invoke response');}return reply;};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
  const recovering=createProvidersClient(connection,{ownerId,connectionId});assert.equal((await recovering.chat(r)).phase,'succeeded');assert.ok(gets>=1);assert.equal(compute,before+1);
  const other=createProvidersClient(nc,{ownerId:ownerId+'-other',connectionId:'other'});await assert.rejects(other.get(first.operationId),e=>e.code==='NOT_FOUND');
 });
 await t.test('actual NATS sequence gap disables live delivery and gets the complete result once',async()=>{
  drop=true;const events=[],before=compute;const result=await client().chat(request(),e=>events.push(e));drop=false;assert.equal(dropped,1);assert.equal(events.length,1);assert.equal(result.result.toolCalls.length,2);assert.equal(compute,before+1);
 });
 await t.test('actual NATS connection loss recovers via new connection get, no model resend',async()=>{
  mode='hold';const r=request(),before=compute;let entered;const seen=new Promise(resolve=>entered=resolve);const work=client().chat(r,e=>{if(e.type==='text.delta')entered();});
  await seen;await nc.close();holds.shift()();await assert.rejects(work,e=>e.code==='TRANSPORT_UNAVAILABLE');await ops.idle();nc=await connect({servers:nats,reconnect:false});assert.equal((await client().get(r.operationId)).phase,'succeeded');assert.equal(compute,before+1);mode='tools';
 });
 await t.test('HTTP caller disconnect leaves durable operation, GET reads success without resend',async()=>{
  mode='hold';const r=request(),before=compute,controller=new AbortController();
  const response=await fetch(url+'/v1/chat/completions',{method:'POST',signal:controller.signal,headers:{authorization:'Bearer '+bearer,'content-type':'application/json','x-request-id':r.operationId,'x-brai-deadline-at':r.deadlineAt},body:JSON.stringify({model:r.model,messages:r.messages,tools,max_tokens:64,stream:true})});const reader=response.body.getReader();await reader.read();controller.abort();holds.shift()();await ops.idle();await delay(120);assert.equal((await (await get(r.operationId)).json()).choices[0].message.content,'prelude');assert.equal(compute,before+1);mode='tools';
 });
 await t.test('malformed upstream SSE is unknown; no DONE, GET/replay preserve failure and no retry',async()=>{
  mode='malformed';const before=compute,r=request(),response=await post(r,{stream:true});const body=await response.text();assert.match(body,/UPSTREAM_PROTOCOL/);assert.ok(!body.includes('[DONE]'));const result=await (await get(r.operationId)).json();assert.equal(result.phase,'outcome_unknown');assert.equal(result.errorCode,'UPSTREAM_PROTOCOL');assert.equal((await post(r)).status,503);assert.equal(compute,before+1);
 });
 assert.ok(compute>0);await ops.idle();
 console.log(JSON.stringify({acceptance:'task6',node:process.version,undici:process.versions.undici,actual:['NATS','PostgreSQL','HTTP fetch'],upstream:'controlled synthetic',compute,paidCalls:0}));
});
