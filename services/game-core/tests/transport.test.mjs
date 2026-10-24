// ABOUTME: Проверяет перенос backlog с прежними UUID и отказ без удаления старого stream.
// ABOUTME: Подставной брокер сохраняет payload bytes и позволяет воспроизвести прерванный перенос.
import test from 'node:test';
import assert from 'node:assert/strict';
import { migrateStream } from '../../../deploy/game-core-transport-migration.mjs';
import { streamConfig } from '../../../deploy/game-core-jetstream-config.mjs';

function fixture() {
  const old='BRAI_ELEMENTS_EVENTS_V1',id='00000000-0000-4000-8000-000000000001';
  const payload=Buffer.from(JSON.stringify({event_id:id,owner_id:'synthetic',occurred_at:'2026-01-01T00:00:00Z'}));
  const streams=new Map([[old,{config:{name:old},messages:[{subject:'brai.elements.v1.events.move.completed',data:payload}]}]]),consumers=new Map();
  let publications=0;
  const absent=()=>{throw Object.assign(new Error('missing'),{code:'404'});};
  const manager={streams:{
    async info(name){const s=streams.get(name);if(!s)absent();return {config:s.config,state:{first_seq:s.messages.length?1:0,last_seq:s.messages.length,messages:s.messages.length}};},
    async add(config){streams.set(config.name,{config,messages:[]});},
    async getMessage(name,{seq}){return streams.get(name).messages[seq-1];},
  },consumers:{
    async info(name,durable){const config=consumers.get(name+durable);if(!config)absent();return {config};},
    async add(name,config){consumers.set(name+config.durable_name,config);},
  }};
  const nc={jetstreamManager:async()=>manager,jetstream:()=>({async publish(subject,data,{msgID}){assert.equal(msgID,id);publications++;streams.get(streamConfig.name).messages.push({subject,data});}})};
  return {nc,streams,old,payload,publications:()=>publications};
}

test('перенос и повтор сохраняют точные bytes и UUID без повторной публикации',async()=>{
  const f=fixture();await migrateStream(f.nc);await migrateStream(f.nc);
  assert.equal(f.publications(),1);
  assert.deepEqual(f.streams.get(streamConfig.name).messages,[{subject:'brai.game-core.v1.events.move.completed',data:f.payload}]);
  assert.ok(f.streams.has(f.old));
});

test('конфликт содержимого в новом stream останавливает перенос и сохраняет старый',async()=>{
  const f=fixture();await migrateStream(f.nc);
  f.streams.get(streamConfig.name).messages[0].data=Buffer.from(JSON.stringify({event_id:'00000000-0000-4000-8000-000000000001',owner_id:'conflict'}));
  await assert.rejects(()=>migrateStream(f.nc));assert.ok(f.streams.has(f.old));assert.equal(f.publications(),1);
});

test('одинаковые повторные доставки прежнего события переносятся один раз',async()=>{
  const f=fixture();const messages=f.streams.get(f.old).messages;messages.push({...messages[0]});
  await migrateStream(f.nc);await migrateStream(f.nc);assert.equal(f.publications(),1);
});
