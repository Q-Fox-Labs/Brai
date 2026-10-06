// ABOUTME: Проверяет транзакции, повторы, чтения и реальную доставку JetStream.
// ABOUTME: Работает только с явно переданной отдельной БД brai_timer_test, не с рабочей средой.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { migrate } from '../../dist/migrate.js';
import { createStore } from '../../dist/storage.js';
import { config } from '../../dist/config.js';
import { connectNats,setupJetStream,runNats,commandsStream,commandsConsumer,eventsStream } from '../../dist/nats.js';
import { handleDelivery } from '../../dist/flow.js';
import { AckPolicy, connect, DeliverPolicy, nanos, ReplayPolicy } from 'nats';
const ownerURL=process.env.TIMER_TEST_OWNER_URL,appURL=process.env.TIMER_TEST_DATABASE_URL,natsURL=process.env.TIMER_TEST_NATS_URL;
if(!ownerURL||!appURL||!natsURL||new URL(ownerURL).pathname!='/brai_timer_test'||new URL(appURL).pathname!='/brai_timer_test')throw new Error('EXPLICIT_ISOLATED_TIMER_TEST_URLS_REQUIRED');
const owner=new Pool({connectionString:ownerURL}),app=new Pool({connectionString:appURL,max:8});
const store=createStore(app);
let seq=0;
const delivery=(subject,body,key=`direct:${++seq}`)=>({subject:`brai.timer.v2.command.${subject}`,data:Buffer.from(typeof body==='string'?body:JSON.stringify(body)),key});
const start=(version,id=randomUUID())=>({userId:'user-a',commandId:id,expectedVersion:version});
const stop=(version,timerId,id=randomUUID())=>({userId:'user-a',commandId:id,expectedVersion:version,timerId});
const edit=(version,timerId,startedAt,stoppedAt,id=randomUUID())=>({userId:'user-a',commandId:id,timerId,expectedVersion:version,startedAt,stoppedAt});
const remove=(version,timerId,id=randomUUID())=>({userId:'user-a',commandId:id,timerId,expectedVersion:version});
const cfg=config({DATABASE_URL:appURL,NATS_URL:natsURL,NATS_USER:'timer',NATS_PASSWORD:'fixture-timer',TIMER_ACK_WAIT_MS:'500'});
const ajv=new Ajv({strict:false});addFormats(ajv);
for(const name of ['common','commands','messages'])ajv.addSchema(JSON.parse(readFileSync(new URL(`../../schemas/${name}.schema.json`,import.meta.url),'utf8')));
const schema=name=>ajv.compile({$ref:`https://brai.invalid/contracts/timer/v2/messages.schema.json#/definitions/${name}`});
const reset=async()=>{await owner.query('TRUNCATE timer.commands,timer.state,timer.intervals,timer.interval_facts CASCADE');};
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){const deadline=Date.now()+7000;let last;while(Date.now()<deadline){try{const result=await fn();if(result)return result;}catch(error){last=error;}await wait(30);}throw last??new Error('test deadline');}
function key(msg){return `${msg.info.stream}:${msg.info.streamSequence}`;}
async function message(nc){const consumer=await nc.jetstream().consumers.get(commandsStream,commandsConsumer);const msg=await consumer.next({expires:3000});assert.ok(msg,'real durable delivery required');return msg;}
const publish=(nc,result)=>nc.jetstream().publish(result.subject,Buffer.from(JSON.stringify(result.event)),{msgID:result.event.eventId});
const processMsg=(nc,msg,ports={})=>handleDelivery({subject:msg.subject,data:msg.data,key:key(msg)},{save:store.process,publish:result=>publish(nc,result),ack:()=>msg.ack(),...ports});
async function connectWeb(){return connect({servers:natsURL,user:'web',pass:'fixture-web',inboxPrefix:'_INBOX.brai_web'});}
async function lookup(web,commandId){const reply=await web.request('brai.timer.v2.query.command',Buffer.from(JSON.stringify({userId:'user-a',commandId})),{timeout:1000});if(reply.headers?.get('Nats-Service-Error-Code'))return null;return JSON.parse(reply.string());}

