// ABOUTME: Подготавливает или сверяет закреплённый stream и consumer alerts.
// ABOUTME: Provision требует отдельного операторского разрешения; runtime не создаёт JetStream objects.
import assert from "node:assert/strict";
import {connect} from "nats";
import {streamConfig as stream,consumerConfig as consumer} from "./alerts-jetstream-config.mjs";
const mode=process.argv[2];
assert.ok(["provision-fixture","verify-fixture"].includes(mode),"Explicit isolated fixture operation required");
const nc=await connect({servers:"nats://127.0.0.1:24341",user:"fixture",pass:"alerts-test",inboxPrefix:"_INBOX.brai_alerts_fixture",timeout:5000,reconnect:false});
try {
  const manager=await nc.jetstreamManager();
  if(mode==="provision-fixture") {
    try { await manager.streams.info(stream.name); } catch(error) { if(error.code!=="404")throw error;await manager.streams.add({...stream,subjects:[...stream.subjects]}); }
    try { await manager.consumers.info(stream.name,consumer.durable_name); } catch(error) { if(error.code!=="404")throw error;await manager.consumers.add(stream.name,{...consumer}); }
  }
  const s=(await manager.streams.info(stream.name)).config,c=(await manager.consumers.info(stream.name,consumer.durable_name)).config;
  for(const [key,value] of Object.entries(stream))assert.deepEqual(s[key],value,`Stream mismatch: ${key}`);
  for(const [key,value] of Object.entries(consumer))assert.deepEqual(c[key],value,`Consumer mismatch: ${key}`);
  console.log("alerts JetStream configuration verified");
} finally {await nc.close();}
