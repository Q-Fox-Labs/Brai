// ABOUTME: Проверяет настоящий контур Приём/Каналы/Контакты/История/Артефакты.
// ABOUTME: Hermes и конечные получатели тестовые; живой Telegram не вызывается.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {Pool} from 'pg';
import {connect} from 'nats';
import {Client,Connection} from '@temporalio/client';
import {Worker,NativeConnection,Runtime,DefaultLogger} from '@temporalio/worker';
import {createStore} from '../../dist/storage.js';
import {createPorts} from '../../dist/ports.js';
import {createActivities} from '../../dist/activities.js';
import {runBroker} from '../../dist/nats.js';
import {startPeers} from './peers.mjs';
import {integrationConfig} from './fixtures.mjs';
import {startChannels,seed} from '../../../channels/tests/integration/fixture.mjs';
import {startContacts,run,eventually,root} from '../../../contacts/tests/integration/fixture.mjs';
const cfg=integrationConfig();
test('real contact snapshot survives profiles/retries, optional photo and audit outage preserve replies',{skip:!cfg,timeout:150000},async()=>{
 Runtime.install({logger:new DefaultLogger('WARN')});
 const temp=await mkdtemp(root+'tmp/intake-contacts-'),contacts=await startContacts(),channels=await startChannels();
 const owner=new Pool({connectionString:cfg.ownerUrl}),app=new Pool({connectionString:cfg.databaseUrl});
 const nc=await connect({servers:cfg.natsUrl,user:'fixture',pass:'intake-test'}),serviceNc=await connect({servers:cfg.natsUrl,user:'intake',pass:'intake-test'});
 const connection=await Connection.connect({address:cfg.temporalAddress});let native,worker,workerRun,broker,peers,art,hist;
 const workflows=new Set(),correlations=[];
 const database=(role,db)=>'postgresql://'+role+':intake-test@127.0.0.1:25643/'+db;
 const common={NATS_URL:'nats://127.0.0.1:24343',NATS_USER:'fixture',NATS_PASSWORD:'intake-test'};
 const artEnv={...common,ARTIFACTS_DATABASE_URL:database('intake_artifacts_test_app','brai_intake_artifacts_test'),ARTIFACTS_DATA_DIR:temp+'/files',ARTIFACTS_HTTP_HOST:'127.0.0.1',ARTIFACTS_HTTP_PORT:'38414',ARTIFACTS_UPLOAD_BASE_URL:'http://127.0.0.1:38414',ARTIFACTS_INTERNAL_BASE_URL:'http://127.0.0.1:38414'};
 const histEnv={...common,NATS_INBOX_PREFIX:'_INBOX.history_contacts_fixture',HISTORY_APP_DATABASE_URL:database('intake_history_test_app','brai_intake_history_test'),HISTORY_WEB_DATABASE_URL:database('intake_history_test_web','brai_intake_history_test'),HISTORY_CURSOR_HMAC_KEY_FILE:temp+'/key',HISTORY_MCP_HOST:'127.0.0.1',HISTORY_MCP_PORT:'38415',HISTORY_MCP_ALLOWED_HOSTS:'127.0.0.1,localhost',HISTORY_MCP_ALLOWED_ORIGINS:'http://127.0.0.1:38415',HISTORY_MCP_MAX_SESSIONS:'4',HISTORY_MCP_SESSION_IDLE_MS:'60000',HISTORY_GAME_CORE_EVENTS_ENABLED:'false'};
 const rpc=async(subject,q)=>{const r=await nc.request(subject,Buffer.from(JSON.stringify(q)),{timeout:5000});if(r.headers?.get('Nats-Service-Error-Code'))throw Error(r.headers.get('Nats-Service-Error'));return JSON.parse(new TextDecoder().decode(r.data));};
 const client=new Client({connection,namespace:'intake_test'}),store=createStore(app);
 try{
  await channels.owner.query('TRUNCATE channels.channel_operation_receipts,channels.channel_resolutions,channels.channel_versions,channels.channels,channels.channel_connection_versions,channels.channel_connections');await seed(channels);
  await writeFile(temp+'/key',Buffer.alloc(32,23));
  const am=run('services/artifacts/dist/migrate.js',{...artEnv,ARTIFACTS_DATABASE_URL:database('intake_artifacts_test_owner','brai_intake_artifacts_test'),ARTIFACTS_OWNER_ROLE:'intake_artifacts_test_owner',ARTIFACTS_APP_ROLE:'intake_artifacts_test_app'});assert.equal(await am.done,0,am.output());
  const hm=run('services/history/dist/migrate.js',{HISTORY_OWNER_DATABASE_URL:database('intake_history_test_owner','brai_intake_history_test'),HISTORY_OWNER_ROLE:'intake_history_test_owner',HISTORY_APP_ROLE:'intake_history_test_app',HISTORY_WEB_ROLE:'intake_history_test_web'});assert.equal(await hm.done,0,hm.output());
  art=run('services/artifacts/dist/main.js',artEnv);hist=run('services/history/dist/main.js',histEnv);
  await eventually(async()=>{if(art.child.exitCode!==null)throw Error(art.output());try{await rpc('brai.artifacts.v1.get',{artifactId:randomUUID()});}catch(e){return e.message==='NOT_FOUND';}});
  await eventually(async()=>{await rpc('brai.history.v1.query.list',{user_id:'fixture',limit:1});return true;});
  const prepared=await rpc('brai.artifacts.v1.prepare',{requestId:randomUUID(),ownerId:'fixture',kind:'original',metadata:{title:'avatar',filename:'avatar.png',extension:'png',mimeType:'image/png',source:'contacts_test'}});
  assert.equal((await fetch(prepared.uploadUrl,{method:'PUT',body:Buffer.from('synthetic avatar')})).status,201);
  try{await connection.workflowService.registerNamespace({namespace:'intake_test',workflowExecutionRetentionPeriod:{seconds:86400}});}catch(e){if(e.code!==6)throw e;}
  native=await NativeConnection.connect({address:cfg.temporalAddress});
  const binding={ownerId:'fixture',types:['message.incoming','event.recorded'],recipients:['logs'],read:true,resume:false},sources={telegram:binding};
  const portsConfig=Object.fromEntries(['channel','contact','inbox','hermes','understand','memory','deliver'].map(k=>[k,{subject:'brai.fixture.'+k,...(['hermes','understand','memory','deliver'].includes(k)?{resultSource:'fixture_'+k}:{})}]));
  portsConfig.channel={subject:'brai.channels.v1.resolve.intake_test'};portsConfig.contact={subject:'brai.contacts.v1.resolve.intake_test'};
  for(const k of ['hermes','understand','memory','deliver'])sources['fixture_'+k]={...binding,types:k==='hermes'?['operation.result','message.outgoing']:['operation.result']};
  const config={...cfg,sources,ports:portsConfig,taskQueue:'intake-contacts-'+randomUUID(),artifactBaseUrl:'http://127.0.0.1:38414'};
  let lostResolve=true,lostContactAudit=true;
  const requestNc={jetstream:serviceNc.jetstream.bind(serviceNc),async request(subject,...args){const reply=await serviceNc.request(subject,...args);if(subject==='brai.contacts.v1.resolve.intake_test'&&lostResolve){lostResolve=false;throw Error('SYNTHETIC_REPLY_LOST_AFTER_CONTACT_COMMIT');}if(subject==='brai.history.v1.append.service_contacts'&&lostContactAudit){lostContactAudit=false;throw Error('SYNTHETIC_REPLY_LOST_AFTER_HISTORY_COMMIT');}return reply;}};
  const ports=createPorts(requestNc,client,config),activities=createActivities(store,ports,portsConfig);
  await owner.query('TRUNCATE intake_fixture.jobs,intake_fixture.effects,intake_fixture.inbox,intake_fixture.channel_cache');
  peers=await startPeers(nc,owner,{realChannels:true,realContacts:true,realHistory:true,beforeDeliver:async p=>{await channels.rpc('delivery.check',{ownerId:p.ownerId,resolutionId:p.context.resolutionId,destinationHash:channels.hash(p.context.destination)},channels.delivery,'delivery_test');}});
  worker=await Worker.create({connection:native,namespace:'intake_test',taskQueue:config.taskQueue,workflowsPath:fileURLToPath(new URL('../../dist/workflows.js',import.meta.url)),activities,maxConcurrentActivityTaskExecutions:8,maxConcurrentWorkflowTaskExecutions:8,maxCachedWorkflows:32,shutdownGraceTime:'1 second'});workerRun=worker.run();broker=await runBroker(serviceNc,store,ports,config,async()=>true);
  const incoming=(author)=>({version:1,eventId:randomUUID(),source:'telegram',type:'message.incoming',occurredAt:new Date().toISOString(),correlationId:randomUUID(),causationId:null,data:{materialId:randomUUID(),revision:1,conversationId:'conversation',replyToMessageId:null,author:{kind:'human',id:'456',...author},sourceRef:{botId:'123',chatId:'456',threadId:'7'},text:'Synthetic message',attachments:[]}});
  const first=incoming({name:'Alice',username:'',photoArtifactId:prepared.artifact.artifactId});correlations.push(first.correlationId);
  await nc.jetstream().publish('brai.intake.v1.ingress.telegram',Buffer.from(JSON.stringify(first)));
  const p=await eventually(async()=>{const v=await store.find('telegram',first.eventId);return v?.state==='completed'?v:null;},60000);workflows.add(p.workflowId);
  await client.workflow.getHandle(p.workflowId).result();
  assert.equal(lostResolve,false);assert.equal(lostContactAudit,false);assert.equal(p.contact.senderSnapshot.name,'Alice');assert.equal(p.contact.senderSnapshot.photoArtifactId,prepared.artifact.artifactId);assert.equal(Object.hasOwn(p.contactRequest.profile,'username'),false);
  const answer=await eventually(async()=>(await owner.query("SELECT body FROM intake.intake_packets WHERE body->'original'->>'causationId'=$1",[p.id])).rows[0]?.body);workflows.add(answer.workflowId);await client.workflow.getHandle(answer.workflowId).result();assert.equal(answer.contact,undefined);assert.equal(answer.original.data.author.kind,'agent');assert.equal(answer.source,'fixture_hermes');
  const frozen=structuredClone(p.contact),{packetId,...observe}=p.contactRequest;
  const observed=await contacts.rpc('profile.observe',{...observe,operationId:randomUUID(),observedAt:new Date().toISOString(),profile:{name:'Updated'}});for(const fact of observed.historyEvents)await rpc('brai.history.v1.append.service_contacts',fact);
  await contacts.restart();await activities.prepare(p.id);assert.deepEqual((await store.get(p.id)).contact,frozen);
  await assert.rejects(store.update(p.id,v=>{v.contact.senderSnapshot.name='Tampered';}),{code:'IMMUTABLE_INPUT'});
  const events=await rpc('brai.history.v1.query.list',{user_id:'fixture',filters:{source:'service_contacts',object_id:p.contact.contactId},limit:100});assert.equal(events.items.filter(x=>x.id===p.contact.historyEvents[0].id).length,1);
  await hist.stop();hist=null;
  const second=incoming({name:'',username:'new_user',photoArtifactId:randomUUID()});correlations.push(second.correlationId);await nc.jetstream().publish('brai.intake.v1.ingress.telegram',Buffer.from(JSON.stringify(second)));
  const later=await eventually(async()=>{const v=await store.find('telegram',second.eventId);return v?.prepared?v:null;},30000);workflows.add(later.workflowId);
  assert.equal(later.contact.contactId,p.contact.contactId);assert.deepEqual(later.contactRequest.profile,{username:'new_user'});assert.equal(later.contact.historyEvents.length,1);assert.equal(Object.hasOwn(later.prepared.author,'photoArtifactId'),false);
  const response=await eventually(async()=>(await owner.query("SELECT body FROM intake.intake_packets WHERE body->'original'->>'causationId'=$1",[later.id])).rows[0]?.body);workflows.add(response.workflowId);
  await eventually(async()=>Number((await owner.query("SELECT count(*) AS n FROM intake_fixture.effects WHERE kind='deliver' AND id LIKE $1",[response.id+'/deliver/%'])).rows[0].n)>0);
  assert.notEqual((await store.get(later.id)).state,'completed');
  hist=run('services/history/dist/main.js',histEnv);await eventually(async()=>{await rpc('brai.history.v1.query.list',{user_id:'fixture',limit:1});return true;});
  await client.workflow.getHandle(later.workflowId).result();await client.workflow.getHandle(response.workflowId).result();
  assert.equal((await store.get(later.id)).state,'completed');assert.deepEqual(peers.errors,[]);
 }finally{
  await broker?.close();
  for(const row of (await owner.query("SELECT body->>'workflowId' AS id FROM intake.intake_packets WHERE body->'original'->>'correlationId'=ANY($1::text[])",[correlations])).rows)if(row.id)workflows.add(row.id);
  for(const id of workflows)try{const h=client.workflow.getHandle(id);if((await h.describe()).status.name==='RUNNING')await h.terminate('disposable cleanup');}catch{}
  if(worker){worker.shutdown();await workerRun;}await peers?.close();await hist?.stop();await art?.stop();await channels.close();await contacts.close();await native?.close();await connection.close();await serviceNc.close();await nc.close();await app.end();await owner.end();await rm(temp,{recursive:true,force:true});
 }
});