test('настоящий PostgreSQL и NATS выполняют контракт',async t=>{
 try{
  await t.test('миграция повторяема, роль приложения не получает DDL, чужие данные или удаление журнала',async()=>{
   await owner.query('DROP SCHEMA IF EXISTS timer CASCADE');
   await owner.query(readFileSync(new URL('../../migrations/001.sql',import.meta.url),'utf8'));
   await owner.query('INSERT INTO timer.intervals(timer_id,started_at) VALUES($1,now())',[randomUUID()]);
   await assert.rejects(migrate(owner,'timer_owner','timer_app'),/TIMER_V1_DATA_REQUIRES_EXPLICIT_RESET/);
   assert.equal((await owner.query('SELECT count(*) FROM timer.intervals')).rows[0].count,'1');
   await owner.query('TRUNCATE timer.intervals CASCADE');
   await owner.query(readFileSync(new URL('../../migrations/002.sql',import.meta.url),'utf8'));
   const legacyTimer=randomUUID();await owner.query("INSERT INTO timer.intervals(user_id,timer_id,started_at,stopped_at,duration_ms) VALUES('user-a',$1,'2026-01-01T00:00:00Z','2026-01-01T00:00:01Z',999)",[legacyTimer]);
   await owner.query("CREATE TABLE timer.sys_challenge(singleton boolean PRIMARY KEY,start_date date,end_date_exclusive date,time_zone text,days integer,daily_target_ms bigint,target_ms bigint); INSERT INTO timer.sys_challenge VALUES(true,'2026-10-04','2026-11-01','Europe/Moscow',27,28800000,806400000)");
   await assert.rejects(migrate(owner,'timer_owner','timer_app'),/TIMER_CHALLENGE_CONFIGURATION_CONFLICT/);
   assert.equal((await owner.query('SELECT days FROM timer.sys_challenge')).rows[0].days,27);
   await owner.query('DROP TABLE timer.sys_challenge');
   await migrate(owner,'timer_owner','timer_app');await migrate(owner,'timer_owner','timer_app');
   assert.equal((await owner.query('SELECT count(*) FROM timer.migrations')).rows[0].count,'4');
   assert.deepEqual((await owner.query('SELECT original_started_at,original_stopped_at,original_duration_ms FROM timer.interval_facts WHERE user_id=$1 AND timer_id=$2',['user-a',legacyTimer])).rows[0],{original_started_at:new Date('2026-01-01T00:00:00.000Z'),original_stopped_at:new Date('2026-01-01T00:00:01.000Z'),original_duration_ms:'999'});
   for(const sql of ['CREATE TABLE timer.forbidden(id integer)','CREATE TABLE public.forbidden(id integer)','DELETE FROM timer.commands','UPDATE timer.commands SET content=content','UPDATE timer.interval_facts SET original_duration_ms=original_duration_ms','DELETE FROM timer.interval_facts','UPDATE timer.sys_challenge SET days=days','DELETE FROM timer.sys_challenge','INSERT INTO timer.sys_challenge SELECT * FROM timer.sys_challenge','SELECT * FROM private_fixture.foreign_data'])await assert.rejects(app.query(sql),error=>error.code==='42501');
   assert.equal((await app.query('SELECT count(*) FROM timer.interval_facts')).rows[0].count,'1');
   const actor=new Pool({connectionString:ownerURL.replace('timer_owner:fixture-owner','supabase_actor:fixture-actor')});
   try{await assert.rejects(actor.query('SELECT 1'),error=>error.code==='42501');}finally{await actor.end();}
   await assert.rejects(owner.query("INSERT INTO timer.intervals(user_id,timer_id,started_at,stopped_at,duration_ms) VALUES('user-a',$1,now(),now(),NULL)",[randomUUID()]),error=>error.code==='23514');
  });
  await t.test('конкурентный повтор, порядок ключей, конфликт ID, устаревшая версия и старый STOP',async()=>{
   await reset();const command=start(0);
   const results=await Promise.all([store.process(delivery('start',command)),store.process(delivery('start',{userId:'user-a',expectedVersion:0,commandId:command.commandId}))]);
   assert.deepEqual(results[0].event,results[1].event);assert.equal((await store.snapshot('user-a')).version,1);
   assert.equal((await owner.query('SELECT count(*) FROM timer.commands')).rows[0].count,'1');
   assert.equal((await owner.query('SELECT count(*) FROM timer.intervals WHERE stopped_at IS NULL')).rows[0].count,'1');
   const conflict=delivery('start',{...command,unexpected:true});const first=await store.process(conflict),again=await store.process(conflict);
   assert.equal(first.event.error.code,'COMMAND_ID_CONFLICT');assert.deepEqual(first.event,again.event);assert.equal(first.event.commandId,command.commandId);
   assert.notEqual((await store.process({...conflict,key:'direct:new-conflict'})).event.eventId,first.event.eventId);
   assert.deepEqual((await store.command('user-a',command.commandId)).result,results[0].event);
   assert.equal((await store.process(delivery('stop',{...command,timerId:results[0].event.timerId}))).event.error.code,'COMMAND_ID_CONFLICT');
   const stale=delivery('start',start(0));const old=await store.process(stale);assert.equal(old.event.error.code,'VERSION_CONFLICT');
   assert.equal((await store.process(delivery('start',start(1)))).event.error.code,'TIMER_ALREADY_ACTIVE');
   const stopped=await store.process(delivery('stop',stop(1,results[0].event.timerId)));assert.ok(schema('StoppedEvent')(stopped.event));
   const next=await store.process(delivery('start',start(2)));
   assert.equal((await store.process(delivery('stop',stop(3,results[0].event.timerId)))).event.error.code,'TIMER_NOT_ACTIVE');
   assert.equal((await store.snapshot('user-a')).active.timerId,next.event.timerId);
   assert.deepEqual((await store.process(stale)).event,old.event);
   const malformed=delivery('start',{userId:'user-a',invalid:true});const bad=await store.process(malformed);assert.equal(bad.event.commandId,null);assert.equal(bad.event.correlationId,malformed.key);assert.deepEqual((await store.process(malformed)).event,bad.event);
   const parallel=await Promise.all([store.process(delivery('stop',stop(3,next.event.timerId))),store.process(delivery('stop',stop(3,next.event.timerId)))]);assert.equal(parallel.filter(r=>r.subject.endsWith('.stopped')).length,1);assert.equal(parallel.filter(r=>r.event.error?.code==='VERSION_CONFLICT').length,1);assert.equal((await store.snapshot('user-a')).version,4);
  });
  await t.test('два владельца разделяют timerId, commandId, историю, курсоры и повторную доставку',async()=>{
   await reset();const timerId=randomUUID(),commandId=randomUUID();
   const command={userId:'user-a',commandId,timerId,startedAt:'2026-01-01T00:00:00.000Z'};
   const a=await store.process(delivery('start',command));
   const b=await store.process(delivery('start',{...command,userId:'user-b'}));
   assert.equal(a.event.userId,'user-a');assert.equal(b.event.userId,'user-b');
   assert.equal((await store.snapshot('user-b')).active.timerId,timerId);
   await migrate(owner,'timer_owner','timer_app');
   assert.equal((await store.snapshot('user-b')).version,1);
   await assert.rejects(store.command('user-c',commandId),/NOT_FOUND/);
   assert.equal((await store.command('user-b',commandId)).result.eventId,b.event.eventId);
   const stopId=randomUUID();
   await store.process(delivery('stop',{userId:'user-a',commandId:stopId,timerId,stoppedAt:'2026-01-01T00:00:01.000Z'}));
   assert.equal((await store.history('user-a',10)).items.length,1);
   assert.equal((await store.history('user-b',10)).items.length,0);
   assert.equal((await store.snapshot('user-b')).version,1);
   assert.deepEqual((await store.process(delivery('start',command))).event,a.event);
   const foreignCursor=Buffer.from(JSON.stringify(['user-a',command.startedAt,timerId])).toString('base64url');
   await assert.rejects(store.history('user-b',10,foreignCursor),/INVALID_ARGUMENT/);
   await assert.rejects(store.process(delivery('start',{commandId,timerId,startedAt:command.startedAt})),/INVALID_OWNER/);
   const before=(await store.snapshot('user-b')).active;
   await store.process(delivery('stop',{userId:'user-c',commandId:randomUUID(),timerId,stoppedAt:'2026-01-01T00:00:02.000Z'}));
   assert.deepEqual((await store.snapshot('user-b')).active,before);
  });
  await t.test('сбой до commit откатывает интервал, state и ledger вместе',async()=>{
   await reset();await owner.query("CREATE OR REPLACE FUNCTION timer.fixture_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture precommit'; END $$; CREATE TRIGGER fixture_fail BEFORE INSERT ON timer.commands FOR EACH ROW EXECUTE FUNCTION timer.fixture_fail()");
   const input=delivery('start',start(0));try{await assert.rejects(store.process(input));assert.equal((await store.snapshot('user-a')).version,0);assert.equal((await owner.query('SELECT count(*) FROM timer.intervals')).rows[0].count,'0');assert.equal((await owner.query('SELECT count(*) FROM timer.commands')).rows[0].count,'0');}finally{await owner.query('DROP TRIGGER fixture_fail ON timer.commands; DROP FUNCTION timer.fixture_fail()');}
   assert.equal((await store.process(input)).event.version,1);
  });
  await t.test('согласованный snapshot, непрозрачные курсоры и устойчивые страницы завершённой истории',async()=>{
   await reset();let version=0;
   for(let i=0;i<55;i++){const begun=await store.process(delivery('start',start(version++)));await store.process(delivery('stop',stop(version++,begun.event.timerId)));}
   const snapshot=await store.snapshot('user-a');assert.ok(schema('SnapshotResponse')(snapshot),JSON.stringify(schema('SnapshotResponse').errors));assert.equal(snapshot.recentCompleted.length,50);assert.ok(snapshot.nextCursor);assert.equal(snapshot.version,110);assert.equal(snapshot.active,null);
   const tail=await store.history('user-a',10,snapshot.nextCursor);assert.equal(tail.items.length,5);assert.equal(tail.nextCursor,null);
   const first=await store.history('user-a',7);const second=await store.history('user-a',7,first.nextCursor);assert.equal(new Set([...first.items,...second.items].map(i=>i.timerId)).size,14);
   const newStart=await store.process(delivery('start',start(version++)));await store.process(delivery('stop',stop(version++,newStart.event.timerId)));
   assert.deepEqual(await store.history('user-a',7,first.nextCursor),second);
   for(const args of [[0],[101],[1,'garbage'],[1,Buffer.from('["date","uuid"]').toString('base64url')]])await assert.rejects(store.history('user-a',...args),/INVALID_ARGUMENT/);
   await assert.rejects(store.command('user-a',randomUUID()),/NOT_FOUND/);
   const checks=[];
   for(let i=0;i<8;i++){const command=start(version++);const pending=store.process(delivery('start',command));checks.push(store.snapshot('user-a').then(s=>{assert.equal(s.recentCompleted.length,50);assert.equal(Boolean(s.active),s.version%2===1);}));const begun=await pending;const ending=store.process(delivery('stop',stop(version++,begun.event.timerId)));checks.push(store.snapshot('user-a').then(s=>assert.equal(Boolean(s.active),s.version%2===1)));await ending;}
   await Promise.all(checks);
  });
  await t.test('конкурирующие edit применяют только одну owner-version правку',async()=>{
   await reset();const begun=await store.process(delivery('start',{userId:'user-a',commandId:randomUUID(),timerId:randomUUID(),startedAt:'2026-01-01T00:00:00.000Z'}));await store.process(delivery('stop',{userId:'user-a',commandId:randomUUID(),timerId:begun.event.timerId,stoppedAt:'2026-01-01T00:00:01.000Z'}));
   const outcomes=await Promise.all([store.process(delivery('edit',edit(2,begun.event.timerId,'2026-01-01T00:00:02.000Z','2026-01-01T00:00:04.000Z'))),store.process(delivery('edit',edit(2,begun.event.timerId,'2026-01-01T00:00:05.000Z','2026-01-01T00:00:06.000Z')))]);
   assert.equal(outcomes.filter(x=>x.event.operation==='edit').length,1);assert.equal(outcomes.filter(x=>x.event.error?.code==='VERSION_CONFLICT').length,1);assert.equal((await store.snapshot('user-a')).version,3);assert.equal((await store.snapshot('user-a')).historyRevision,1);
  });
  await t.test('edit/delete соблюдают owner CAS, пересечения, ledger, soft-delete и факты исходной сессии',async()=>{
   await reset();
   const firstStart=await store.process(delivery('start',{userId:'user-a',commandId:randomUUID(),timerId:randomUUID(),startedAt:'2026-01-01T00:00:00.000Z'}));
   const firstStop=await store.process(delivery('stop',{userId:'user-a',commandId:randomUUID(),timerId:firstStart.event.timerId,stoppedAt:'2026-01-01T00:00:10.000Z'}));
   const secondStart=await store.process(delivery('start',{userId:'user-a',commandId:randomUUID(),timerId:randomUUID(),startedAt:'2026-01-01T00:00:20.000Z'}));
   await store.process(delivery('stop',{userId:'user-a',commandId:randomUUID(),timerId:secondStart.event.timerId,stoppedAt:'2026-01-01T00:00:30.000Z'}));
   const expected=4,command=edit(expected,firstStart.event.timerId,'2026-01-01T00:00:10.000Z','2026-01-01T00:00:20.000Z'),input=delivery('edit',command,'direct:edit-touching');
   const changed=await store.process(input);assert.ok(schema('TimerEditedEvent')(changed.event));assert.equal(changed.event.version,5);assert.equal(changed.event.interval.durationMs,10000);
   const replay=await store.process(input);assert.deepEqual(replay.event,changed.event);assert.equal(replay.duplicate,true);assert.equal((await store.snapshot('user-a')).version,5);
   const conflict=await store.process(delivery('edit',{...command,stoppedAt:'2026-01-01T00:00:21.000Z'},'direct:edit-command-id-conflict'));assert.equal(conflict.event.error.code,'COMMAND_ID_CONFLICT');
   assert.equal((await store.command('user-a',firstStop.event.commandId)).result.interval.stoppedAt,'2026-01-01T00:00:10.000Z');
   const overlapsCompleted=await store.process(delivery('edit',edit(5,secondStart.event.timerId,'2026-01-01T00:00:19.000Z','2026-01-01T00:00:30.000Z')));assert.equal(overlapsCompleted.event.error.code,'INTERVAL_OVERLAP');
   const active=await store.process(delivery('start',{userId:'user-a',commandId:randomUUID(),timerId:randomUUID(),startedAt:'2026-01-01T00:00:40.000Z'}));
   const overlapsActive=await store.process(delivery('edit',edit(6,secondStart.event.timerId,'2026-01-01T00:00:39.000Z','2026-01-01T00:00:41.000Z')));assert.equal(overlapsActive.event.error.code,'INTERVAL_OVERLAP');
   const missing=await store.process(delivery('delete',remove(6,randomUUID())));assert.equal(missing.event.error.code,'NOT_FOUND');
   const notActive=await store.process(delivery('delete',remove(6,active.event.timerId)));assert.equal(notActive.event.error.code,'NOT_FOUND');
   const foreignId=randomUUID();const foreignStart=await store.process(delivery('start',{userId:'user-b',commandId:randomUUID(),timerId:foreignId,startedAt:'2026-01-01T00:00:40.000Z'}));await store.process(delivery('stop',{userId:'user-b',commandId:randomUUID(),timerId:foreignStart.event.timerId,stoppedAt:'2026-01-01T00:00:41.000Z'}));
   const foreignCommand=remove(6,foreignId),foreign=await store.process(delivery('delete',foreignCommand));assert.equal(foreign.event.error.code,'NOT_FOUND');
   const sameCommandOtherOwner=await store.process(delivery('delete',{...foreignCommand,userId:'user-b',expectedVersion:2}));assert.equal(sameCommandOtherOwner.event.operation,'delete');
   assert.equal((await store.command('user-a',foreignCommand.commandId)).result.error.code,'NOT_FOUND');assert.equal((await store.command('user-b',foreignCommand.commandId)).result.operation,'delete');
   const deleted=await store.process(delivery('delete',remove(6,firstStart.event.timerId)));assert.ok(schema('TimerDeletedEvent')(deleted.event));assert.equal(deleted.event.version,7);
   const deletedAgain=await store.process(delivery('delete',remove(7,firstStart.event.timerId)));assert.equal(deletedAgain.event.error.code,'NOT_FOUND');
   const snapshot=await store.snapshot('user-a');assert.equal(snapshot.version,7);assert.equal(snapshot.historyRevision,2);assert.equal(snapshot.active.timerId,active.event.timerId);assert.equal(snapshot.totalCompletedMs,10000);assert.deepEqual(snapshot.recentCompleted.map(x=>x.timerId),[secondStart.event.timerId]);
   const baseline=(await owner.query('SELECT original_started_at,original_stopped_at,original_duration_ms FROM timer.interval_facts WHERE user_id=$1 AND timer_id=$2',['user-a',firstStart.event.timerId])).rows[0];
   assert.deepEqual(baseline,{original_started_at:new Date('2026-01-01T00:00:00.000Z'),original_stopped_at:new Date('2026-01-01T00:00:10.000Z'),original_duration_ms:'10000'});
  });
  await t.test('legacy projection без исходного ledger получает неизменяемую baseline до edit и rollback откатывает всё',async()=>{
   await reset();const timerId=randomUUID(),original={startedAt:'2026-02-01T00:00:00.000Z',stoppedAt:'2026-02-01T00:00:01.000Z',durationMs:777};
   await owner.query('INSERT INTO timer.intervals(user_id,timer_id,started_at,stopped_at,duration_ms) VALUES($1,$2,$3,$4,$5)',['user-a',timerId,original.startedAt,original.stoppedAt,original.durationMs]);
   await owner.query("CREATE OR REPLACE FUNCTION timer.fixture_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture precommit'; END $$; CREATE TRIGGER fixture_fail BEFORE INSERT ON timer.commands FOR EACH ROW EXECUTE FUNCTION timer.fixture_fail()");
   const input=delivery('edit',edit(0,timerId,'2026-02-01T00:00:02.000Z','2026-02-01T00:00:04.000Z'));
   try{await assert.rejects(store.process(input));}finally{await owner.query('DROP TRIGGER fixture_fail ON timer.commands; DROP FUNCTION timer.fixture_fail()');}
   assert.equal((await owner.query('SELECT started_at FROM timer.intervals WHERE user_id=$1 AND timer_id=$2',['user-a',timerId])).rows[0].started_at.toISOString(),original.startedAt);
   assert.equal((await owner.query('SELECT count(*) FROM timer.interval_facts WHERE user_id=$1 AND timer_id=$2',['user-a',timerId])).rows[0].count,'0');
   assert.equal((await store.snapshot('user-a')).version,0);
   const saved=await store.process(input);assert.ok(schema('TimerEditedEvent')(saved.event));
   assert.deepEqual((await owner.query('SELECT original_started_at,original_stopped_at,original_duration_ms FROM timer.interval_facts WHERE user_id=$1 AND timer_id=$2',['user-a',timerId])).rows[0],{original_started_at:new Date(original.startedAt),original_stopped_at:new Date(original.stoppedAt),original_duration_ms:'777'});
  });
  await t.test('history cursor changes only after edit/delete, not after START/STOP',async()=>{
   await reset();let version=0;const ids=[];
   for(let i=0;i<3;i++){const timerId=randomUUID(),startAt=`2026-03-01T00:00:0${i*2}.000Z`,stopAt=`2026-03-01T00:00:0${i*2+1}.000Z`;const begun=await store.process(delivery('start',{userId:'user-a',commandId:randomUUID(),timerId,startedAt:startAt}));await store.process(delivery('stop',{userId:'user-a',commandId:randomUUID(),timerId:begun.event.timerId,stoppedAt:stopAt}));ids.push(timerId);version+=2;}
   const first=await store.history('user-a',1),oldCursor=first.nextCursor;assert.ok(oldCursor);
   const extra=await store.process(delivery('start',{userId:'user-a',commandId:randomUUID(),timerId:randomUUID(),startedAt:'2026-04-01T00:00:00.000Z'}));await store.process(delivery('stop',{userId:'user-a',commandId:randomUUID(),timerId:extra.event.timerId,stoppedAt:'2026-04-01T00:00:01.000Z'}));version+=2;
   assert.equal((await store.history('user-a',1,oldCursor)).historyRevision,0);
   await store.process(delivery('edit',edit(version,ids[0],'2026-05-01T00:00:00.000Z','2026-05-01T00:00:01.000Z')));
   await assert.rejects(store.history('user-a',1,oldCursor),/HISTORY_CHANGED/);
   await assert.rejects(store.history('user-a',1,Buffer.from(JSON.stringify(['user-a',0,'invalid-date',ids[0]])).toString('base64url')),/INVALID_ARGUMENT/);
   await assert.rejects(store.history('user-a',1,Buffer.from(JSON.stringify(['user-a',-1,'2026-03-01T00:00:00.000Z',ids[0]])).toString('base64url')),/INVALID_ARGUMENT/);
  });
  await t.test('полная statistics сохраняет миллисекунды, календарные границы и пересчёт после edit/delete',async()=>{
   await reset();
   async function completed(startedAt,stoppedAt){
    const timerId=randomUUID();
    await store.process(delivery('start',{userId:'user-a',commandId:randomUUID(),timerId,startedAt}));
    await store.process(delivery('stop',{userId:'user-a',commandId:randomUUID(),timerId,stoppedAt}));
    return timerId;
   }
   for(let i=0;i<55;i++){
    const startAt=Date.parse('2026-09-01T00:00:00.000Z')+i*2000;
    await completed(new Date(startAt).toISOString(),new Date(startAt+600).toISOString());
   }
   const midnightId=await completed('2026-10-03T20:59:59.500Z','2026-10-03T21:00:00.500Z');
   const activeId=randomUUID();await store.process(delivery('start',{userId:'user-a',commandId:randomUUID(),timerId:activeId,startedAt:'2026-10-03T23:00:00.000Z'}));
   const before=await store.statistics('user-a');
   assert.ok(schema('StatisticsResponse')(before),JSON.stringify(schema('StatisticsResponse').errors));
   assert.equal(before.version,113);assert.equal(before.totalCompletedMs,34000);assert.equal(before.challenge.completedMs,500);
   assert.equal(before.daily.find(day=>day.date==='2026-09-01').completedMs,33000);
   assert.equal(before.daily.find(day=>day.date==='2026-10-03').completedMs,500);
   assert.equal(before.challenge.daily[0].completedMs,500);assert.equal(before.challenge.daily.length,28);
   assert.equal((await store.snapshot('user-a')).recentCompleted.length,50);
   const editInput=delivery('edit',edit(113,midnightId,'2026-10-03T20:59:59.000Z','2026-10-03T21:00:02.000Z'));
   const pending=store.process(editInput),during=await store.statistics('user-a');
   assert.ok(during.version===113||during.version===114);
   assert.equal(during.totalCompletedMs,during.version===113?34000:36000);
   assert.equal(during.challenge.completedMs,during.version===113?500:2000);
   await pending;await store.process(editInput);
   const edited=await store.statistics('user-a');assert.equal(edited.version,114);assert.equal(edited.totalCompletedMs,36000);assert.equal(edited.challenge.completedMs,2000);
   await store.process(delivery('delete',remove(114,midnightId)));
   const deleted=await store.statistics('user-a');assert.equal(deleted.version,115);assert.equal(deleted.totalCompletedMs,33000);assert.equal(deleted.challenge.completedMs,0);
   assert.equal((await store.snapshot('user-a')).active.timerId,activeId);
   const foreign=await store.statistics('user-b');assert.equal(foreign.totalCompletedMs,0);assert.equal(foreign.challenge.completedMs,0);
  });
  await t.test('сумма всей истории сохраняет миллисекунды, исключает активный и не растёт при повторе STOP',async()=>{
   await reset();
   for(let i=0;i<55;i++){
    const timerId=randomUUID(),startedAt=new Date(Date.UTC(2026,0,1,0,0,i)).toISOString(),stoppedAt=new Date(Date.parse(startedAt)+600).toISOString();
    await store.process(delivery('start',{userId:'user-a',commandId:randomUUID(),timerId,startedAt}));
    const command=delivery('stop',{userId:'user-a',commandId:randomUUID(),timerId,stoppedAt});
    const stopped=await store.process(command);assert.equal(stopped.event.interval.durationMs,600);
    assert.deepEqual((await store.process(command)).event,stopped.event);
   }
   const snapshot=await store.snapshot('user-a');assert.equal(snapshot.totalCompletedMs,33000);assert.equal(snapshot.recentCompleted.length,50);
   assert.equal((await store.snapshot('user-b')).totalCompletedMs,0);
   const timerId=randomUUID();await store.process(delivery('start',{userId:'user-a',commandId:randomUUID(),timerId,startedAt:'2026-01-01T00:01:00.000Z'}));
   assert.equal((await store.snapshot('user-a')).totalCompletedMs,33000);
   const pending=store.process(delivery('stop',{userId:'user-a',commandId:randomUUID(),timerId,stoppedAt:'2026-01-01T00:01:00.600Z'}));
   const concurrent=await store.snapshot('user-a');
   assert.equal(concurrent.totalCompletedMs,concurrent.version===111?33000:33600);
   assert.equal(Boolean(concurrent.active),concurrent.version===111);
   await pending;assert.equal((await store.snapshot('user-a')).totalCompletedMs,33600);
  });
  await reset();
  let timer=await connectNats(cfg);const web=await connectWeb();
  try{
   await setupJetStream(timer,cfg);const manager=await timer.jetstreamManager();
   await t.test('очередь сохраняет команду при выключенном сервисе без MaxAge и предела попыток',async()=>{
    const info=await manager.streams.info(commandsStream);assert.equal(info.config.max_age,0);assert.equal(info.config.retention,'workqueue');assert.equal(info.config.discard,'new');assert.equal(info.config.max_bytes,256*1024*1024);
    const consumer=await manager.consumers.info(commandsStream,commandsConsumer);assert.equal(consumer.config.max_ack_pending,1);assert.equal(consumer.config.max_deliver,-1);assert.equal(consumer.config.ack_policy,'explicit');
    const command=start(0);await web.jetstream().publish('brai.timer.v2.command.start',Buffer.from(JSON.stringify(command)));await wait(200);assert.equal((await manager.streams.info(commandsStream)).state.messages,1);
    const runtime=await runNats(timer,cfg,store);try{const result=await until(()=>lookup(web,command.commandId));assert.ok(schema('StartedEvent')(result.result));assert.equal(result.result.version,1);}finally{await runtime.stop();}
   });
   await t.test('сбой после commit и после PubAck до ACK восстанавливает тот же eventId при реальной redelivery',async()=>{
    let version=1;
    for(const stage of ['afterCommit','afterPubAck']){
     const snapshot=await store.snapshot('user-a');const command=stop(version,snapshot.active.timerId);
     await web.jetstream().publish('brai.timer.v2.command.stop',Buffer.from(JSON.stringify(command)));
     const msg=await message(timer);
     if(stage==='afterCommit')await assert.rejects(processMsg(timer,msg,{save:async input=>{await store.process(input);throw new Error('fixture after commit');}}));
     else await assert.rejects(processMsg(timer,msg,{publish:async result=>{await publish(timer,result);throw new Error('fixture after PubAck');}}));
     const before=(await store.command('user-a',command.commandId)).result;assert.equal(before.version,++version);
     await timer.close();await wait(650);timer=await connectNats(cfg);
     const redelivered=await message(timer);assert.ok(redelivered.info.redeliveryCount>=1);
     const restored=await processMsg(timer,redelivered);await timer.flush();assert.deepEqual(restored.event,before);assert.equal(restored.duplicate,true);assert.equal((await store.snapshot('user-a')).version,version);
     if(stage==='afterCommit'){const command=start(version);await web.jetstream().publish('brai.timer.v2.command.start',Buffer.from(JSON.stringify(command)));await processMsg(timer,await message(timer));await timer.flush();version++;}
    }
   });
   await t.test('NATS Services discovery, состояние после restart и стандартные ошибки со схемным телом',async()=>{
    const runtime=await runNats(timer,cfg,store);
    try{
     const info=JSON.parse((await web.request('$SRV.INFO.brai_timer',undefined,{timeout:1000})).string());assert.equal(info.name,'brai_timer');assert.equal(info.version,'2.0.0');assert.equal(info.endpoints.length,4);
     assert.ok(JSON.parse((await web.request('$SRV.PING.brai_timer',undefined,{timeout:1000})).string()).id);assert.ok(JSON.parse((await web.request('$SRV.STATS.brai_timer',undefined,{timeout:1000})).string()).endpoints);
     const reply=await web.request('brai.timer.v2.query.snapshot',Buffer.from(JSON.stringify({userId:'user-a'})));const snapshot=JSON.parse(reply.string());assert.ok(schema('SnapshotResponse')(snapshot));assert.equal(snapshot.version,4);assert.equal(snapshot.recentCompleted.length,2);
     const statsReply=await web.request('brai.timer.v2.query.statistics',Buffer.from(JSON.stringify({userId:'user-a'})));
     assert.ok(!statsReply.headers?.has('Nats-Service-Error-Code'));
     const stats=JSON.parse(statsReply.string());assert.ok(schema('StatisticsResponse')(stats),JSON.stringify(schema('StatisticsResponse').errors));
     assert.equal(stats.version,snapshot.version);assert.equal(stats.totalCompletedMs,snapshot.totalCompletedMs);
     for(const [subject,body,error] of [['history',{limit:101},'INVALID_ARGUMENT'],['snapshot',{extra:true},'INVALID_ARGUMENT'],['statistics',{extra:true},'INVALID_ARGUMENT'],['command',{commandId:randomUUID()},'NOT_FOUND']]){
      const result=await web.request(`brai.timer.v2.query.${subject}`,Buffer.from(JSON.stringify({...body,userId:'user-a'})));assert.equal(result.headers.get('Nats-Service-Error'),error);assert.ok(result.headers.get('Nats-Service-Error-Code'));const payload=JSON.parse(result.string());assert.equal(payload.code,error);assert.equal(payload.retryable,false);assert.ok(ajv.validate({$ref:'https://brai.invalid/contracts/timer/v2/common.schema.json#/definitions/error'},payload));
     }
     const c=start(4);await web.jetstream().publish('brai.timer.v2.command.start',Buffer.from(JSON.stringify(c)));const saved=await until(()=>lookup(web,c.commandId));assert.equal(saved.result.version,5);
    }finally{await runtime.stop();}
    const env={PATH:process.env.PATH,DATABASE_URL:appURL,NATS_URL:natsURL,NATS_USER:'timer',NATS_PASSWORD:'fixture-timer',TIMER_ACK_WAIT_MS:'500'};
    let previous;
    for(let attempt=0;attempt<2;attempt++){
     const child=spawn(process.execPath,['dist/main.js'],{cwd:new URL('../../',import.meta.url),env,stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);
     const exit=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
     try{
      const s=await until(async()=>{if(child.exitCode!==null)throw new Error(output);try{const response=await web.request('brai.timer.v2.query.snapshot',Buffer.from(JSON.stringify({userId:'user-a'})),{timeout:500});return response.headers?.get('Nats-Service-Error-Code')?null:JSON.parse(response.string());}catch{return null;}});
      assert.equal(s.version,5);assert.ok(s.active);if(previous)assert.deepEqual(s.active,previous);previous=s.active;
      const health=spawn(process.execPath,['dist/health.js'],{cwd:new URL('../../',import.meta.url),env,stdio:'ignore'});assert.equal(await new Promise(resolve=>health.once('exit',resolve)),0);
     }finally{child.kill('SIGTERM');const stopped=await Promise.race([exit,wait(7000).then(()=>({code:'timeout'}))]);if(stopped.code==='timeout')child.kill('SIGKILL');assert.equal(stopped.code,0,output);}
    }
   });
   await t.test('настоящий NATS публикует durable edit/delete события и lookup возвращает сохранённый исход',async()=>{
    const manager=await web.jetstreamManager();try{await manager.consumers.delete(eventsStream,'web_events');}catch{}
    await manager.consumers.add(eventsStream,{durable_name:'web_events',filter_subject:'brai.timer.v2.event.*',ack_policy:AckPolicy.Explicit,ack_wait:nanos(30000),max_ack_pending:64,max_deliver:-1,deliver_policy:DeliverPolicy.New,replay_policy:ReplayPolicy.Instant});
    const events=await web.jetstream().consumers.get(eventsStream,'web_events'),runtime=await runNats(timer,cfg,store);
    async function delivered(commandId){return until(async()=>{const message=await events.next({expires:1000});if(!message)return null;const event=JSON.parse(message.string());message.ack();return event.commandId===commandId?event:null;});}
    async function publish(subject,command,schemaName){await web.jetstream().publish(`brai.timer.v2.command.${subject}`,Buffer.from(JSON.stringify(command)));const found=await until(()=>lookup(web,command.commandId));assert.ok(schema(schemaName)(found.result),JSON.stringify(schema(schemaName).errors));const event=await delivered(command.commandId);assert.ok(schema(schemaName)(event),JSON.stringify(schema(schemaName).errors));assert.deepEqual(found.result,event);return event;}
    try{
     const active=(await store.snapshot('user-a')).active;assert.ok(active);
     await publish('stop',stop(5,active.timerId),'StoppedEvent');
     const edited=await publish('edit',edit(6,active.timerId,'2027-01-01T00:00:00.000Z','2027-01-01T00:00:01.250Z'),'TimerEditedEvent');assert.equal(edited.interval.durationMs,1250);
     const deleted=await publish('delete',remove(7,active.timerId),'TimerDeletedEvent');assert.equal(deleted.timerId,active.timerId);assert.equal((await store.command('user-a',deleted.commandId)).result.operation,'delete');
    }finally{await runtime.stop();}
   });
   await t.test('не более трёх чтений: перегрузка даёт retryable503, command слот сохраняется',async()=>{
    const blocker=await owner.connect();await blocker.query('BEGIN');await blocker.query('LOCK TABLE timer.state IN ACCESS EXCLUSIVE MODE');
    const runtime=await runNats(timer,cfg,{...store,ready:async()=>{}});
    try{
     const pending=[1,2,3].map(()=>web.request('brai.timer.v2.query.snapshot',Buffer.from(JSON.stringify({userId:'user-a'})),{timeout:4000}));await wait(100);
     const refused=await web.request('brai.timer.v2.query.snapshot',Buffer.from(JSON.stringify({userId:'user-a'})),{timeout:1000});assert.equal(refused.headers.get('Nats-Service-Error-Code'),'503');assert.equal(JSON.parse(refused.string()).retryable,true);
     await blocker.query('ROLLBACK');const replies=await Promise.all(pending);assert.ok(replies.every(m=>!m.headers?.get('Nats-Service-Error-Code')));
    }finally{await blocker.query('ROLLBACK');blocker.release();await runtime.stop();}
   });
   await t.test('заполненный stream отклоняет новые команды и не вытесняет уже принятые',async()=>{
    const jsm=await timer.jetstreamManager();await jsm.streams.update(commandsStream,{max_bytes:1024});let accepted=0,failed=false;
    for(let i=0;i<30;i++){try{await web.jetstream().publish('brai.timer.v2.command.start',Buffer.from(JSON.stringify(start(5))));accepted++;}catch{failed=true;break;}}
    assert.ok(accepted>0);assert.equal(failed,true);const before=(await jsm.streams.info(commandsStream)).state;assert.equal(before.messages,accepted);await assert.rejects(web.jetstream().publish('brai.timer.v2.command.start',Buffer.from(JSON.stringify(start(5)))));const after=(await jsm.streams.info(commandsStream)).state;assert.equal(after.messages,before.messages);assert.equal(after.first_seq,before.first_seq);
   });
  }finally{await timer.close();await web.close();}
 }finally{await app.end();await owner.end();}
});
