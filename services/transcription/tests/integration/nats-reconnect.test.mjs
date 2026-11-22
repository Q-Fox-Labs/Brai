// ABOUTME: Проверяет восстановление реальных NATS Services Transcription и Providers после перезапуска брокера.
// ABOUTME: Работает только с явно помеченным изолированным контейнером и не вызывает модель.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import test from 'node:test';
import {connect,headers} from 'nats';
import {connection} from '../../dist/coordinator/main.js';
import {createPublicGateway} from '../../dist/coordinator/transport/boundary.js';
import {startNatsTransport} from '../../dist/coordinator/transport/nats.js';

const container=process.env.BRAI_RECONNECT_FIXTURE_CONTAINER;
const server=process.env.BRAI_RECONNECT_FIXTURE_NATS;

test('the same service connections resubscribe after an isolated broker restart', {skip:!container||!server,timeout:30000},async t=>{
  const {connectBroker,monitorBroker,canSend:providerCanSend}=await import('../../../providers/dist/nats-connection.js');
  const {historySender}=await import('../../../providers/dist/observation.js');
  const {createDependencyPorts}=await import('../../dist/coordinator/transport/dependencies.js');
  const {registerProvidersV1}=await import('../../../providers/dist/nats-v1.js');
  assert.match(container,/^brai-reconnect-fixture-[0-9a-f]{32}$/);
  assert.match(server,/^nats:\/\/127[.]0[.]0[.]1:[0-9]+$/);
  const info=JSON.parse(execFileSync('/usr/bin/docker',['inspect',container],{encoding:'utf8'}))[0];
  assert.equal(info.Config.Labels['brai.test.fixture'],'nats-reconnect');
  const a=await connection({servers:server,inboxPrefix:'_INBOX.reconnect_transcription'},3000);
  const b=await connectBroker({servers:server,inboxPrefix:'_INBOX.reconnect_providers'});
  const c=await connect({servers:server,inboxPrefix:'_INBOX.reconnect_client',maxReconnectAttempts:-1});
  t.after(async()=>{await Promise.allSettled([a.close(),b.close(),c.close()]);});
  const gateway=createPublicGateway({maxConcurrent:4,bindings:[{token:'synthetic-token',principal:{scopeType:'user',scopeId:'fixture',ownerId:'fixture',permissions:['transcription:use']}}],invoke:async()=>({settings:{defaultLocalModel:null,allowReplacement:false,policyVersion:1},revision:1})});
  const transcription=await startNatsTransport(a,gateway,{requestBytes:4096,responseBytes:4096});
  const providers=await registerProvidersV1(b,{});
  t.after(async()=>{await Promise.allSettled([transcription.close(),providers.stop()]);});
  await b.flush();
  const h=headers();h.set('Authorization','Bearer synthetic-token');
  async function check(){
    const x=await c.request('brai.transcription.v1.settings.get',Buffer.from('{}'),{headers:h,timeout:5000});
    assert.equal(JSON.parse(Buffer.from(x.data).toString()).revision,1);
    const y=await c.request('brai.providers.v1.models.list',Buffer.from('{}'),{timeout:5000});
    assert.ok(Array.isArray(JSON.parse(Buffer.from(y.data).toString()).models));
  }
  await check();
  function reconnected(nc){return new Promise((resolve,reject)=>{void(async()=>{let disconnected=false;for await(const event of nc.status()){
    if(event.type==='disconnect')disconnected=true;
    if(event.type==='reconnect'&&disconnected){resolve();return;}
  }reject(Error('status stream ended'));})().catch(reject);});}
  const restored=[a,b,c].map(reconnected);
  execFileSync('/usr/bin/docker',['restart','--time','1',container],{stdio:'ignore'});
  await Promise.all(restored);
  await Promise.all([a.flush(),b.flush(),c.flush()]);
  await check();

  let delivered=0;
  c.subscribe('brai.history.v1.append.service_providers',{callback:()=>{delivered++;}});
  c.subscribe('brai.history.v1.append.transcription',{callback:()=>{delivered++;}});
  await c.flush();
  function event(nc,type){return new Promise((resolve,reject)=>{void(async()=>{for await(const item of nc.status())if(item.type===type){resolve();return;}reject(Error('status stream ended'));})().catch(reject);});}
  const down=[a,b,c].map(nc=>event(nc,'disconnect'));
  execFileSync('/usr/bin/docker',['stop','--time','1',container],{stdio:'ignore'});
  await Promise.all(down);
  const history=historySender(b,()=>providerCanSend(b));
  history.send({id:'synthetic'});
  assert.equal(history.status().dropped,1);
  const bounds={dependencyTimeoutMs:1000,natsRequestBytes:4096,natsResponseBytes:4096,maxCatalogItems:3,catalogPageSize:2};
  const deps=await createDependencyPorts(a,a,bounds);
  const id='11111111-1111-4111-8111-111111111111';
  const fact={id,type_id:1201,occurred_at:'2026-10-05T01:00:00Z',scope_type:'user',scope_id:'owner',data:{requestId:id,phase:'accepted',outcome:null}};
  await assert.rejects(deps.history.append(fact),error=>error.errorCode==='HISTORY_DELIVERY_FAILED'&&error.outcome==='not_started');
  const up=[a,b,c].map(nc=>event(nc,'reconnect'));
  execFileSync('/usr/bin/docker',['start',container],{stdio:'ignore'});
  await Promise.all(up);
  await Promise.all([a.flush(),b.flush(),c.flush()]);
  await new Promise(resolve=>setTimeout(resolve,200));
  assert.equal(delivered,0,'отключённые запросы не должны доставляться после reconnect');
  await check();

  const monitor=monitorBroker(b);
  const downAgain=event(b,'disconnect');
  execFileSync('/usr/bin/docker',['stop','--time','1',container],{stdio:'ignore'});
  await downAgain;
  monitor.beginShutdown();
  await providers.stop();
  assert.equal(b.isClosed(),true,'остановка во время обрыва должна закрыть соединение');
});
