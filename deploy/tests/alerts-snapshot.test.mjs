// ABOUTME: Проверяет native alerts snapshot и реальный restore только отдельного transient NATS fixture.
// ABOUTME: Тест требует явный loopback24841; production и основной alerts broker не используются.
import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp,readFile,rm} from "node:fs/promises";
import {connect,headers} from "nats";
import {snapshot} from "../snapshot-alerts-jetstream.mjs";
import {streamConfig,consumerConfig} from "../alerts-jetstream-config.mjs";

test("native stream snapshot preserves queued packet and durable metadata after restore",{timeout:45000},async()=>{
 assert.equal(process.env.ALERTS_SNAPSHOT_TEST_NATS_URL,"nats://127.0.0.1:24841","Explicit own transient fixture required");
 const nc=await connect({servers:process.env.ALERTS_SNAPSHOT_TEST_NATS_URL,inboxPrefix:"_INBOX.alerts_snapshot_test",timeout:3000,reconnect:false});
 const directory=await mkdtemp("/srv/projects/brai/tmp/alerts-backup-test-");
 try{
  const manager=await nc.jetstreamManager();await manager.streams.add({...streamConfig,subjects:[...streamConfig.subjects]});await manager.consumers.add(streamConfig.name,{...consumerConfig});
  const body=Buffer.from(JSON.stringify({id:"snapshot-packet",service_id:"fixture",scope_type:"user",scope_id:"synthetic-a",text:"integrity",data:{nested:[1,"two",true]}}));
  const packetHeaders=headers();packetHeaders.set("X-Alert-Snapshot-Probe","metadata-integrity");
  const publication=await nc.jetstream().publish("brai.alerts.v1.ingest",body,{headers:packetHeaders});
  const second=Buffer.from(JSON.stringify({id:"second-unacknowledged",data:{pending:true}}));
  const secondPublication=await nc.jetstream().publish("brai.alerts.v1.ingest",second);
  const pulled=await nc.request(`$JS.API.CONSUMER.MSG.NEXT.${streamConfig.name}.${consumerConfig.durable_name}`,Buffer.from(JSON.stringify({batch:1,expires:5000000000})),{timeout:5000,noMux:true});
  assert.deepEqual(Buffer.from(pulled.data),body);assert.ok(pulled.reply.startsWith("$JS.ACK."));
  // AIDEV-NOTE: Не подтверждаем packet: snapshot обязан сохранить pending ACK вместе с ещё не доставленным вторым входом.
  const metadata=await snapshot(nc,directory+"/snapshot.s2");
  assert.equal(metadata.stream.config.name,streamConfig.name);assert.equal(metadata.stream.state.messages,2);
  assert.equal(metadata.consumer.name,consumerConfig.durable_name);assert.deepEqual(metadata.consumer.config.ack_policy,"explicit");
  const archive=await readFile(directory+"/snapshot.s2");assert.equal(archive.length,metadata.bytes);assert.ok(archive.length>0&&archive.length<1048576);
  await manager.streams.delete(streamConfig.name);
  const response=JSON.parse(Buffer.from((await nc.request(`$JS.API.STREAM.RESTORE.${streamConfig.name}`,Buffer.from(JSON.stringify({config:metadata.stream.config,state:metadata.stream.state})),{timeout:5000})).data).toString());
  assert.ok(!response.error&&response.deliver_subject);
  for(let offset=0;offset<archive.length;offset+=65536)await nc.request(response.deliver_subject,archive.subarray(offset,offset+65536),{timeout:5000});
  const done=await nc.request(response.deliver_subject,new Uint8Array(),{timeout:5000});
  if(done.data.length)assert.ok(!JSON.parse(Buffer.from(done.data).toString()).error);
  const restored=await manager.streams.info(streamConfig.name),consumer=await manager.consumers.info(streamConfig.name,consumerConfig.durable_name);
  assert.equal(restored.state.messages,2);assert.deepEqual(consumer.config,metadata.consumer.config);
  const packet=await manager.streams.getMessage(streamConfig.name,{seq:publication.seq});assert.deepEqual(Buffer.from(packet.data),body);assert.equal(packet.header.get("X-Alert-Snapshot-Probe"),"metadata-integrity");
  const secondPacket=await manager.streams.getMessage(streamConfig.name,{seq:secondPublication.seq});assert.deepEqual(Buffer.from(secondPacket.data),second);
  assert.equal(consumer.num_ack_pending,1);assert.equal(consumer.num_pending,1);
  for(const key of ["consumer_seq","stream_seq"]){assert.equal(consumer.delivered[key],metadata.consumer.delivered[key]);assert.equal(consumer.ack_floor[key],metadata.consumer.ack_floor[key]);}
  // AIDEV-NOTE: last_active — live diagnostic timestamp; server RESTORE сохраняет sequence positions и pending ACK, но не обещает этот timestamp.
 }finally{await nc.close();await rm(directory,{recursive:true,force:true});}
});

/** Подставляет только transport snapshot chunks для проверок ошибок и bounded ожидания. */
function snapshotPort(messages){
 const state={messages:0,bytes:0,first_seq:0,last_seq:0},consumer={name:consumerConfig.durable_name,config:consumerConfig,num_waiting:0};
 let release;const closed=new Promise(resolve=>{release=resolve;});
 return {options:{inboxPrefix:"_INBOX.snapshot_unit"},jetstreamManager:async()=>({streams:{info:async()=>({config:streamConfig,state})},consumers:{info:async()=>consumer}}),request:async()=>({data:Buffer.from(JSON.stringify({config:streamConfig,state}))}),subscribe:()=>({unsubscribe(){release();},async*[Symbol.asyncIterator](){if(messages)for(const message of messages)yield message;else await closed;}})};
}

test("snapshot rejects overflowing/error chunks and ends an incomplete transport at deadline",async()=>{
 const directory=await mkdtemp("/srv/projects/brai/tmp/alerts-backup-limits-");
 try{
  await assert.rejects(snapshot(snapshotPort([{data:Buffer.alloc(32)}]),directory+"/overflow.s2",{maxBytes:16}),/SNAPSHOT_SIZE_LIMIT/);
  await assert.rejects(readFile(directory+"/overflow.s2"),{code:"ENOENT"});
  await assert.rejects(snapshot(snapshotPort([{data:Buffer.alloc(0),headers:{code:408}}]),directory+"/server-error.s2"));
  await assert.rejects(readFile(directory+"/server-error.s2"),{code:"ENOENT"});
  await assert.rejects(snapshot(snapshotPort(null),directory+"/incomplete.s2",{deadlineMs:10}),/SNAPSHOT_NOT_COMPLETE/);
  await assert.rejects(readFile(directory+"/incomplete.s2"),{code:"ENOENT"});
 }finally{await rm(directory,{recursive:true,force:true});}
});
