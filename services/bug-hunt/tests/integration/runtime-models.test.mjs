// ABOUTME: Проверяет продуктовую сборку worker, NATS ACL, Auth, MCP и PostgreSQL вместе.
// ABOUTME: Вычисления заменены закрытыми NATS Services fixture; реальных моделей здесь нет.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import {startFixture,fixture as runtimeFixture} from './fixture.mjs';
import {canonical} from '../../dist/contracts.js';
import {observationHash,PIPELINE_VERSION} from '../../dist/processing.js';
import {EMBEDDING_MODEL,GENERATION,prepareExternalProjection} from '../../dist/projection.js';

const encode=value=>Buffer.from(JSON.stringify(value));
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
/** Компилирует определения владельцев, чтобы fake endpoints не угадывали формат соседнего API. */
function ownerSchemas(path,names){
 const document=JSON.parse(readFileSync(new URL(path,import.meta.url),'utf8'));
 const ajv=new Ajv.default({strict:false,allErrors:false});addFormats.default(ajv);
 ajv.addFormat('rfc3339-microseconds',{type:'string',validate:value=>/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:[.][0-9]{1,6})?(?:Z|[+-][0-9]{2}:[0-9]{2})$/.test(value)&&Number.isFinite(Date.parse(value))});
 const id='urn:fixture:'+path.replace(/[^a-z0-9]/gi,'-');ajv.addSchema({...document,$id:id},id);
 return Object.fromEntries(names.map(name=>[name,ajv.compile({$ref:id+'#/definitions/'+name})]));
}
const local=ownerSchemas('../../../local-ai/schemas/messages.schema.json',['EmbedRequest','EmbedResponse']);
const providers=ownerSchemas('../../../providers/schemas/v1.schema.json',['decideRequest','operationKey','operation']);
const vector=Array.from({length:768},(_,i)=>i===0?1:0);
const observation={
 title:'Synthetic runtime observation',component_id:'synthetic-runtime-component',component_version:'fixture-1',
 operation:'Read stored value',expected:'The saved value is returned',observed:'An empty value is returned',
};

