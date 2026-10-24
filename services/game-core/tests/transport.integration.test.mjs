// ABOUTME: Проверяет переход JetStream на одноразовом настоящем NATS.
// ABOUTME: Требует явной тестовой конфигурации и отказывается менять существующие stream.
import test from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'nats';
import { migrateStream } from '../../../deploy/game-core-transport-migration.mjs';
import { streamConfig,consumerConfigs } from '../../../deploy/game-core-jetstream-config.mjs';

test('реальный JetStream сохраняет backlog и повтор переноса не создаёт копий',{
  skip:!process.env.NATS_TRANSPORT_RENAME_TEST_URL||process.env.NATS_TRANSPORT_RENAME_TEST_DISPOSABLE!=='true',
},async()=>{
  const nc=await connect({servers:process.env.NATS_TRANSPORT_RENAME_TEST_URL,reconnect:false,timeout:3000});
  const manager=await nc.jetstreamManager(),old='BRAI_ELEMENTS_EVENTS_V1';
  let created=false,newCreated=false;
  try{
    for(const name of [old,streamConfig.name]){
      let present=true;
      try{await manager.streams.info(name);}catch(error){if(error.code!=='404')throw error;present=false;}
      assert.equal(present,false,'DISPOSABLE_BROKER_REQUIRED');
    }
    await manager.streams.add({...streamConfig,name:old,subjects:['brai.elements.v1.events.>']});created=true;
    const id='00000000-0000-4000-8000-000000000001',bytes=Buffer.from(JSON.stringify({event_id:id,owner_id:'synthetic'}));
    await nc.jetstream().publish('brai.elements.v1.events.move.completed',bytes,{msgID:id});
    newCreated=true;
    await migrateStream(nc);await migrateStream(nc);
    const info=await manager.streams.info(streamConfig.name);assert.equal(info.state.messages,1);
    const saved=await manager.streams.getMessage(streamConfig.name,{seq:info.state.first_seq});
    assert.equal(saved.subject,'brai.game-core.v1.events.move.completed');assert.deepEqual(Buffer.from(saved.data),bytes);
    for(const expected of consumerConfigs){const actual=await manager.consumers.info(streamConfig.name,expected.durable_name);assert.equal(actual.num_pending,1);}
    assert.equal((await manager.streams.info(old)).state.messages,1);
  }finally{
    if(newCreated)await manager.streams.delete(streamConfig.name);
    if(created)await manager.streams.delete(old);
    await nc.close();
  }
});
