// ABOUTME: Проверяет owner-схемы, границы доверенного API и NATS сообщения.
// ABOUTME: Не подменяет интеграционную проверку PostgreSQL и настоящего Git.
import test from 'node:test';
import assert from 'node:assert/strict';
import { canonical,validate,expanded,methods } from '../src/contracts.mjs';
import { createHandlers } from '../src/domain.mjs';
import { runNats } from '../src/nats.mjs';
const id='0997203d-1266-4cf7-9668-d985b3eec801';
test('same semantics gives same canonical intent; unknown fields/identity rejected',()=>{
  assert.equal(canonical({b:1,a:{d:2,c:3}}),canonical({a:{c:3,d:2},b:1}));
  validate('prepare-write',{project_id:'p',idempotency_key:'a',workspace_key:'area',kind:'feature',session_id:'s',attempt_id:id});
  assert.throws(()=>validate('prepare-write',{project_id:'p',idempotency_key:'a',workspace_key:'area',kind:'feature',session_id:'s',executor_id:'admin'}));
  assert.throws(()=>validate('prepare-write',{project_id:'p',idempotency_key:'a',workspace_key:'area',kind:'feature',session_id:'s',element_id:'task-title'}));
  for(const method of methods)assert.equal(expanded(method).additionalProperties,false);
});
test('project registration cannot be requested by a non-admin transport identity',async()=>{
  const h=createHandlers({}, {validateProject:()=>assert.fail('must not execute')});
  await assert.rejects(h.call('project.get',{project_id:'p'},'forged id'),{code:'FORBIDDEN'});
});
test('NATS identity comes from endpoint, error headers and schema responses are real',async()=>{
  const endpoints=new Map();
  const service={addEndpoint:(name,options)=>endpoints.set(options.subject,options),stop:async()=>{}};
  const nc={services:{add:async config=>{assert.equal(config.name,'service_codeworks');return service;}}};
  const calls=[];
  await runNats(nc,{call:async(method,args,executor)=>{calls.push({method,args,executor});return {operation_id:id,workspace_id:id};}},['codex']);
  const ep=endpoints.get('brai.codeworks.v1.codex.prepare-write');
  let result;
  await ep.handler(null,{data:Buffer.from('{"executor_id":"hermes"}'),respond:value=>result=JSON.parse(value)});
  assert.equal(calls[0].executor,'codex');
  assert.equal(result.operation_id,id);
  await ep.handler(null,{data:Buffer.from('{'),respondError:(status,code,data)=>{assert.equal(status,400);assert.equal(code,'INVALID_ARGUMENT');assert.equal(JSON.parse(data).code,code);}});
  assert.equal(endpoints.size,methods.length);
});

test('pure core enforces explicit quiesce, process guard and epoch before changing writer',async()=>{
  let w={id,project_id:'p',preparation_state:'ready',writer:{executor_id:'codex',session_id:'s1',epoch:1,state:'active'}};
  const operations=[],attachments=[];
  const session={project:async()=>({repo_path:'/test/repo',executors:['codex','hermes']}),request:async()=>undefined,workspace:async()=>structuredClone(w),updateWriter:async next=>{w=structuredClone(next);},insertOperation:async op=>operations.push(op),insertRequest:async()=>{},attach:async a=>attachments.push(a)};
  const store={read:async(_,fn)=>fn(session),transaction:async(_,fn)=>fn(session)};
  let running=true,guardCalls=0;
  const h=createHandlers(store,{inspect:async()=>({head:'a'.repeat(40),branch:'feature/a',dirty:false})},{allowedRepositories:['/test/repo'],assertQuiescent:async()=>{guardCalls++;if(running)throw Object.assign(new Error('running'),{code:'WRITER_BUSY'});}});
  const request={project_id:'p',workspace_id:id,idempotency_key:'transfer',expected_epoch:1,session_id:'s2',mode:'attach'};
  await assert.rejects(h.call('attach-or-transfer',request,'hermes'),{code:'WRITER_BUSY'});
  assert.equal(w.writer.executor_id,'codex');
  await assert.rejects(h.call('attach-or-transfer',{...request,mode:'quiesce',session_id:'s1'},'codex'),{code:'INVALID_ARGUMENT'});
  const quiesce={...request,mode:'quiesce',session_id:'s1',writes_stopped:true};
  await assert.rejects(h.call('attach-or-transfer',quiesce,'codex'),{code:'WRITER_BUSY'});
  assert.equal(guardCalls,1);assert.equal(w.writer.state,'active');
  running=false;
  await h.call('attach-or-transfer',quiesce,'codex');
  await h.call('attach-or-transfer',{...request,actor_id:'human-claim'},'hermes');
  assert.deepEqual(w.writer,{executor_id:'hermes',session_id:'s2',epoch:2,state:'active'});
  assert.equal(operations.at(-1).executor_id,'hermes');assert.equal(operations.at(-1).actor_id,'human-claim');
  await assert.rejects(h.call('attach-or-transfer',{...request,session_id:'s1'},'codex'),{code:'WRITER_BUSY'});
  assert.equal(attachments.length,1);
});

test('AsyncAPI request/reply includes exactly the seven real methods and owner schemas',async()=>{
  const{readFile}=await import('node:fs/promises');
  const{outputNames}=await import('../src/contracts.mjs');
  const doc=JSON.parse(await readFile(new URL('../asyncapi.json',import.meta.url),'utf8'));
  assert.equal(doc.asyncapi,'3.1.0');assert.equal(Object.keys(doc.operations).length,methods.length);
  for(const method of methods){
    const key=method.replaceAll(/[.-]/g,'_');
    assert.equal(doc.channels[key].address,'brai.codeworks.v1.{executor}.'+method);
    assert.equal(doc.components.messages[key+'Request'].payload.$ref,'./schemas/api.schema.json#/definitions/'+method);
    assert.equal(doc.components.messages[key+'Response'].payload.$ref,'./schemas/api.schema.json#/definitions/'+outputNames[method]);
    assert.equal(doc.operations[key].reply.messages.length,2);
  }
});

test('durable release response carries the exact verified CI identity without accepting unknown proof fields',()=>{
  const proof={run_id:'123',attempt:1,head_sha:'a'.repeat(40),workflow:'.github/workflows/codeworks.yml',recipe:'b'.repeat(64),composition_digest:'sha256:'+'c'.repeat(64),composition_reference:'ghcr.io/owner/repo-components/release@sha256:'+'c'.repeat(64),url:'https://github.com/owner/repo/actions/runs/123'};
  const leg={branch:'feature/codeworks-'+id,head:proof.head_sha,target:'dev',target_sha:'d'.repeat(40),head_ci:proof,merge_ci:{...proof,head_sha:'e'.repeat(40)}};
  validate('gitReleaseResult',{release_id:id,state:'awaiting_deployment',details:{primary:leg}});
  assert.throws(()=>validate('releaseLeg',{...leg,head_ci:{...proof,agent_verified:true}}));
  assert.throws(()=>validate('releaseLeg',{...leg,head_ci:{...proof,composition_digest:'mutable-tag'}}));
});