test('product runtime composes durable model branches through its own NATS identity',async()=>{
 assert.equal(new URL(runtimeFixture.natsURL).hostname,'127.0.0.1');
 assert.equal(new URL(runtimeFixture.natsURL).port,'18586');
 for(const key of ['ownerURL','appURL'])assert.equal(new URL(runtimeFixture[key]).port,'18585');
 const installationId='fixture-runtime-models-'+randomUUID();
 const f=await startFixture({installationId});
 let service;
 const operations=new Map(),embeddingRequests=[],classifyingRequests=[],getRequests=[],protocolFailures=[];
 const receipts=[],originals=new Map();
 const processing={enabled:false,embeddingEnabled:true,classificationEnabled:true,externalAllowedOwners:[f.user.id],externalProjections:[],externalProjectionPolicy:"technical-fields-v1",intervalMs:60000,deadlineMs:30000,heartbeatMs:1000,leaseMs:30000,intakeReserveBytes:16777216,maxDerivativeBytes:67108864,dailyLimits:{embedding:{owner:10,global:10},classification:{owner:10,global:10}}};
 const requireProtocol=(condition,code)=>{if(!condition)throw new Error(code);};
 /** Детерминированные метки — только проверка композиции, не проверка качества модели. */
 function answers(questions){
  return Object.fromEntries(Object.entries(questions).map(([name,q])=>{
   if(q.type==='noul')return [name,{type:'noul',noul:.8123456789012345}];
   if(q.type!=='choice'||!Object.hasOwn(q.criteria,'unknown'))throw new Error('UNEXPECTED_FIXTURE_QUESTION');
   return [name,{type:'choice',choice:'unknown',confidence:1,probabilities:Object.fromEntries(Object.keys(q.criteria).map(k=>[k,k==='unknown'?1:0]))}];
  }));
 }
 function endpoint(subject,handler){
  service.addEndpoint(subject.replaceAll('.','_'),{subject,handler:(error,msg)=>{
   if(error){protocolFailures.push('NATS_HANDLER_ERROR');return;}
   try{msg.respond(encode(handler(JSON.parse(Buffer.from(msg.data).toString('utf8')))));}
   catch(error){protocolFailures.push(error.message);msg.respondError(500,'FIXTURE_PROTOCOL_FAILURE',encode({code:'OUTCOME_UNKNOWN',outcome:'unknown'}));}
  }});
 }
 async function report(obs){
  const request={request_id:randomUUID(),observation:obs};
  const result=await f.client.callTool({name:'bug_hunt_report',arguments:request});
  assert.equal(result.isError,undefined,JSON.stringify(result.content??[]));
  const receipt=result.structuredContent;receipts.push(receipt);originals.set(receipt.report_id,observationHash(obs));
  return {request,receipt};
 }
 async function drainJobs(){
  f.cfg.processing={...processing,enabled:true};
  try{
   for(let i=0;i<16;i++){
    await f.runtime.processor.tick();
    const pending=await f.runtime.pool.query("SELECT count(*)::int AS n FROM processing_job WHERE installation_id=$1 AND state IN('pending','running','waiting_dependency')",[installationId]);
    if(pending.rows[0].n===0)return;
    await delay(1100);
   }
   throw new Error('FIXTURE_PROCESSING_DID_NOT_SETTLE');
  }finally{f.cfg.processing={...processing,enabled:false};}
 }
 async function enrichment(case_id){
  const result=await f.client.callTool({name:'bug_hunt_enrichment',arguments:{case_id}});
  assert.equal(result.isError,undefined,JSON.stringify(result.content??[]));return result.structuredContent;
 }
 try{
  assert.equal(f.cfg.processing,undefined);
  service=await f.nc.services.add({name:'fixture_bug_hunt_models',version:'1.0.0'});
  endpoint('brai.local_ai.v1.invoke.embed',body=>{
   requireProtocol(local.EmbedRequest(body),'EMBED_REQUEST_SCHEMA');
   requireProtocol(body.ownerId===f.user.id&&canonical(body.model)===canonical(EMBEDDING_MODEL)&&body.purpose==='symmetric'&&body.texts.length===1,'EMBED_SCOPE_OR_SELECTOR');
   requireProtocol(!embeddingRequests.some(r=>r.operationId===body.operationId),'EMBED_INVOKE_REPLAY');
   embeddingRequests.push(body);
   const response={requestId:body.requestId,operationId:body.operationId,model:EMBEDDING_MODEL,durationMs:1,vectors:[vector]};
   requireProtocol(local.EmbedResponse(response),'EMBED_RESPONSE_SCHEMA');return response;
  });
  endpoint('brai.providers.v1.invoke.decide',body=>{
   requireProtocol(providers.decideRequest(body),'DECIDE_REQUEST_SCHEMA');
   requireProtocol(body.ownerId===f.user.id&&body.provider==='typesafe'&&body.model==='jev-1.13.0','DECIDE_SCOPE_OR_SELECTOR');
   requireProtocol(!operations.has(body.operationId),'DECIDE_INVOKE_REPLAY');
   const allowedStates=[observation,{...observation,title:'Synthetic second runtime observation',observed:'The stored value is missing'}].map(o=>prepareExternalProjection(o).text);
   requireProtocol(allowedStates.includes(body.state),'UNAPPROVED_EXTERNAL_STATE');
   classifyingRequests.push(body);const now=Date.now();
   const accepted={operationId:body.operationId,ownerId:body.ownerId,phase:'accepted',cancelRequested:false,createdAt:now,finishedAt:null,keyExpiresAt:now+7*86400000,resultExpiresAt:null,route:{provider:'typesafe',model:'jev-1.13.0',catalogVersion:'fixture-only-1'},result:null,errorCode:null,resultExpired:false,billingMayContinue:false};
   const succeeded={...accepted,phase:'succeeded',finishedAt:now+1,resultExpiresAt:now+86400000,result:{provider:'typesafe',requestedModel:'jev-1.13.0',actualModel:'jev-1.13.0',answers:answers(body.questions),usage:{inputTokens:30,outputTokens:8}}};
   requireProtocol(providers.operation(accepted)&&providers.operation(succeeded),'DECIDE_RESPONSE_SCHEMA');
   operations.set(body.operationId,{body:canonical(body),request:body,result:succeeded});return accepted;
  });
  endpoint('brai.providers.v1.operations.get',body=>{
   requireProtocol(providers.operationKey(body),'GET_REQUEST_SCHEMA');
   const entry=operations.get(body.operationId);
   requireProtocol(!!entry&&entry.request.ownerId===body.ownerId&&entry.body===canonical(entry.request),'GET_SCOPE_OR_INTENT_CHANGED');
   getRequests.push(body);return entry.result;
  });
  await f.nc.flush();
  // AIDEV-NOTE: Новый таймер получает 60s при disabled; endpoints уже существуют до разрешения dispatch.
  f.cfg.processing={...processing};await f.restart();
  const first=await report(observation);
  const secondObservation={...observation,title:'Synthetic second runtime observation',observed:'The stored value is missing'};
  const second=await report(secondObservation);
  assert.deepEqual(processing.externalProjections,[],'new reports do not require per-report configuration');
  const before=await f.runtime.pool.query("SELECT count(*)::int AS jobs,count(DISTINCT report_id)::int AS reports FROM processing_job WHERE installation_id=$1",[installationId]);
  assert.deepEqual(before.rows[0],{jobs:6,reports:2});
  const replay=await f.client.callTool({name:'bug_hunt_report',arguments:first.request});
  assert.equal(replay.structuredContent.replayed,true);assert.equal(replay.structuredContent.report_id,first.receipt.report_id);
  const pending=await enrichment(first.receipt.case_id);assert.equal(pending.processing.branches.length,3);assert.ok(pending.processing.branches.every(b=>b.state==='pending'));
  assert.equal(embeddingRequests.length+classifyingRequests.length,0);
  await drainJobs();
  assert.equal(protocolFailures.length,0,protocolFailures.join(','));
  assert.equal(embeddingRequests.length,2);assert.equal(classifyingRequests.length,2);assert.equal(getRequests.length,2);
  for(const receipt of [first.receipt,second.receipt]){
   const enriched=await enrichment(receipt.case_id);
   assert.ok(enriched.processing.branches.every(b=>b.state==='succeeded'));
   assert.equal(enriched.processing.classifications.length,1);
   const classification=enriched.processing.classifications[0];
   assert.equal(typeof classification.registered_at,'string');assert.ok(Number.isFinite(Date.parse(classification.registered_at)));
   assert.equal(classification.model_id,'jev-1.13.0');assert.equal(classification.payload.actual_model,'jev-1.13.0');assert.equal(classification.payload.machine_suggestion,true);
   assert.equal(classification.payload.answers.evidence_sufficiency.noul,.8123456789012345);
   assert.equal(classification.payload.usage.inputTokens,30);
   assert.equal(classification.payload.policy_version,'technical-fields-v1');
   assert.equal(classification.payload.operation_id,operations.get(classification.payload.operation_id).request.operationId);
  }
  const similar=await f.client.callTool({name:'bug_hunt_similar',arguments:{case_id:first.receipt.case_id}});
  assert.equal(similar.isError,undefined,JSON.stringify(similar.content??[]));
  assert.equal(similar.structuredContent.coverage.state,'complete');
  assert.equal(similar.structuredContent.items[0].case_id,second.receipt.case_id);assert.equal(similar.structuredContent.items[0].score,1);
  const originalsAfterModels=await f.runtime.pool.query('SELECT id,observation FROM report WHERE installation_id=$1',[installationId]);
  for(const row of originalsAfterModels.rows)assert.equal(observationHash(row.observation),originals.get(row.id));

  // Закрытый NATS operator DTO отделяет подготовку от явного covered activate.
  processing.targetGeneration='gemma2-runtime-next';
  f.cfg.processing={...processing,enabled:false};
  const prepared=await f.call('brai.bug_hunt.v2.processing.status',{});
  assert.equal(prepared.generations.active,GENERATION);assert.equal(prepared.generations.build,processing.targetGeneration);
  assert.equal(prepared.generations.build_coverage.total_reports,2);assert.equal(prepared.generations.build_coverage.indexed_reports,0);
  const activate={request_id:randomUUID(),generation:processing.targetGeneration,expected_active_generation:GENERATION,reason:'Synthetic runtime accepted generation'};
  await assert.rejects(f.call('brai.bug_hunt.v2.processing.activate-generation',activate),e=>e.code==='INDEX_NOT_READY');
  await assert.rejects(f.call('brai.bug_hunt.v2.processing.activate-generation',{...activate,owner_id:f.user.id}),e=>e.code==='INVALID_ARGUMENT');
  await assert.rejects(f.brokerNc.request('brai.bug_hunt.v2.processing.activate-generation',encode(activate),{timeout:250}));
  await drainJobs();
  assert.equal(embeddingRequests.length,4);assert.equal(classifyingRequests.length,2,'target generation never repeats Jev');
  const beforeActivation=await f.client.callTool({name:'bug_hunt_similar',arguments:{case_id:first.receipt.case_id}});
  assert.equal(beforeActivation.structuredContent.generation,GENERATION);
  const activated=await f.call('brai.bug_hunt.v2.processing.activate-generation',activate);
  assert.equal(activated.generation,processing.targetGeneration);assert.equal(activated.replayed,false);
  assert.deepEqual(await f.call('brai.bug_hunt.v2.processing.activate-generation',activate),{...activated,replayed:true});
  const afterActivation=await f.client.callTool({name:'bug_hunt_similar',arguments:{case_id:first.receipt.case_id}});
  assert.equal(afterActivation.structuredContent.generation,processing.targetGeneration);assert.equal(afterActivation.structuredContent.coverage.state,'complete');
  const retained=await f.runtime.pool.query('SELECT count(*)::int AS n FROM embedding_chunk WHERE installation_id=$1 AND generation=$2',[installationId,GENERATION]);
  assert.equal(retained.rows[0].n,2);

  // Запрет внешней политики оставляет локальную индексацию и Local AI рабочими.
  processing.externalAllowedOwners=[];processing.externalProjections=[];
  const denied=await report({...observation,title:'Synthetic default denied external processing'});
  await drainJobs();
  const deniedResult=await enrichment(denied.receipt.case_id);
  assert.equal(deniedResult.processing.branches.find(b=>b.branch==='classification').state,'blocked_policy');
  assert.equal(deniedResult.processing.branches.find(b=>b.branch==='embedding').state,'succeeded');
  assert.equal(deniedResult.processing.branches.find(b=>b.branch==='local').state,'succeeded');
  assert.equal(embeddingRequests.length,5);assert.equal(classifyingRequests.length,2);

  // Auth отзывается после intake: worker обязан повторно проверить реальный NATS/Auth перед отправкой.
  const revokedObservation={...observation,title:'Synthetic Auth revoked before dispatch'};
  const revoked=await report(revokedObservation);
  processing.externalAllowedOwners=[f.user.id];processing.externalProjections=[{ownerId:f.user.id,inputHash:observationHash(revokedObservation),text:'Synthetic approved revoked-owner incident.',excludedFields:[],policyVersion:'synthetic-reviewed-1'}];
  await f.authPool.query("UPDATE brai_identity SET status='blocked' WHERE user_id=$1",[f.user.id]);
  try{await drainJobs();assert.equal(embeddingRequests.length,5);assert.equal(classifyingRequests.length,2);}
  finally{await f.authPool.query("UPDATE brai_identity SET status='active' WHERE user_id=$1",[f.user.id]);}
  const revokedResult=await enrichment(revoked.receipt.case_id);
  assert.equal(revokedResult.processing.branches.find(b=>b.branch==='embedding').state,'blocked_policy');
  assert.equal(revokedResult.processing.branches.find(b=>b.branch==='classification').state,'blocked_policy');
  assert.equal(revokedResult.processing.branches.find(b=>b.branch==='local').state,'succeeded');

  const final=await f.runtime.pool.query("SELECT (SELECT count(*)::int FROM report WHERE installation_id=$1) AS reports,(SELECT count(*)::int FROM processing_job WHERE installation_id=$1) AS jobs,(SELECT count(*)::int FROM processing_attempt WHERE installation_id=$1) AS attempts,(SELECT count(*)::int FROM processing_job WHERE installation_id=$1 AND pipeline_version<>$2) AS wrong_pipeline",[installationId,PIPELINE_VERSION]);
  assert.deepEqual(final.rows[0],{reports:4,jobs:14,attempts:7,wrong_pipeline:0});
  const saved=await f.runtime.pool.query('SELECT id,observation FROM report WHERE installation_id=$1',[installationId]);
  for(const row of saved.rows)assert.equal(observationHash(row.observation),originals.get(row.id));
  const status=await f.call('brai.bug_hunt.v2.processing.status',{});
  assert.equal(status.paused,false);assert.equal(status.limits.dailyLimits.classification.global,10);
  assert.equal(protocolFailures.length,0,protocolFailures.join(','));
 }finally{
  f.cfg.processing={...processing,enabled:false};
  await f.runtime.processor.stop();
  if(service)await service.stop();
  await f.close();
 }
});
