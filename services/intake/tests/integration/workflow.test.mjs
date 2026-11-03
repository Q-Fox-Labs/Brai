// ABOUTME: Проверяет реальные workflow, callbacks и перезапуск worker с изолированными соседями.
// ABOUTME: Управляет только namespace intake_test, собственной task queue и packet IDs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {Pool} from 'pg';
import {connect,AckPolicy} from 'nats';
import {Client,Connection} from '@temporalio/client';
import {Worker,NativeConnection,Runtime,DefaultLogger} from '@temporalio/worker';
import {createStore} from '../../dist/storage.js';
import {createPorts} from '../../dist/ports.js';
import {createActivities} from '../../dist/activities.js';
import {runBroker} from '../../dist/nats.js';
import {parseEvent} from '../../dist/contracts.js';
import {startPeers} from './peers.mjs';
import {integrationConfig} from './fixtures.mjs';
const cfg=integrationConfig();
async function eventually(fn,ms=30000){const end=Date.now()+ms;while(Date.now()<end){const value=await fn();if(value)return value;await new Promise(r=>setTimeout(r,25));}throw Error('CONDITION_TIMEOUT');}
test('messages have independent durable workflows; worker restart and delayed memory preserve delivery',{skip:!cfg,timeout:120000},async()=>{
 Runtime.install({logger:new DefaultLogger('WARN')});
 const owner=new Pool({connectionString:cfg.ownerUrl}),app=new Pool({connectionString:cfg.databaseUrl});
 const nc=await connect({servers:cfg.natsUrl,user:'fixture',pass:'intake-test'});
 const serviceNc=await connect({servers:cfg.natsUrl,user:'intake',pass:'intake-test'});
 const connection=await Connection.connect({address:cfg.temporalAddress});
 try{await connection.workflowService.registerNamespace({namespace:'intake_test',workflowExecutionRetentionPeriod:{seconds:86400}});}catch(e){if(e.code!==6)throw e;}
 const client=new Client({connection,namespace:'intake_test'});
 const native=await NativeConnection.connect({address:cfg.temporalAddress});
 const binding={ownerId:'fixture',types:['message.incoming','event.recorded'],recipients:['logs'],read:true,resume:false};
 const portsConfig=Object.fromEntries(['channel','contact','inbox','hermes','understand','memory','deliver'].map(k=>[k,{subject:'brai.fixture.'+k,...(['hermes','understand','memory','deliver'].includes(k)?{resultSource:'fixture_'+k}:{})}]));
 const sources={telegram:binding};
 for(const k of ['hermes','understand','memory','deliver'])sources['fixture_'+k]={...binding,types:k==='hermes'?['operation.result','message.outgoing']:['operation.result']};
 const runtimeConfig={...cfg,sources,ports:portsConfig,taskQueue:'intake-test-'+randomUUID(),artifactBaseUrl:'http://127.0.0.1:9'};
 const store=createStore(app),ports=createPorts(serviceNc,client,runtimeConfig),activities=createActivities(store,ports,portsConfig);
 let runtime,peers,worker,workerRun;const ownIds=new Set();
 const makeWorker=async()=>{worker=await Worker.create({connection:native,namespace:'intake_test',taskQueue:runtimeConfig.taskQueue,workflowsPath:fileURLToPath(new URL('../../dist/workflows.js',import.meta.url)),activities,maxConcurrentActivityTaskExecutions:4,maxConcurrentWorkflowTaskExecutions:8,maxCachedWorkflows:32,shutdownGraceTime:'1 second'});workerRun=worker.run();};
 try{
  peers=await startPeers(nc,owner,{holdMemory:true});
  const incoming={version:1,eventId:randomUUID(),source:'telegram',type:'message.incoming',occurredAt:new Date().toISOString(),correlationId:randomUUID(),causationId:null,data:{materialId:randomUUID(),revision:1,conversationId:'conversation',replyToMessageId:null,author:{kind:'human',id:'456'},sourceRef:{botId:'123',chatId:'456',threadId:'7'},text:'Сообщение пользователя',attachments:[]}};
  parseEvent(Buffer.from(JSON.stringify(incoming)));
  await nc.jetstream().publish('brai.intake.v1.ingress.telegram',Buffer.from(JSON.stringify(incoming)));
  // Намеренно задерживаем consumer: snapshot должен использовать время брокера, а не обработки.
  await new Promise(r=>setTimeout(r,150));const consumerStarted=Date.now();
  runtime=await runBroker(serviceNc,store,ports,runtimeConfig,async()=>true);
  const p=await eventually(()=>store.find('telegram',incoming.eventId));
  assert.ok(Date.parse(p.receivedAt)<consumerStarted-100);ownIds.add(p.workflowId);
  await makeWorker();
  await eventually(async()=>Number((await owner.query("SELECT count(*) AS n FROM intake_fixture.effects WHERE kind='deliver'")).rows[0].n)>0);
  const outgoing=await eventually(async()=>(await owner.query("SELECT body FROM intake.intake_packets WHERE body->'original'->>'causationId'=$1",[p.id])).rows[0]?.body);
  ownIds.add(outgoing.workflowId);
  await eventually(async()=>Number((await owner.query("SELECT count(*) AS n FROM intake_fixture.effects WHERE kind='deliver' AND id LIKE $1",[outgoing.id+'/deliver/%'])).rows[0].n)>0);
  assert.notEqual(outgoing.workflowId,p.workflowId);
  assert.equal(outgoing.original.data.replyToMessageId,p.id);
  assert.notEqual((await store.get(p.id)).state,'completed');
  assert.notEqual((await store.get(outgoing.id)).state,'completed');
  worker.shutdown();await workerRun;worker=null;
  await makeWorker();
  peers.releaseMemory();
  await eventually(async()=>(await store.get(p.id)).state==='completed',60000);
  await eventually(async()=>(await store.get(outgoing.id)).state==='completed',60000);
  await client.workflow.getHandle(p.workflowId).result();
  await client.workflow.getHandle(outgoing.workflowId).result();
  const jobsBefore=Number((await owner.query('SELECT count(*) AS n FROM intake_fixture.jobs')).rows[0].n);
  await nc.jetstream().publish('brai.intake.v1.ingress.telegram',Buffer.from(JSON.stringify(incoming)));
  await new Promise(r=>setTimeout(r,150));
  assert.equal(Number((await owner.query('SELECT count(*) AS n FROM intake_fixture.jobs')).rows[0].n),jobsBefore);
  const conflictAck=await nc.jetstream().publish('brai.intake.v1.ingress.telegram',Buffer.from(JSON.stringify({...incoming,data:{...incoming.data,text:'Конфликт'}})));
  await eventually(async()=>Number((await owner.query('SELECT count(*) AS n FROM intake.intake_rejections WHERE event_id=$1',[incoming.eventId])).rows[0].n)>0);
  assert.equal((await store.get(p.id)).original.data.text,'Сообщение пользователя');
  const rejected=await nc.request('brai.intake.v1.get.telegram',Buffer.from(JSON.stringify({source:'telegram',sequence:conflictAck.seq})),{timeout:5000});
  assert.equal(JSON.parse(new TextDecoder().decode(rejected.data)).code,'EVENT_ID_CONFLICT');
  assert.deepEqual(peers.errors,[]);
  await runtime.close();
  runtime=await runBroker(serviceNc,store,{...ports,async startWorkflow(){throw Error('TEMPORAL_DISABLED');}},runtimeConfig,async()=>false);
  const generic={...incoming,eventId:randomUUID(),type:'event.recorded',data:{recipient:'logs',payload:{value:1}}};
  await nc.jetstream().publish('brai.intake.v1.ingress.telegram',Buffer.from(JSON.stringify(generic)));
  const forwarded=await eventually(async()=>{const v=await store.find('telegram',generic.eventId);return v?.state==='forwarded'?v:null;});
  assert.equal(forwarded.workflowId,null);assert.equal(forwarded.receiptId,null);
  const manager=await nc.jetstreamManager();
  try{await manager.consumers.info('BRAI_INTAKE_DISPATCH_V1','fixture_logs');}catch{await manager.consumers.add('BRAI_INTAKE_DISPATCH_V1',{durable_name:'fixture_logs',ack_policy:AckPolicy.Explicit,filter_subject:'brai.intake.v1.dispatch.logs',max_deliver:-1});}
  const logs=await nc.jetstream().consumers.get('BRAI_INTAKE_DISPATCH_V1','fixture_logs');
  const log=await logs.next({expires:5000});
  assert.ok(log);assert.equal(log.headers.get('Brai-Owner-Id'),'fixture');assert.equal(log.headers.get('Brai-Intake-Packet-Id'),forwarded.id);
  await owner.query('INSERT INTO intake_fixture.effects(id,kind) VALUES($1,$2) ON CONFLICT DO NOTHING',[log.headers.get('Brai-Intake-Packet-Id'),'log']);
  await log.ackAck();
  const statuses=await nc.request('brai.intake.v1.status',Buffer.from('{}'),{timeout:5000});
  assert.deepEqual(JSON.parse(new TextDecoder().decode(statuses.data)),{jetstream:true,temporal:false});
  const restricted=await serviceNc.jetstreamManager({timeout:500});
  await assert.rejects(restricted.streams.delete('BRAI_INTAKE_INGRESS_V1'));
 }finally{
  peers?.releaseMemory();
  for(const id of ownIds){try{const h=client.workflow.getHandle(id);if((await h.describe()).status.name==='RUNNING')await h.terminate('own disposable test cleanup');}catch{}}
  if(worker){worker.shutdown();await workerRun.catch(()=>{});}
  await runtime?.close();await peers?.close();await native.close();await connection.close();await serviceNc.close();await nc.close();await app.end();await owner.end();
 }
});
