// ABOUTME: Предоставляет отсутствующих соседей только disposable тестовому окружению.
// ABOUTME: Intent, результат и ответ агента сохраняются в собственных fixture таблицах.
import {randomUUID} from 'node:crypto';
import {contactResult} from '../contact-fixture.mjs';
import {channelResult} from '../channel-fixture.mjs';
import {inputHash} from '../../dist/contracts.js';
export async function startPeers(nc,pool,{holdMemory=false,realChannels=false,realContacts=false,realHistory=false,beforeDeliver}={}){
 await pool.query('CREATE SCHEMA IF NOT EXISTS intake_fixture');
 await pool.query('CREATE TABLE IF NOT EXISTS intake_fixture.jobs(id text PRIMARY KEY, hash text NOT NULL, body jsonb NOT NULL, published boolean NOT NULL DEFAULT false)');
 await pool.query('CREATE TABLE IF NOT EXISTS intake_fixture.inbox(id text PRIMARY KEY, hash text NOT NULL, body jsonb NOT NULL)');
 await pool.query('CREATE TABLE IF NOT EXISTS intake_fixture.effects(id text PRIMARY KEY, kind text NOT NULL)');
 await pool.query('CREATE TABLE IF NOT EXISTS intake_fixture.channel_cache(id text PRIMARY KEY, hash text NOT NULL, body jsonb NOT NULL)');
 const service=await nc.services.add({name:'intake_fixture',version:'1.0.0'});
 let releaseMemory;const memoryGate=holdMemory?new Promise(r=>{releaseMemory=r;}):Promise.resolve();
 const tasks=new Set(), errors=[];
 const event=(source,type,data,base)=>({version:1,eventId:randomUUID(),source,type,occurredAt:new Date().toISOString(),correlationId:base.event.correlationId,causationId:base.packetId,data});
 const publish=async e=>{await nc.jetstream().publish('brai.intake.v1.ingress.'+e.source,Buffer.from(JSON.stringify(e)),{msgID:e.source+'/'+e.eventId});};
 async function notify(row){
  if(row.body.kind==='deliver'&&beforeDeliver)await beforeDeliver(row.body.packet);
  if(row.body.kind==='memory')await memoryGate;
  if(row.body.output)await publish(row.body.output);
  await pool.query('INSERT INTO intake_fixture.effects(id,kind) VALUES($1,$2) ON CONFLICT DO NOTHING',[row.id,row.body.kind]);
  await publish(row.body.result);
  await pool.query('UPDATE intake_fixture.jobs SET published=true WHERE id=$1',[row.id]);
 }
 function launch(row){const work=notify(row).catch(e=>errors.push(e)).finally(()=>tasks.delete(work));tasks.add(work);}
 function endpoint(name,work){
  service.addEndpoint(name,{subject:'brai.fixture.'+name,handler:async(_err,msg)=>{
   try{const p=JSON.parse(new TextDecoder().decode(msg.data));const out=await work(p);msg.respond(Buffer.from(JSON.stringify(out)));}
   catch{msg.respondError(500,'FIXTURE_FAILED');}
  }});
 }
 if(!realChannels)endpoint('channel',async q=>{
  const parent=q.replyTo?(await pool.query("SELECT body FROM intake_fixture.channel_cache WHERE body->>'resolutionId'=$1",[q.replyTo.resolutionId])).rows[0]?.body:null;
  const value=channelResult(q,parent);
  const row=(await pool.query('INSERT INTO intake_fixture.channel_cache(id,hash,body) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET id=EXCLUDED.id RETURNING *',[q.operationId,inputHash(q),value])).rows[0];
  if(row.hash!==inputHash(q))throw Error('CHANNEL_INPUT_CONFLICT');return row.body;
 });
 if(!realContacts)endpoint('contact',async q=>{
  const row=(await pool.query('INSERT INTO intake_fixture.channel_cache(id,hash,body) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET id=EXCLUDED.id RETURNING *',['contact/'+q.operationId,inputHash(q),contactResult(q)])).rows[0];
  if(row.hash!==inputHash(q))throw Error('CONTACT_INPUT_CONFLICT');return row.body;
 });
 endpoint('inbox',async p=>{
  const result=await pool.query('INSERT INTO intake_fixture.inbox(id,hash,body) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET id=EXCLUDED.id RETURNING hash',[p.packetId,inputHash(p.prepared),p.prepared]);
  if(result.rows[0].hash!==inputHash(p.prepared))throw Error('FIXTURE_CONFLICT');
  return {messageId:p.packetId};
 });
 for(const kind of ['hermes','understand','memory','deliver'])endpoint(kind,async p=>{
  const output=kind==='hermes'?event('fixture_hermes','message.outgoing',{materialId:'response/'+p.packetId,revision:1,conversationId:p.event.data.conversationId,replyToMessageId:p.inboxRef.messageId,author:{kind:'agent',id:'hermes'},sourceRef:p.event.data.sourceRef,text:'Ответ Hermes',attachments:[]},p):null;
  const value=kind==='hermes'?{outputs:[output.eventId]}:kind==='deliver'?{receiptRef:randomUUID()}:{resultRef:randomUUID(),provenance:{packetId:p.packetId,materialId:p.event.data.materialId,revision:p.event.data.revision,inputHash:inputHash(p.event)},...(kind==='memory'?{understandingRef:p.priorResults.find(r=>r.kind==='understand')?.result.resultRef}:{})};
  const result=event('fixture_'+kind,'operation.result',{packetId:p.packetId,operationId:p.operationId,outcome:'succeeded',result:value},p);
  const row=(await pool.query('INSERT INTO intake_fixture.jobs(id,hash,body) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET id=EXCLUDED.id RETURNING *',[p.operationId,inputHash(p),{kind,output,result,packet:p}])).rows[0];
  if(row.hash!==inputHash(p))throw Error('FIXTURE_CONFLICT');
  launch(row);return {accepted:true,operationId:p.operationId};
 });
 if(!realHistory)service.addEndpoint('history',{subject:'brai.history.v1.append.service_intake',handler:async(_err,msg)=>{
  try{const e=JSON.parse(new TextDecoder().decode(msg.data));if(!e.id||e.source||![1105,1106].includes(e.type_id)||e.data.text)throw Error();await pool.query('INSERT INTO intake_fixture.effects(id,kind) VALUES($1,$2) ON CONFLICT DO NOTHING',[e.id,'history']);msg.respond(Buffer.from(JSON.stringify({event:{...e,source:'service_intake'}})));}catch{msg.respondError(400,'INVALID_HISTORY');}
 }});
 for(const row of (await pool.query('SELECT * FROM intake_fixture.jobs WHERE NOT published')).rows)launch(row);
 return {releaseMemory(){releaseMemory?.();},errors,async close(){releaseMemory?.();await Promise.allSettled(tasks);await service.stop();}};
}
