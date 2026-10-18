// ABOUTME: Проверяет ограниченный поток, caller tools и durable continuation providers.
// ABOUTME: Только synthetic HTTP/model ports; платные API и секреты не используются.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {CHAT_MODEL,CHAT_LIMITS,chatWire,createChatAssembler,createSseParser,chatMessages} from '../dist/chat.js';
import {createOperations,V1_LIMITS,canonical} from '../dist/operations.js';
import {createStreamPublisher} from '../dist/nats-v1.js';
import {createEgressGuard} from '../dist/egress.js';
import {liteLLMChatPort} from '../dist/http.js';
import {v1Validator} from '../dist/v1-schema.js';
const tool=name=>({type:'function',function:{name,parameters:{type:'object',properties:{value:{type:'integer'}},required:['value'],additionalProperties:false}}});
const tools=[tool('first'),tool('second')];
const input=()=>({operationId:randomUUID(),ownerId:'fixture',connectionId:'fixture',provider:'openrouter',model:CHAT_MODEL,deadlineAt:new Date(Date.now()+90000).toISOString(),streamInbox:'_INBOX.fixture.'+randomUUID(),messages:[{role:'user',content:'synthetic'}],tools,maxTokens:64,toolChoice:'auto'});
const chunk=(delta={},finish_reason=null,usage)=>({id:'synthetic',created:1,object:'chat.completion.chunk',model:CHAT_MODEL,choices:[{index:0,delta,finish_reason}],...(usage?{usage}:{})});
const fragments=()=>[
 chunk({role:'assistant',content:'✓',provider_opaque:{signature:'exact-synthetic'}}),
 chunk({tool_calls:[{index:0,id:'id-one',type:'function',function:{name:'first',arguments:'{"val'}},{index:1,id:'id-two',type:'function',function:{name:'second',arguments:'{"value":'}}]}),
 chunk({tool_calls:[{index:1,function:{arguments:'2}'}},{index:0,function:{arguments:'ue":1}'}}]}),
 chunk({},'tool_calls'),{...chunk(),choices:[],usage:{prompt_tokens:11,completion_tokens:7}}
];
const encode=chunks=>Buffer.from(chunks.map(c=>'data: '+JSON.stringify(c)+'\r\n\r\n').join('')+'data: [DONE]\r\n\r\n');
function completion(request=input(),parts=fragments(),emit){const a=createChatAssembler(request,emit);parts.forEach(a.push);return a.finish();}
function memory(){const rows=new Map(),key=(o,id)=>JSON.stringify([o,id]),copy=r=>r?structuredClone(r):null;return {rows,
 async find(o,id,now){const r=rows.get(key(o,id));return r&&r.keyExpiresAt>now?copy(r):null;},
 async accept(op){const old=rows.get(key(op.ownerId,op.operationId));if(old)return {operation:copy(old),inserted:false};rows.set(key(op.ownerId,op.operationId),copy(op));return {operation:copy(op),inserted:true};},
 async claim(o,id,hash){const r=rows.get(key(o,id));if(r?.phase!=='accepted'||r.cancelRequested||r.inputHash!==hash)return false;r.phase='dispatching';return true;},
 async finish(o,id,phase,result,errorCode,now,hash){const r=rows.get(key(o,id));if(r?.inputHash===hash&&['accepted','dispatching'].includes(r.phase))Object.assign(r,{phase,result,errorCode,finishedAt:now,resultExpiresAt:now+V1_LIMITS.resultTtlMs});},
 async cancel(o,id,now){const r=rows.get(key(o,id));if(!r)return null;r.cancelRequested=true;if(r.phase==='accepted')Object.assign(r,{phase:'cancelled',finishedAt:now,resultExpiresAt:now+V1_LIMITS.resultTtlMs});return copy(r);},
 async recover(now){for(const r of rows.values())if(['accepted','dispatching'].includes(r.phase))Object.assign(r,{phase:r.phase==='accepted'?'cancelled':'outcome_unknown',result:null,finishedAt:now,resultExpiresAt:now+V1_LIMITS.resultTtlMs});},async sweep(){}
};}
async function server(t,handler){const s=createServer(handler);s.listen(0,'127.0.0.1');await once(s,'listening');t.after(()=>new Promise(resolve=>{s.closeAllConnections();s.close(resolve);}));return `http://127.0.0.1:${s.address().port}`;}
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('SSE arbitrary byte boundaries, comments, empty choices, usage; interleaved tools become ready once complete',()=>{
 const events=[],assembler=createChatAssembler(input(),e=>events.push(e)),parser=createSseParser(assembler.push),data=Buffer.concat([Buffer.from(':keepalive\r\n\r\n'),encode(fragments())]);
 for(const byte of data)parser.push(Uint8Array.of(byte));parser.end();assert.equal(events.filter(e=>e.type==='tool_call.ready').length,0);
 const done=assembler.finish();assert.equal(done.text,'✓');assert.deepEqual(done.toolCalls.map(c=>[c.id,c.arguments.value]),[['id-one',1],['id-two',2]]);assert.deepEqual(done.usage,{inputTokens:11,outputTokens:7});assert.deepEqual(done.message.provider_opaque,{signature:'exact-synthetic'});assert.equal(events.filter(e=>e.type==='tool_call.ready').length,2);
});
test('malformed/incomplete JSON, wrong argument type, duplicate IDs/index gaps and non-tool finish never ready',()=>{
 for(const [args,finish,id,index]of [['{"value":', 'tool_calls','one',0],['{"value":"wrong"}','tool_calls','one',0],['{"value":1}','length','one',0],['{"value":1}','tool_calls','one',1]]){
  const events=[],a=createChatAssembler(input(),e=>events.push(e));a.push(chunk({tool_calls:[{index,id,type:'function',function:{name:'first',arguments:args}}]}));a.push(chunk({},finish));assert.throws(()=>a.finish(),e=>e.code==='UPSTREAM_PROTOCOL');assert.equal(events.filter(e=>e.type==='tool_call.ready').length,0);
 }
 const parts=fragments();parts[1].choices[0].delta.tool_calls[1].id='id-one';assert.throws(()=>completion(input(),parts),e=>e.code==='UPSTREAM_PROTOCOL');
 const a=createChatAssembler(input());a.push(chunk({content:'partial'}));assert.throws(()=>a.finish());
});
test('finite SSE frame/stream count/UTF8 and output/tool/state budgets reject before success',()=>{
 for(const source of [Buffer.from('data: '+ 'x'.repeat(CHAT_LIMITS.frameBytes)),Buffer.from('data: {}\n\n'),Buffer.from([0xff])]){const p=createSseParser(()=>{});assert.throws(()=>{p.push(source);p.end();});}
 const p=createSseParser(()=>{});assert.throws(()=>p.push(new Uint8Array(CHAT_LIMITS.streamBytes+1)));
 const count=createSseParser(()=>{});assert.throws(()=>count.push(Buffer.from(':\n\n'.repeat(CHAT_LIMITS.frames+1))));
 const a=createChatAssembler(input());assert.throws(()=>a.push(chunk({content:'x'.repeat(CHAT_LIMITS.textBytes+1)})));
 const b=createChatAssembler(input());assert.throws(()=>b.push(chunk({tool_calls:[{index:0,function:{arguments:'x'.repeat(CHAT_LIMITS.toolBytes+1)}}]})));
 const c=createChatAssembler(input());c.push(chunk({opaque:'one'}));assert.throws(()=>c.push(chunk({opaque:'different'})));
});
test('durable final, replay, two caller results and provider opaque message survive new lifecycle instance',async()=>{
 const store=memory();let calls=0;const seen=[],events=[];
 const port=async(r,m,_signal,emit)=>{calls++;seen.push(m);return completion(r,calls===1?fragments():[chunk({content:'finished'}),chunk({},'stop')],emit);};
 let ops=createOperations(store,async()=>{throw Error('no decide');},{chatPort:port});const first=input();await ops.invokeChat(first,e=>{events.push(e);return true;});await ops.idle();
 const done=await ops.get(first.ownerId,first.operationId);assert.equal(done.phase,'succeeded');assert.equal(v1Validator('operation')(done),true);assert.equal(calls,1);assert.equal(events.at(-1).type,'completed');assert.ok(events.every((e,i)=>v1Validator('streamEvent')(e)&&e.sequence===i+1));
 assert.equal((await ops.invokeChat({...first,streamInbox:'_INBOX.fixture.reconnected'})).phase,'succeeded');assert.equal(calls,1);
 ops=createOperations(store,async()=>{throw Error('no decide');},{chatPort:port});
 const second={...input(),messages:[],continuation:{operationId:first.operationId},toolResults:[{id:'id-two',content:'two'},{id:'id-one',content:'one'}]};
 for(const bad of [{...second,ownerId:'other'},{...second,connectionId:'other'},{...second,toolResults:[{id:'id-one',content:'one'}]},{...second,toolResults:[{id:'id-one',content:'one'},{id:'id-one',content:'duplicate'}]}])await assert.rejects(ops.invokeChat(bad),e=>e.code==='INVALID_CONTINUATION');
 await ops.invokeChat(second);await ops.idle();assert.equal(calls,2);assert.deepEqual(seen[1][1].provider_opaque,{signature:'exact-synthetic'});assert.deepEqual(seen[1].slice(-2).map(m=>m.tool_call_id),['id-two','id-one']);assert.equal((await ops.get(second.ownerId,second.operationId)).result.text,'finished');
 await assert.rejects(chatMessages(store,second,Date.now()+V1_LIMITS.resultTtlMs+1),e=>e.code==='INVALID_CONTINUATION');
});
test('bounded publisher overflow/slow consumer stops live delivery while durable get remains complete',async()=>{
 const published=[],pending=[];const sink=createStreamPublisher({publish:(_s,d)=>published.push(JSON.parse(new TextDecoder().decode(d))),flush:()=>new Promise(resolve=>pending.push(resolve)),isClosed:()=>false},'_INBOX.fixture.synthetic');
 const ops=createOperations(memory(),async()=>{}, {chatPort:async(r,_m,_s,emit)=>{
  const a=createChatAssembler(r,emit);for(let i=0;i<64;i++)a.push(chunk({content:'x'.repeat(64)}));a.push(chunk({},'stop'));return a.finish();
 }});const r=input();await ops.invokeChat(r,sink);await ops.idle();const done=await ops.get(r.ownerId,r.operationId);assert.equal(done.phase,'succeeded');assert.equal(done.result.text.length,4096);assert.equal(done.result.streamDelivery,'unconfirmed');
 // A deliberately unflushed transport with enough tiny packets exceeds envelope bytes, below result text budget.
 const slow=createStreamPublisher({publish:(_s,d)=>published.push(JSON.parse(new TextDecoder().decode(d))),flush:()=>new Promise(()=>{}),isClosed:()=>false},'_INBOX.fixture.synthetic');
 const slowOps=createOperations(memory(),async()=>{}, {chatPort:async(r,_m,_s,emit)=>{const a=createChatAssembler(r,emit);for(let i=0;i<512;i++)a.push(chunk({content:'x'}));a.push(chunk({},'stop'));return a.finish();}});const q=input();await slowOps.invokeChat(q,slow);await slowOps.idle();assert.equal((await slowOps.get(q.ownerId,q.operationId)).result.streamDelivery,'interrupted');assert.equal(published.at(-1).code,'STREAM_DELIVERY_INTERRUPTED');pending.forEach(f=>f());
});
test('shared capacity/cancel and crash dispatch never create a second chat attempt',async()=>{
 let calls=0;const releases=[],store=memory(),ops=createOperations(store,async()=>{calls++;return new Promise(resolve=>releases.push(()=>resolve({model:'jev-1.13.0',answers:{q:{type:'noul',noul:.5}}})));},{chatPort:async r=>{calls++;return new Promise(resolve=>releases.push(()=>resolve(completion(r))))}});
 const chat=input(),decide={operationId:randomUUID(),ownerId:'fixture',provider:'typesafe',model:'jev-1.13.0',state:'x',questions:{q:{type:'noul',instructions:'x'}},deadlineAt:new Date(Date.now()+30000).toISOString()};await ops.invokeChat(chat);await ops.invoke(decide);await tick();assert.equal(calls,2);await assert.rejects(ops.invokeChat(input()),e=>e.code==='OVERLOADED');assert.equal((await ops.cancel(chat.ownerId,chat.operationId)).billingMayContinue,true);releases.forEach(f=>f());await ops.idle();assert.equal((await ops.invokeChat(chat)).phase,'outcome_unknown');assert.equal(calls,2);
 const r=input(),fresh=createOperations(memory(),async()=>{},{chatPort:async()=>{throw Error('must not send');}});await fresh.invokeChat(r);assert.equal((await fresh.cancel(r.ownerId,r.operationId)).phase,'cancelled');await fresh.idle();
 const row=store.rows.values().next().value;row.phase='dispatching';row.result=null;await store.recover(Date.now());const restarted=createOperations(store,async()=>{},{chatPort:async()=>{calls++;}});assert.equal((await restarted.invokeChat(chat)).phase,'outcome_unknown');assert.equal(calls,2);
});
test('strict chat DTO rejects extras, unknown params, invalid tool schema and unsafe inbox before model',async()=>{
 const ops=createOperations(memory(),async()=>{}, {chatPort:async()=>{throw Error('must not send');}});
 for(const r of [{...input(),temperature:.4},{...input(),maxTokens:100000},{...input(),streamInbox:'public.broadcast'},{...input(),tools:[{...tools[0],function:{...tools[0].function,parameters:{$ref:'https://bad'}}}]},{...input(),messages:[]}])await assert.rejects(ops.invokeChat(r),e=>e.code==='INVALID_REQUEST');
});
test('raw egress streams once, verifies fixed body and preserves absent raw usage over Proxy zeros',async t=>{
 let upstreamCalls=0;const rawParts=fragments().slice(0,-1),up=await server(t,async(req,res)=>{let data='';for await(const c of req)data+=c;const wire=JSON.parse(data);assert.equal(wire.reasoning.enabled,false);assert.deepEqual(wire.provider.only,['deepinfra/fp4']);upstreamCalls++;res.setHeader('content-type','text/event-stream');res.end(encode(rawParts));});
 const guard=await createEgressGuard({host:'127.0.0.1',port:0,chatUpstream:up+'/api/v1/chat/completions'});t.after(()=>guard.close());
 const proxy=await server(t,async(req,res)=>{let data='';for await(const c of req)data+=c;const {api_base,num_retries,max_retries,...wire}=JSON.parse(data);assert.equal(num_retries,0);assert.equal(max_retries,0);const response=await fetch(api_base+'/chat/completions',{method:'POST',headers:{authorization:'Bearer TEST_ONLY'},body:JSON.stringify({...wire,usage:{include:true}})});const raw=await response.text();const body=raw.replace('data: [DONE]','data: '+JSON.stringify({...chunk(),choices:[],usage:{prompt_tokens:0,completion_tokens:0}})+'\n\ndata: [DONE]');res.setHeader('content-type','text/event-stream');res.end(body);});
 const r=input(),done=await liteLLMChatPort(proxy,guard)(r,r.messages,new AbortController().signal,()=>{});assert.equal(upstreamCalls,1);assert.equal(done.usage,null);assert.deepEqual(done.message.provider_opaque,{signature:'exact-synthetic'});
 const dispatch=guard.allocate(r,new AbortController().signal,r.messages),call=()=>fetch(dispatch.apiBase+'/chat/completions',{method:'POST',headers:{authorization:'Bearer TEST_ONLY'},body:JSON.stringify(chatWire(r,r.messages))});const [a,b]=await Promise.all([call(),call()]);assert.deepEqual([a.status,b.status].sort(),[200,409]);await a.arrayBuffer();await b.arrayBuffer();assert.equal(upstreamCalls,2);await dispatch.release();assert.equal((await call()).status,409);
});
test('accepted upstream body then disconnect remains unknown and nonce replay cannot repeat compute',async t=>{
 let calls=0;const up=await server(t,async(req,res)=>{for await(const _ of req){}calls++;res.setHeader('content-type','text/event-stream');res.write('data: '+JSON.stringify(chunk({content:'partial'}))+'\n\n');setImmediate(()=>res.destroy());});
 const guard=await createEgressGuard({host:'127.0.0.1',port:0,chatUpstream:up+'/api/v1/chat/completions'});t.after(()=>guard.close());const r=input(),dispatch=guard.allocate(r,new AbortController().signal,r.messages);
 const call=()=>fetch(dispatch.apiBase+'/chat/completions',{method:'POST',headers:{authorization:'Bearer TEST_ONLY'},body:JSON.stringify(chatWire(r,r.messages))});await assert.rejects(async()=>{const res=await call();await res.text();});assert.equal((await call()).status,409);assert.equal(calls,1);await dispatch.release();
});

