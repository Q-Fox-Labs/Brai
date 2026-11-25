// ABOUTME: Проверяет восстановление каталога расшифровки после перезапуска изолированного NATS.
// ABOUTME: Не обращается к пользовательским данным и не повторяет вычисления.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import test from 'node:test';
import {connect, headers, JSONCodec} from 'nats';
import {connection, createLocalConnectionProvider} from '../../dist/coordinator/main.js';
import {createDependencyPorts} from '../../dist/coordinator/transport/dependencies.js';
import {createPublicGateway} from '../../dist/coordinator/transport/boundary.js';
import {startNatsTransport} from '../../dist/coordinator/transport/nats.js';

const container=process.env.BRAI_RECONNECT_FIXTURE_CONTAINER;
const server=process.env.BRAI_RECONNECT_FIXTURE_NATS;

test('catalog reconnects after the isolated NATS restart', {skip:!container||!server,timeout:90000},async t=>{
  assert.match(container,/^brai-reconnect-fixture-[0-9a-f]{32}$/);
  assert.match(server,/^nats:\/\/127[.]0[.]0[.]1:[0-9]+$/);
  const info=JSON.parse(execFileSync('/usr/bin/docker',['inspect','--type','container',container],{encoding:'utf8'}))[0];
  assert.equal(info.Config.Labels['brai.test.fixture'],'nats-reconnect');
  const published=info.NetworkSettings.Ports['4222/tcp'];
  assert.equal(published.length,1); assert.equal(published[0].HostIp,'127.0.0.1');
  assert.equal(server,`nats://127.0.0.1:${published[0].HostPort}`);
  const deadline=Date.now()+10000;
  while(true){
    try{const probe=await connect({servers:server,timeout:500,maxReconnectAttempts:0});await probe.close();break;}
    catch(error){if(Date.now()>=deadline)throw error;await new Promise(resolve=>setTimeout(resolve,100));}
  }
  const settings={servers:server,inboxPrefix:'_INBOX.reconnect_transcription'};
  const main=await connection(settings,3000);
  const local=createLocalConnectionProvider(settings,3000);
  const localConnection=await local.get();
  const service=await connect({servers:server,inboxPrefix:'_INBOX.reconnect_fixture',maxReconnectAttempts:-1});
  t.after(async()=>{await Promise.allSettled([main.close(),local.close(),service.close()]);});
  const settingsResult={settings:{defaultLocalModel:null,allowReplacement:false,policyVersion:1},revision:1};
  const gateway=createPublicGateway({maxConcurrent:1,bindings:[{token:'fixture-public-token',
    principal:{scopeType:'user',scopeId:'fixture',ownerId:'fixture-owner',permissions:['transcription:use']}}],
    invoke:async()=>settingsResult});
  const listener=await startNatsTransport(main,gateway,{requestBytes:4096,responseBytes:4096});
  t.after(async()=>{await listener.close();await listener.settled();});
  const auth=headers();auth.set('Authorization','Bearer fixture-public-token');
  const metadata=async()=>JSON.parse(new TextDecoder().decode((await service.request('brai.transcription.v1.settings.get',
    Buffer.from('{}'),{timeout:3000,headers:auth})).data));
  assert.deepEqual(await metadata(),settingsResult);
  const card={modelId:'whisper',name:'model',description:'',source:'fixture',license:null,revision:'v1',profileId:'cpu',supported:true,
    operations:['transcribe'],languages:[],inputKinds:['audio_artifact'],outputKinds:['transcription'],files:[],
    hardwareRequirements:{cpuArchitectures:[],minMemoryBytes:null,accelerator:null},limits:{maxInputBytes:null,maxAudioSeconds:null,maxItems:null,maxResultBytes:null,vectorDimensions:null},
    parameters:{embed:null,transcribe:{}},installationState:'installed',runtimeState:'ready'};
  const codec=JSONCodec();
  let requests=0;
  service.subscribe('brai.local_ai.v1.models.list',{callback:(_err,msg)=>{requests++;msg.respond(codec.encode({items:[card],nextCursor:null}));}});
  await service.flush();
  const bounds={dependencyTimeoutMs:5000,natsRequestBytes:4096,natsResponseBytes:16384,maxCatalogItems:10,catalogPageSize:10};
  const ports=await createDependencyPorts(main,local.get,bounds);
  assert.equal((await ports.localCatalog.list()).length,1);
  function reconnected(nc){return new Promise((resolve,reject)=>{void(async()=>{let down=false;for await(const event of nc.status()){
    if(event.type==='disconnect')down=true;if(event.type==='reconnect'&&down){resolve();return;}
  }reject(Error('status stream ended'));})().catch(reject);});}
  const resumed=[main,localConnection,service].map(reconnected);
  execFileSync('/usr/bin/docker',['restart','--time','1',info.Id],{stdio:'ignore',timeout:10000});
  let timer;
  try{await Promise.race([Promise.all(resumed),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('reconnect timed out')),20000);})]);}
  finally{clearTimeout(timer);}
  const fresh=JSON.parse(execFileSync('/usr/bin/docker',['inspect','--type','container',info.Id],{encoding:'utf8'}))[0];
  assert.deepEqual(fresh.NetworkSettings.Ports['4222/tcp'],published);
  await Promise.all([main.flush(),localConnection.flush(),service.flush()]);
  assert.equal((await ports.localCatalog.list()).length,1);
  assert.deepEqual(await metadata(),settingsResult);
  assert.equal(requests,2,'no catalog request is replayed after reconnect');
});
