// ABOUTME: Сохраняет native snapshot только alerts stream вместе с durable consumer.
// ABOUTME: Не удаляет сообщения, не меняет конфигурацию и не останавливает runtime; запись требует quiet state.
import assert from "node:assert/strict";
import {readFile,lstat,open,unlink} from "node:fs/promises";
import {pathToFileURL} from "node:url";
import {connect,createInbox} from "nats";
import {streamConfig,consumerConfig} from "./alerts-jetstream-config.mjs";

/** Снять bounded native stream snapshot с consumer и проверить отсутствие изменений в quiet interval. */
export async function snapshot(nc,destination,{deadlineMs=120000,maxBytes=536870912}={}){
 assert.ok(Number.isSafeInteger(deadlineMs)&&deadlineMs>0&&deadlineMs<=120000);
 assert.ok(Number.isSafeInteger(maxBytes)&&maxBytes>0&&maxBytes<=536870912);
 const manager=await nc.jetstreamManager();
 const before=await manager.streams.info(streamConfig.name),consumer=await manager.consumers.info(streamConfig.name,consumerConfig.durable_name);
 for(const [key,value] of Object.entries(streamConfig))assert.deepEqual(before.config[key],value);
 for(const [key,value] of Object.entries(consumerConfig))assert.deepEqual(consumer.config[key],value);
 assert.equal(consumer.num_waiting,0,"QUIESCED_CONSUMER_REQUIRED");
 const target=await open(destination,"wx",0o600),deliver=createInbox(nc.options.inboxPrefix),subscription=nc.subscribe(deliver);
 let size=0,complete=false,api;
 const timeout=setTimeout(()=>subscription.unsubscribe(),deadlineMs);
 try{
  const chunks=(async()=>{
   for await(const message of subscription){
    if(message.data.length===0){assert.ok(!message.headers||Number(message.headers.code)<400);complete=true;subscription.unsubscribe();break;}
    size+=message.data.length;assert.ok(size<=maxBytes,"SNAPSHOT_SIZE_LIMIT");
    let offset=0;while(offset<message.data.length){const result=await target.write(message.data,offset,message.data.length-offset);assert.ok(result.bytesWritten>0);offset+=result.bytesWritten;}
    if(message.reply)message.respond();
   }
  })();
  chunks.catch(()=>{});
  const response=await nc.request(`$JS.API.STREAM.SNAPSHOT.${streamConfig.name}`,Buffer.from(JSON.stringify({deliver_subject:deliver,no_consumers:false,chunk_size:65536,window_size:1048576,jsck:true})),{timeout:30000});
  api=JSON.parse(Buffer.from(response.data).toString());assert.ok(!api.error);
  await chunks;assert.ok(complete&&size>0,"SNAPSHOT_NOT_COMPLETE");await target.sync();
  const after=await manager.streams.info(streamConfig.name),afterConsumer=await manager.consumers.info(streamConfig.name,consumerConfig.durable_name);
  for(const key of ["messages","bytes","first_seq","last_seq"])assert.equal(before.state[key],api.state[key]),assert.equal(api.state[key],after.state[key]);
  for(const key of ["config","delivered","ack_floor","num_ack_pending","num_pending","num_redelivered"])assert.deepEqual(consumer[key],afterConsumer[key]);
  assert.equal(afterConsumer.num_waiting,0);
  return {format:"nats-native-s2-stream-snapshot",bytes:size,stream:api,consumer};
 }catch(error){await unlink(destination).catch(()=>{});throw error;}
 finally{clearTimeout(timeout);subscription.unsubscribe();await target.close();}
}

/** Machine-only restored snapshot admin input; production values never reach output. */
async function configuration(){
 const path="/srv/projects/brai/.secrets/alerts_jetstream_admin.env",metadata=await lstat(path);
 assert.ok(metadata.isFile()&&metadata.uid===0&&metadata.gid===0&&(metadata.mode&0o777)===0o600);
 const values={};for(const line of(await readFile(path,"utf8")).split(/\r?\n/)){if(!line||line.startsWith("#"))continue;const at=line.indexOf("=");assert.ok(at>0);const key=line.slice(0,at);assert.ok(!(key in values));values[key]=line.slice(at+1);}
 const url=new URL(values.ALERTS_JETSTREAM_ADMIN_URL);assert.ok(url.protocol==="nats:"&&["127.0.0.1","localhost"].includes(url.hostname)&&url.port&&!url.username&&!url.password);
 assert.ok(values.ALERTS_JETSTREAM_ADMIN_USER&&values.ALERTS_JETSTREAM_ADMIN_PASSWORD);
 return {servers:url.href,user:values.ALERTS_JETSTREAM_ADMIN_USER,pass:values.ALERTS_JETSTREAM_ADMIN_PASSWORD,inboxPrefix:"_INBOX.brai_alerts_backup",timeout:5000,reconnect:false};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{
  const destination=process.argv[2],fixture=destination==="/srv/projects/brai/tmp/alerts-jetstream-snapshot-test.s2";
  assert.ok(fixture||/^\/srv\/projects\/brai\/\.secrets\/alerts_backups\/[0-9]{8}T[0-9]{6}Z\/jetstream\.s2$/.test(destination));
  const nc=await connect(fixture?{servers:"nats://127.0.0.1:24341",user:"fixture",pass:"alerts-test",inboxPrefix:"_INBOX.brai_alerts_backup",timeout:5000,reconnect:false}:await configuration());
  try{console.log(JSON.stringify(await snapshot(nc,destination)));}finally{await nc.close();}
 }catch{console.error("ALERTS_JETSTREAM_SNAPSHOT_FAILED");process.exitCode=1;}
}
