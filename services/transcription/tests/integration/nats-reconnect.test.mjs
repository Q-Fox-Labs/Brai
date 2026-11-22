// ABOUTME: Проверяет восстановление реальных NATS Services Transcription и Providers после перезапуска брокера.
// ABOUTME: Работает только с явно помеченным изолированным контейнером и не вызывает модель.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import test from 'node:test';
import {connect,headers} from 'nats';
import {connection} from '../../dist/coordinator/main.js';
import {createPublicGateway} from '../../dist/coordinator/transport/boundary.js';
import {startNatsTransport} from '../../dist/coordinator/transport/nats.js';
import {connectBroker} from '../../../providers/dist/nats-connection.js';
import {registerProvidersV1} from '../../../providers/dist/nats-v1.js';

const container=process.env.BRAI_RECONNECT_FIXTURE_CONTAINER;
const server=process.env.BRAI_RECONNECT_FIXTURE_NATS;

test('the same service connections resubscribe after an isolated broker restart', {skip:!container||!server,timeout:30000},async t=>{
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
});