test('chat deadline abort is unknown once, and event count overflow preserves bounded final get',async()=>{
 let calls=0;const ops=createOperations(memory(),async()=>{}, {chatDeadlineMs:5,chatPort:async(_r,_m,signal)=>{calls++;await new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('deadline')),{once:true}));}});const r=input();await ops.invokeChat(r);await ops.idle();assert.equal((await ops.invokeChat(r)).phase,'outcome_unknown');assert.equal(calls,1);
 const events=[],bounded=createOperations(memory(),async()=>{}, {chatPort:async(r,_m,_s,emit)=>{for(let i=0;i<CHAT_LIMITS.events+10;i++)emit({type:'text.delta',text:'x'});return completion(r);}});const q=input();await bounded.invokeChat(q,e=>{events.push(e);return true;});await bounded.idle();assert.equal(events.length,CHAT_LIMITS.events);assert.equal(events.at(-1).code,'STREAM_DELIVERY_INTERRUPTED');assert.equal((await bounded.get(q.ownerId,q.operationId)).result.streamDelivery,'interrupted');
});

test('OpenRouter documented accounting frame repeats empty assistant finish; content/changed finish after terminal rejected',()=>{
 const usage={prompt_tokens:11,completion_tokens:7},accounting=chunk({role:'assistant',content:''},'tool_calls',usage);
 assert.equal(completion(input(),[...fragments().slice(0,-1),chunk({role:'assistant',content:''}),chunk({},null,usage)]).toolCalls.length,2);
 const events=[],done=completion(input(),[...fragments().slice(0,-1),accounting],e=>events.push(e));assert.equal(done.toolCalls.length,2);assert.deepEqual(done.usage,{inputTokens:11,outputTokens:7});assert.equal(events.filter(e=>e.type==='tool_call.ready').length,2);
 for(const invalid of [chunk({content:'late'},'tool_calls',usage),chunk({role:'assistant',content:''},'stop',usage),chunk({role:'assistant',content:''},'tool_calls'),chunk({tool_calls:[{index:0,function:{arguments:'late'}}]},'tool_calls',usage)])assert.throws(()=>completion(input(),[...fragments().slice(0,-1),invalid]),e=>e.code==='UPSTREAM_PROTOCOL');
});
