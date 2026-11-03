// ABOUTME: Проверяет реальные PostgreSQL транзакции и JetStream гарантии на disposable инфраструктуре.
// ABOUTME: Пропуск без явной конфигурации не считается приёмкой интеграции.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {Pool} from 'pg';
import {connect,AckPolicy,RetentionPolicy,StorageType,DiscardPolicy} from 'nats';
import {migrate} from '../../dist/migrate.js';
import {createStore} from '../../dist/storage.js';
import {inputHash} from '../../dist/contracts.js';
import {checkBroker,ingressStream,dispatchStream,durable} from '../../dist/nats.js';
import {integrationConfig} from './fixtures.mjs';
const cfg=integrationConfig();
test('real database uniqueness, immutable snapshots and broker retention',{skip:!cfg},async()=>{
 const owner=new Pool({connectionString:cfg.ownerUrl}),app=new Pool({connectionString:cfg.databaseUrl});
 const nc=await connect({servers:cfg.natsUrl,user:'fixture',pass:'intake-test'}),m=await nc.jetstreamManager();
 try{
  await migrate(owner,cfg.role);await migrate(owner,cfg.role);
  const store=createStore(app),binding={ownerId:'fixture',types:['event.recorded'],recipients:['logs'],read:true,resume:false};
  const e={version:1,eventId:randomUUID(),source:'fixture',type:'event.recorded',occurredAt:new Date().toISOString(),correlationId:'chain',causationId:null,data:{recipient:'logs',payload:{value:1}}};
  const rows=await Promise.all(Array.from({length:8},()=>store.register(e,binding,inputHash(e))));
  assert.equal(new Set(rows.map(p=>p.id)).size,1);
  await assert.rejects(store.register({...e,data:{...e.data,payload:{value:2}}},binding,inputHash({...e,data:{...e.data,payload:{value:2}}})),{code:'EVENT_ID_CONFLICT'});
  const p=rows[0];await store.update(p.id,v=>{v.prepared={ref:'snapshot'};});
  await assert.rejects(store.update(p.id,v=>{v.prepared={ref:'changed'};}),{code:'IMMUTABLE_INPUT'});
  await assert.rejects(app.query('CREATE TABLE intake.forbidden(id integer)'));
  const temp=await mkdtemp(fileURLToPath(new URL('../../../../tmp/intake-provision-',import.meta.url)));
  try {
   const options=temp+'/nats.json';await writeFile(options,JSON.stringify({servers:cfg.natsUrl,user:'fixture',pass:'intake-test'}));
   const provision=()=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,[fileURLToPath(new URL('../../deploy/provision.mjs',import.meta.url))],{env:{...process.env,INTAKE_NATS_ADMIN_OPTIONS_FILE:options},stdio:['ignore','pipe','pipe']});child.once('error',reject);child.once('exit',resolve);});
   assert.equal(await provision(),0);assert.equal(await provision(),0);
   const config=(await m.streams.info(dispatchStream)).config;
   await m.streams.update(dispatchStream,{...config,max_bytes:268435455});
   assert.notEqual(await provision(),0);
   assert.equal((await m.streams.info(dispatchStream)).config.max_bytes,268435455);
   await m.streams.update(dispatchStream,config);
  }finally{await rm(temp,{recursive:true,force:true});}
  await checkBroker(nc);
  const ack=await nc.jetstream().publish('brai.intake.v1.ingress.fixture',Buffer.from(JSON.stringify(e)));
  assert.equal(ack.stream,ingressStream);
  const stored=await m.streams.getMessage(ingressStream,{seq:ack.seq});assert.deepEqual(JSON.parse(new TextDecoder().decode(stored.data)),e);
 }finally{await nc.close();await app.end();await owner.end();}
});
