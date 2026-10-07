// ABOUTME: Проверяет атомарную очередь и реальную доставку transcription → NATS → alerts.
// ABOUTME: Только disposable loopback fixtures с явным opt-in; compute и product DB не вызываются.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { startCoordinator } from '../../dist/coordinator/main.js';
import { validateResponse, subjects } from '../../../artifacts/contracts/index.mjs';
import { createPostgresStore, createPolicySnapshot } from '../../dist/helper/storage/index.js';
import { migrate } from '../../dist/helper/migrate.js';
import { createAlertsController } from '../../dist/coordinator/recovery/alerts.js';
import { createAlertsPublisher } from '../../dist/coordinator/transport/alerts.js';
import { runNats } from '../../../alerts/dist/nats.js';
import { createLoadGate } from '../../../alerts/dist/load.js';
import { setup, broker, eventually } from '../../../alerts/tests/integration/fixture.mjs';
import { streamConfig, consumerConfig } from '../../../../deploy/alerts-jetstream-config.mjs';

const enabled=process.env.TRANSCRIPTION_TEST_ALERTS==='1';
test('real PostgreSQL and JetStream transcription alerts', {skip:!enabled,timeout:120000},async t=>{
  assert.equal(process.env.PGHOST,'127.0.0.1');assert.equal(process.env.PGPORT,'19679');
  assert.equal(process.env.PGDATABASE,'brai_transcription_acceptance');assert.equal(process.env.PGUSER,'transcription_owner');
  assert.equal(process.env.TRANSCRIPTION_TEST_APP_PGUSER,'transcription_app');
  assert.equal(process.env.ALERTS_TEST_NATS_URL,'nats://127.0.0.1:24341');
  const owner=new Pool({connectionTimeoutMillis:2000,query_timeout:5000,max:2});
  const app=new Pool({host:'127.0.0.1',port:19679,database:'brai_transcription_acceptance',user:'transcription_app',
    password:process.env.TRANSCRIPTION_TEST_APP_PGPASSWORD,connectionTimeoutMillis:2000,query_timeout:5000,max:4});
  const config={alertsCapacity:20,historyCapacity:100,requestLeaseMs:60000,historyLeaseMs:60000,transactionTimeoutMs:5000,recoveryBatchSize:10};
  let store=createPostgresStore(app,config),f,admin,service,runtime,gate,publisher;
  const selector={modelId:'fixture/whisper',revision:'fixture:1',profileId:'fixture/transcribe'};
  const settings={defaultLocalModel:selector,allowReplacement:false,policyVersion:1};
  const principal={scopeType:'user',scopeId:'alice',ownerId:'alice',permissions:['transcription:use']};
  const helper={call:(method,p)=>store.execute(method,p)};
  const count=async()=>Number((await owner.query('SELECT count(*) FROM transcription.alerts_outbox')).rows[0].count);
  const pending=async()=>Number((await owner.query("SELECT count(*) FROM transcription.alerts_outbox WHERE state<>'reserved'")).rows[0].count);
  const rows=async()=>Number((await f.owner.query('SELECT count(*) FROM alerts.notifications')).rows[0].count);
  async function reset(){
    await owner.query('TRUNCATE transcription.alerts_outbox,transcription.alerts_incidents,transcription.history_outbox,transcription.attempts,transcription.requests');
    await owner.query('UPDATE transcription.settings SET settings=$1,revision=1 WHERE singleton',[settings]);
    if(f)await f.cleanup();if(admin)await(await admin.jetstreamManager()).streams.purge(streamConfig.name);
  }
  async function accept(scope=principal){
    const input={clientIdempotencyKey:randomUUID(),audioArtifactId:randomUUID(),requestedModel:null,deadlineAt:null};
    const params={principal:scope,input,artifact:{artifactId:input.audioArtifactId,ownerId:scope.ownerId,state:'ready',mimeType:'audio/wav',sizeBytes:100},
      selectedModel:selector,policySnapshot:createPolicySnapshot(settings)};
    const result=await store.execute('request.accept',params);
    const repeat=await store.execute('request.accept',params);assert.equal(repeat.created,false);assert.deepEqual(repeat.request,result.request);
    return result;
  }
  async function start(scope=principal){
    const accepted=await accept(scope);const claim=await store.execute('request.claim',{workerId:'worker'});
    assert.equal(claim.request.requestId,accepted.request.requestId);
    const intent=await store.execute('attempt.start',{requestId:claim.request.requestId,attemptId:randomUUID(),claimToken:claim.claimToken,fenceGeneration:claim.fenceGeneration,expectedRevision:claim.revision});
    return {claim,intent};
  }
  async function finish(value,outcome='failed'){
    const {claim,intent}=value;const success=outcome==='succeeded';
    return store.execute('attempt.finish',{requestId:claim.request.requestId,attemptId:intent.attempt.attemptId,claimToken:claim.claimToken,
      fenceGeneration:claim.fenceGeneration,expectedRevision:intent.request.revision,outcome,actualModel:success?selector:null,
      usage:null,cost:null,durationMs:null,errorCode:success?null:outcome==='failed'?'MODEL_UNAVAILABLE':'REQUEST_OUTCOME_UNKNOWN',
      resultState:success?'available':'not_ready',resultExpiresAt:success?new Date(Date.now()+60000).toISOString():null,bufferOwnerInstanceId:success?'first-instance':null});
  }
  async function stop(){
    if(runtime){gate.stopAccepting();await runtime.stop();await gate.drain();runtime=undefined;}
    await service?.close();service=undefined;
  }
  async function consume(){service=await broker('alerts');gate=createLoadGate();runtime=await runNats(service,f.handlers,gate);}
  try{
    await migrate(owner,'transcription_owner','transcription_app',{transactionTimeoutMs:5000});
    f=await setup();admin=await broker('fixture');
    const manager=await admin.jetstreamManager();
    await manager.streams.add({...streamConfig,subjects:[...streamConfig.subjects]});
    await manager.consumers.add(streamConfig.name,{...consumerConfig});
    publisher=createAlertsPublisher({servers:process.env.ALERTS_TEST_NATS_URL,user:'publisher',pass:'alerts-test',inboxPrefix:'_INBOX.brai_alerts_publisher'},1000);
    await t.test('success, cancel, normal TTL and duplicate admission remain silent',async()=>{
      await reset();const accepted=await accept();assert.equal(await pending(),0);
      const canceled=await store.execute('request.cancel',{principal,requestId:accepted.request.requestId,expectedRevision:accepted.request.revision});
      assert.equal(canceled.accepted,true);assert.equal(await count(),0);
      const one=await start();const success=await finish(one,'succeeded');assert.equal(await pending(),0);
      await store.execute('result.setState',{requestId:success.request.requestId,expectedRevision:success.request.revision,state:'delivery_unknown',
        resultExpiresAt:success.request.resultExpiresAt,bufferOwnerInstanceId:'first-instance'});
      assert.equal(await pending(),0);
      await owner.query("UPDATE transcription.requests SET metadata=jsonb_set(metadata,'{resultExpiresAt}',to_jsonb('2000-01-01T00:00:00Z'::text)) WHERE request_id=$1",[success.request.requestId]);
      await store.execute('recovery.run',{coordinatorInstanceId:'next-instance'});assert.equal(await count(),0);
    });
    await t.test('reserve allows terminal failure at full capacity; rollback keeps state and event atomic',async()=>{
      await reset();store=createPostgresStore(app,{...config,alertsCapacity:1});
      const one=await start();await assert.rejects(accept(),e=>e.code==='OVERLOADED');assert.equal(await count(),1);
      await owner.query("CREATE FUNCTION transcription.reject_alert_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.state='pending' THEN RAISE EXCEPTION 'synthetic'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_alert_fixture BEFORE UPDATE ON transcription.alerts_outbox FOR EACH ROW EXECUTE FUNCTION transcription.reject_alert_fixture()");
      try{await assert.rejects(finish(one),e=>e.code==='STORAGE_UNAVAILABLE');assert.equal(await pending(),0);
        assert.equal((await store.execute('request.get',{principal,requestId:one.claim.request.requestId})).request.taskState,'dispatching');}
      finally{await owner.query('DROP TRIGGER reject_alert_fixture ON transcription.alerts_outbox; DROP FUNCTION transcription.reject_alert_fixture()');}
      await finish(one);assert.equal(await pending(),1);
      const meta=await store.execute('request.get',{principal,requestId:one.claim.request.requestId});assert.equal(meta.request.taskState,'failed');
      await store.execute('alerts.observe',{key:'capacity',available:false});assert.equal(await pending(),2,'operational reserve remains available');
      store=createPostgresStore(app,config);
    });
    await t.test('recovery unknown and lost create one event; repeated recovery is silent and system IDs stay private',async()=>{
      await reset();const active=await start();
      await owner.query("UPDATE transcription.requests SET lease_expires_at=clock_timestamp()-interval '1 second'");
      await store.execute('recovery.run',{coordinatorInstanceId:'next-instance'});await store.execute('recovery.run',{coordinatorInstanceId:'next-instance'});
      assert.equal(await pending(),1);const first=await store.execute('alerts.claim',{workerId:'sender'});
      assert.equal(first.event.type_id,3);assert.equal(first.event.scope_id,'alice');
      await store.execute('alerts.ack',{deliveryId:first.deliveryId,claimToken:first.claimToken});
      const system={...principal,scopeType:'system',scopeId:'internal',ownerId:'technical-owner'};
      const complete=await finish(await start(system),'succeeded');
      await store.execute('recovery.run',{coordinatorInstanceId:'next-instance'});assert.equal(await pending(),1);
      const lost=await store.execute('alerts.claim',{workerId:'sender'});
      assert.equal(lost.event.scope_id,'global');assert.deepEqual(lost.event.data,{});
      assert.equal(JSON.stringify(lost.event).includes(complete.request.requestId),false);
      assert.equal((await store.execute('request.get',{principal,requestId:active.claim.request.requestId})).request.taskState,'outcome_unknown');
    });
    await t.test('lease replay preserves ID and payload; stale ack/fail cannot remove new claim',async()=>{
      await reset();await finish(await start());const a=await store.execute('alerts.claim',{workerId:'sender'});
      await owner.query("UPDATE transcription.alerts_outbox SET lease_expires_at=clock_timestamp()-interval '1 second'");
      const b=await store.execute('alerts.claim',{workerId:'sender-2'});
      assert.deepEqual(a.event,b.event);assert.equal(a.deliveryId,b.deliveryId);assert.notEqual(a.claimToken,b.claimToken);
      await assert.rejects(store.execute('alerts.ack',{deliveryId:a.deliveryId,claimToken:a.claimToken}),e=>e.code==='STALE_CLAIM');
      await store.execute('alerts.fail',{deliveryId:b.deliveryId,claimToken:b.claimToken,retryDelayMs:1000});
      assert.equal(await store.execute('alerts.claim',{workerId:'sender'}),null);
    });
    await t.test('first failure creates an episode; restart/recovery do not duplicate and next episode gets new ID',async()=>{
      await reset();const a=await store.execute('alerts.observe',{key:'history',available:false});
      const b=await store.execute('alerts.observe',{key:'history',available:false});assert.deepEqual(a,b);
      store=createPostgresStore(app,config);assert.deepEqual(await store.execute('alerts.observe',{key:'history',available:false}),a);
      const claim=await store.execute('alerts.claim',{workerId:'sender'});await store.execute('alerts.ack',{deliveryId:claim.deliveryId,claimToken:claim.claimToken});
      await store.execute('alerts.observe',{key:'history',available:true});assert.equal(await count(),0);
      const c=await store.execute('alerts.observe',{key:'history',available:false});assert.notEqual(c.event.id,a.event.id);
    });
    await t.test('stopped consumer, lost PubAck and coordinator restart deliver once with correct audience',async()=>{
      await reset();await finish(await start());const attemptsBefore=Number((await owner.query('SELECT count(*) FROM transcription.attempts')).rows[0].count);
      let lost=true;const controller=createAlertsController({helper,publish:async e=>{await publisher.publish(e);if(lost){lost=false;throw new Error('synthetic lost PubAck');}},workerId:'sender',pollIntervalMs:10});
      await controller.tick();assert.equal(await rows(),0);
      const original=(await owner.query("SELECT event FROM transcription.alerts_outbox WHERE request_id IS NOT NULL")).rows[0].event;
      await owner.query("UPDATE transcription.alerts_outbox SET next_attempt_at=clock_timestamp()-interval '1 second'");
      await controller.close();
      const restarted=createAlertsController({helper,publish:publisher.publish,workerId:'sender-new',pollIntervalMs:10});
      for(let i=0;i<4;i++)await restarted.tick();
      assert.equal(await pending(),0);assert.equal(await rows(),0,'PubAck does not mean alerts commit');
      await consume();await eventually(async()=>await rows()>=1);
      const persisted=(await f.owner.query('SELECT id FROM alerts.notifications WHERE id=$1',[original.id])).rows;assert.equal(persisted.length,1);
      // Обход broker dedup window проверяет собственную идемпотентность alerts на повторном wire payload.
      await admin.jetstream().publish('brai.alerts.v1.ingest',Buffer.from(JSON.stringify(original)));
      await eventually(async()=>(await(await admin.jetstreamManager()).streams.info(streamConfig.name)).state.messages===0);
      assert.equal(Number((await f.owner.query('SELECT count(*) FROM alerts.notifications WHERE id=$1',[original.id])).rows[0].count),1);
      const alice=await f.handlers.execute('list',{user_id:'alice'}),bob=await f.handlers.execute('list',{user_id:'bob'});
      assert.ok(alice.items.some(e=>e.id===original.id));assert.ok(!bob.items.some(e=>e.id===original.id));
      assert.ok(bob.items.every(e=>e.scope_type==='system'&&e.scope_id==='global'));
      assert.equal(Number((await owner.query('SELECT count(*) FROM transcription.attempts')).rows[0].count),attemptsBefore);
      await restarted.close();await stop();
    });
    await t.test('full stream rejects publication without losing source event; later retry succeeds',async()=>{
      await reset();await finish(await start());
      await manager.streams.update(streamConfig.name,{max_bytes:64});
      const c=createAlertsController({helper,publish:publisher.publish,workerId:'sender',pollIntervalMs:10});
      await c.tick();assert.equal(await pending(),1);assert.equal(c.status().alertsAvailable,false);
      await manager.streams.update(streamConfig.name,{max_bytes:streamConfig.max_bytes});
      await owner.query("UPDATE transcription.alerts_outbox SET next_attempt_at=clock_timestamp()-interval '1 second'");
      for(let i=0;i<4;i++)await c.tick();assert.equal(await pending(),0);await c.close();
    });
    await t.test('actual coordinator and three children persist and deliver failure while history is unavailable',async()=>{
      await reset();await consume();
      const artifactId=randomUUID(),now=new Date().toISOString();
      const artifact={artifactId,ownerId:'alice',requestId:randomUUID(),kind:'original',status:'ready',
        title:'Synthetic audio',filename:'fixture.wav',extension:'wav',mimeType:'audio/wav',source:'fixture',
        sizeBytes:100,sha256:'0'.repeat(64),internalUrl:'http://fixture.invalid/audio',createdAt:now,updatedAt:now};
      assert.ok(validateResponse(subjects.get,artifact));
      const sub=admin.subscribe(subjects.get,{callback:(error,message)=>{assert.ifError(error);message.respond(Buffer.from(JSON.stringify(artifact)));}});
      await admin.flush();
      const rpc={TRANSCRIPTION_RPC_FRAME_BYTES:'262144',TRANSCRIPTION_RPC_BATCH_ITEMS:'4',
        TRANSCRIPTION_RPC_CONCURRENT_REQUESTS:'16',TRANSCRIPTION_RPC_CONCURRENT_EXECUTE:'2'};
      const pg={PGHOST:'127.0.0.1',PGPORT:'19679',PGDATABASE:'brai_transcription_acceptance',PGUSER:'transcription_app',
        PGPASSWORD:process.env.TRANSCRIPTION_TEST_APP_PGPASSWORD,TRANSCRIPTION_PG_POOL_MAX:'4',
        TRANSCRIPTION_HISTORY_CAPACITY:'100',TRANSCRIPTION_ALERTS_CAPACITY:'20',TRANSCRIPTION_REQUEST_LEASE_MS:'60000',
        TRANSCRIPTION_HISTORY_LEASE_MS:'60000',TRANSCRIPTION_TRANSACTION_TIMEOUT_MS:'5000',TRANSCRIPTION_RECOVERY_BATCH_SIZE:'10'};
      let coordinator;
      try{
        coordinator=await startCoordinator({
          domain:{instanceId:'actual-alerts-fixture',workerId:'actual-alerts-worker',maxExecuteConcurrency:1,
            leaseRenewIntervalMs:1000,defaultExecutionTimeoutMs:15000,resultTtlMs:60000,maxResultCount:10,maxResultBytes:4096,maxTotalResultBytes:40960},
          bindings:[{token:'synthetic-fixture-token',principal}],
          http:{host:'127.0.0.1',port:19682,allowedHosts:['127.0.0.1:19682'],allowedOrigins:['http://127.0.0.1:19682'],
            headerBytes:8192,requestBytes:65536,responseBytes:262144,requestTimeoutMs:10000,maxConnections:16},maxPublicConcurrent:8,
          nats:{servers:process.env.ALERTS_TEST_NATS_URL,user:'fixture',pass:'alerts-test',inboxPrefix:'_INBOX.transcription_alerts_fixture'},
          natsRequestBytes:65536,natsResponseBytes:262144,dependencyTimeoutMs:1000,maxCatalogItems:10,catalogPageSize:10,
          rpcFrameBytes:262144,rpcConcurrentRequests:16,rpcControlTimeoutMs:10000,childShutdownTimeoutMs:1000,
          children:{helper:{...rpc,...pg},local:rpc,external:rpc},
          recovery:{instanceId:'actual-alerts-fixture',workerId:'actual-alerts-worker',recoveryMaxBatches:10,recoveryCycleTimeoutMs:10000,
            recoveryPollIntervalMs:1000,historyMaxDeliveries:10,historyPollIntervalMs:50,pumpPollIntervalMs:20}});
        const call=async(method,input)=>{
          const response=await fetch('http://127.0.0.1:19682/v1/transcription/'+method,{method:'POST',
            headers:{'content-type':'application/json',authorization:'Bearer synthetic-fixture-token'},
            body:JSON.stringify(input),signal:AbortSignal.timeout(10000)});
          assert.equal(response.status,200);return response.json();
        };
        const input={clientIdempotencyKey:randomUUID(),audioArtifactId:artifactId,requestedModel:{route:'external',selection:'required'},deadlineAt:null};
        const admitted=await call('request.submit',input),requestId=admitted.request.requestId;
        assert.equal((await call('request.submit',input)).request.requestId,requestId);
        await eventually(async()=>(await call('request.get',{requestId})).request.taskState==='failed');
        await eventually(async()=>Number((await f.owner.query("SELECT count(*) FROM alerts.notifications WHERE scope_type='user'")).rows[0].count)===1);
        await eventually(async()=>Number((await f.owner.query("SELECT count(*) FROM alerts.notifications WHERE data->>'reason'='history'")).rows[0].count)===1);
        for(let i=0;i<4;i++)await call('result.get',{requestId});
        const notices=(await f.owner.query("SELECT id FROM alerts.notifications WHERE scope_type='user'")).rows;
        assert.equal(notices.length,1);
        assert.equal(Number((await owner.query('SELECT count(*) FROM transcription.attempts')).rows[0].count),1);
        assert.equal((await coordinator.status()).alertsAvailable,true);
      }finally{await coordinator?.close();sub.unsubscribe();await stop();}
    });
    await t.test('migration backfills live requests/results, preserves old metadata and ignores historical failures',async()=>{
      await reset();await finish(await start());await finish(await start(),'succeeded');const accepted=await accept();
      await owner.query('DROP TABLE transcription.alerts_outbox,transcription.alerts_incidents; DELETE FROM transcription.migrations WHERE version=2');
      await migrate(owner,'transcription_owner','transcription_app',{transactionTimeoutMs:5000});assert.equal(await count(),2);assert.equal(await pending(),0);
      const before=await store.execute('request.get',{principal,requestId:accepted.request.requestId});
      await migrate(owner,'transcription_owner','transcription_app',{transactionTimeoutMs:5000});assert.equal(await count(),2);
      assert.deepEqual(await store.execute('request.get',{principal,requestId:accepted.request.requestId}),before);
    });
  }finally{
    await stop();await publisher?.close();await admin?.close();await f?.close();await app.end();await owner.end();
  }
});
