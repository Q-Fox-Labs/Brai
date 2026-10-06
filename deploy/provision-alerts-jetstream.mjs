// ABOUTME: Выполняет явный будущий provision/verify alerts JetStream по восстановленному admin input.
// ABOUTME: Не изменяет существующие несовместимые объекты и не входит в runtime/restore.
import assert from "node:assert/strict";
import {readFile,lstat} from "node:fs/promises";
import {connect} from "nats";
import {streamConfig as stream,consumerConfig as consumer} from "./alerts-jetstream-config.mjs";

/** Прочитать фиксированный protected input, не публикуя адрес, credentials или server errors. */
async function settings(){
 const path="/srv/projects/brai/.secrets/alerts_jetstream_admin.env";
 const metadata=await lstat(path);
 assert.ok(metadata.isFile()&&metadata.uid===0&&metadata.gid===0&&(metadata.mode&0o777)===0o600);
 const values={};
 for(const line of (await readFile(path,"utf8")).split(/\r?\n/)){
  if(!line||line.startsWith("#"))continue;
  const at=line.indexOf("=");assert.ok(at>0);
  const key=line.slice(0,at);assert.ok(!(key in values));values[key]=line.slice(at+1);
 }
 const url=new URL(values.ALERTS_JETSTREAM_ADMIN_URL);
 assert.ok(url.protocol==="nats:"&&["127.0.0.1","localhost"].includes(url.hostname)&&url.port&&!url.username&&!url.password);
 assert.ok(values.ALERTS_JETSTREAM_ADMIN_USER&&values.ALERTS_JETSTREAM_ADMIN_PASSWORD);
 return {servers:url.href,user:values.ALERTS_JETSTREAM_ADMIN_USER,pass:values.ALERTS_JETSTREAM_ADMIN_PASSWORD,inboxPrefix:"_INBOX.brai_alerts_admin",timeout:5000,reconnect:false};
}

/** Добавить только отсутствующие objects либо сверить точное совпадение; mismatch требует отдельного решения. */
async function run(mode){
 assert.ok(["provision","verify"].includes(mode));
 const nc=await connect(await settings());
 try{
  const manager=await nc.jetstreamManager();
  if(mode==="provision"){
   try{await manager.streams.info(stream.name);}catch(error){if(error.code!=="404")throw error;await manager.streams.add({...stream,subjects:[...stream.subjects]});}
   try{await manager.consumers.info(stream.name,consumer.durable_name);}catch(error){if(error.code!=="404")throw error;await manager.consumers.add(stream.name,{...consumer});}
  }
  const actualStream=(await manager.streams.info(stream.name)).config,actualConsumer=(await manager.consumers.info(stream.name,consumer.durable_name)).config;
  for(const [key,value]of Object.entries(stream))assert.deepEqual(actualStream[key],value);
  for(const [key,value]of Object.entries(consumer))assert.deepEqual(actualConsumer[key],value);
  console.log("alerts JetStream accepted configuration verified");
 }finally{await nc.close();}
}
try{await run(process.argv[2]);}catch{console.error("ALERTS_JETSTREAM_OPERATION_FAILED");process.exitCode=1;}
