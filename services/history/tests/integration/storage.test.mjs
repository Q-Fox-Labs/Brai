// ABOUTME: Проверяет атомарность, повторы, RLS и права истории на настоящем PostgreSQL.
// ABOUTME: Допускает только явные loopback URL синтетической БД brai_history_test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { migrate } from '../../dist/migrate.js';
import { createPostgresStore } from '../../dist/storage.js';
import { createHistoryHandlers, HistoryFault } from '../../dist/domain.js';
const keys=['OWNER','APP','WEB'];
const urls=keys.map(k=>process.env['HISTORY_TEST_'+k+'_URL']);
for(const url of urls){if(!url)throw new Error('Explicit HISTORY_TEST_OWNER_URL/APP_URL/WEB_URL required');const u=new URL(url);if(u.hostname!=='127.0.0.1'||u.pathname!=='/brai_history_test')throw new Error('Only loopback brai_history_test permitted');}
const [owner,app,web]=urls.map(connectionString=>new Pool({connectionString,connectionTimeoutMillis:3000,max:8}));
const isolatedWeb=new Pool({connectionString:urls[2],connectionTimeoutMillis:3000,max:1});
const store=createPostgresStore(app,web);
const key='synthetic-history-cursor-key-32-bytes';
const core=createHistoryHandlers(store,{cursorKey:key});
const roles=['history_owner','history_app','history_web'];
const migrateNow=()=>migrate(owner,...roles);
const fault=code=>error=>error instanceof HistoryFault&&error.code===code;
const count=async(table)=>Number((await owner.query(`SELECT count(*) AS n FROM history.${table}`)).rows[0].n);
const event=(overrides={})=>({id:randomUUID(),source:'fixture',type_id:101,occurred_at:'2026-10-05T20:10:00.123456+02:00',scope_type:'user',scope_id:'user-a',...overrides});
const category=(overrides={})=>({event_id:randomUUID(),code:'fixture_'+randomUUID().replaceAll('-',''),name:'Категория',description:'Тест',...overrides});
const migrationSQL=readFileSync(new URL('../../migrations/001.sql',import.meta.url),'utf8');

test('real PostgreSQL storage contract',async t=>{
 try{
  await t.test('seed transaction rolls back all inserts if audit is rejected',async()=>{
   await owner.query('DROP SCHEMA IF EXISTS history CASCADE');
   await owner.query(migrationSQL.split('DO $seed$')[0]);
   await owner.query(`CREATE FUNCTION history.reject_seed() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic audit rejection'; END $$; CREATE TRIGGER reject_seed BEFORE INSERT ON history.events FOR EACH ROW EXECUTE FUNCTION history.reject_seed()`);
   await assert.rejects(migrateNow(),/synthetic audit rejection/);
   assert.equal(await count('sys_categories'),0);assert.equal(await count('sys_types'),0);assert.equal(await count('events'),0);assert.equal(await count('migrations'),0);
   await owner.query('DROP SCHEMA history CASCADE');
  });
  await t.test('fresh seed and repeat create exactly three subject tables and 72 audits',async()=>{
   await migrateNow();assert.equal(await count('sys_categories'),14);assert.equal(await count('sys_types'),58);assert.equal(await count('events'),72);assert.equal(await count('migrations'),1);
   const tables=(await owner.query("SELECT tablename FROM pg_tables WHERE schemaname='history' ORDER BY tablename")).rows.map(r=>r.tablename);
   assert.deepEqual(tables,['events','migrations','sys_categories','sys_types']);
   assert.equal((await owner.query("SELECT count(*)::integer AS n FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid WHERE c.oid='history.events'::regclass AND a.attnum>0 AND NOT a.attisdropped")).rows[0].n,11);
   const fixture=await core.typeCreate({event_id:randomUUID(),category_id:1,code:'new_fixture_type',name:'Новый',description:'ручной'});
   await core.categoryUpdate({event_id:randomUUID(),id:1,name:'Ручное имя',description:'Ручное описание'});
   const before=await count('events');await migrateNow();await migrateNow();
   assert.equal(await count('events'),before);assert.equal(await count('sys_types'),59);
   assert.equal((await owner.query('SELECT name FROM history.sys_categories WHERE id=1')).rows[0].name,'Ручное имя');
   assert.ok(fixture.result.id>1404);
   const noComments=(await owner.query("SELECT count(*)::integer AS n FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid WHERE c.relnamespace='history'::regnamespace AND c.relname IN ('sys_categories','sys_types') AND a.attnum>0 AND NOT a.attisdropped AND col_description(c.oid,a.attnum) IS NULL")).rows[0].n;
   assert.equal(noComments,0);
  });
  await t.test('seed semantic id/code/category conflicts fail without overwriting manual data',async()=>{
   await owner.query("UPDATE history.sys_categories SET code='broken_fixture_code' WHERE id=14");
   await assert.rejects(migrateNow(),/HISTORY_SEED_CATEGORY_CONFLICT/);
   await owner.query("UPDATE history.sys_categories SET code='observation' WHERE id=14");
   await owner.query('UPDATE history.sys_types SET category_id=13 WHERE id=1404');
   await assert.rejects(migrateNow(),/HISTORY_SEED_TYPE_CONFLICT/);
   await owner.query('UPDATE history.sys_types SET category_id=14 WHERE id=1404');
   await migrateNow();
  });
  await t.test('runtime roles cannot mutate events, identities or DDL and denied actor cannot connect',async()=>{
   const flags=(await owner.query("SELECT rolname,rolsuper,rolbypassrls FROM pg_roles WHERE rolname IN ('history_app','history_web')")).rows;
   assert.equal(flags.length,2);for(const r of flags){assert.equal(r.rolsuper,false);assert.equal(r.rolbypassrls,false);}
   const sqls=['UPDATE history.events SET data=data','DELETE FROM history.events','TRUNCATE history.events','CREATE TABLE history.forbidden(id integer)','CREATE TABLE public.forbidden(id integer)','UPDATE history.sys_categories SET id=id','UPDATE history.sys_categories SET code=code','UPDATE history.sys_types SET category_id=category_id','DELETE FROM history.sys_types','TRUNCATE history.sys_categories','SELECT * FROM foreign_fixture.foreign_data'];
   for(const pool of [app,web])for(const sql of sqls)await assert.rejects(pool.query(sql),e=>e.code==='42501');
   for(const sql of ["INSERT INTO history.sys_categories(id,code,name,description) VALUES(999999,'forbidden','x','')",`INSERT INTO history.events(id,source,type_id,occurred_at,recorded_at,scope_type,scope_id) VALUES('${randomUUID()}','fixture',101,now(),now(),'user','user-a')`])await assert.rejects(app.query(sql),e=>e.code==='42501');
   await assert.rejects(web.query("INSERT INTO history.sys_categories(code,name,description) VALUES('forbidden','x','')"),e=>e.code==='42501');
   const actor=new Pool({connectionString:urls[0].replace('history_owner:fixture-owner','history_actor:fixture-actor'),connectionTimeoutMillis:3000});
   try{await assert.rejects(actor.query('SELECT 1'),e=>e.code==='42501');}finally{await actor.end();}
  });
  await t.test('concurrent normalized append returns one original event; loss of reply is safe',async()=>{
   const e=event({data:JSON.parse('{"__proto__":{"key":1},"nested":{"b":2,"a":1}}')});
   const requests=Array.from({length:12},(_,i)=>core.appendEvent(i%2?{...e,id:e.id.toUpperCase(),actor_id:null,object_type:null,object_id:null,occurred_at:'2026-10-05T18:10:00.123456Z',data:JSON.parse('{"nested":{"a":1,"b":2},"__proto__":{"key":1}}')}:e));
   const results=await Promise.all(requests);for(const result of results)assert.deepEqual(result,results[0]);
   assert.equal(results[0].event.occurred_at,'2026-10-05T18:10:00.123456Z');assert.match(results[0].event.recorded_at,/\.\d{6}Z$/);
   assert.equal((await owner.query('SELECT count(*)::integer AS n FROM history.events WHERE source=$1 AND id=$2',[e.source,e.id])).rows[0].n,1);
   await core.appendEvent(e);const retry=await core.appendEvent(e);assert.deepEqual(retry,results[0]);
   await assert.rejects(core.appendEvent({...e,data:{changed:true}}),fault('EVENT_ID_CONFLICT'));
   const pair=event();const outcomes=await Promise.allSettled([core.appendEvent(pair),core.appendEvent({...pair,data:{changed:true}})]);
   assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);assert.equal(outcomes.filter(r=>r.status==='rejected'&&r.reason.code==='EVENT_ID_CONFLICT').length,1);
  });
  await t.test('catalog concurrent repeat preserves original result after later update and refuses forged audit',async()=>{
   const request=category();const before=await count('events');
   const [a,b]=await Promise.all([core.categoryCreate(request),core.categoryCreate({...request,actor_id:null})]);assert.deepEqual(a,b);assert.equal(await count('events'),before+1);
   const firstUpdate={event_id:randomUUID(),id:a.result.id,name:'Первое имя',description:'первое'};
   const [u,v]=await Promise.all([core.categoryUpdate(firstUpdate),core.categoryUpdate(firstUpdate)]);assert.deepEqual(u,v);
   const later=await core.categoryUpdate({event_id:randomUUID(),id:a.result.id,name:'Позднее имя',description:'позднее'});
   assert.deepEqual(await core.categoryCreate(request),a);assert.deepEqual(await core.categoryUpdate(firstUpdate),u);
   assert.equal((await owner.query('SELECT name FROM history.sys_categories WHERE id=$1',[a.result.id])).rows[0].name,later.result.name);
   await assert.rejects(core.categoryCreate({...request,name:'другой'}),fault('EVENT_ID_CONFLICT'));
   await assert.rejects(core.typeUpdate({event_id:firstUpdate.event_id,id:101,name:firstUpdate.name,description:firstUpdate.description}),fault('EVENT_ID_CONFLICT'));
   for(const object_type of ['sys_categories','sys_types'])await assert.rejects(core.appendEvent(event({source:'service_history',object_type,object_id:'1'})),fault('INVALID_ARGUMENT'));
   const occupied=randomUUID();await core.appendEvent(event({id:occupied,source:'service_history',scope_type:'system',scope_id:'service_history',data:{request:{}}}));
   await assert.rejects(core.categoryCreate(category({event_id:occupied})),fault('EVENT_ID_CONFLICT'));
   const updates=await Promise.all([core.categoryUpdate({event_id:randomUUID(),id:a.result.id,name:'C1',description:''}),core.categoryUpdate({event_id:randomUUID(),id:a.result.id,name:'C2',description:''})]);
   assert.equal(updates.filter(x=>x.audit_event.data.old.name==='Позднее имя').length,1);
   assert.ok(updates.some(x=>['C1','C2'].includes(x.audit_event.data.old.name)));
  });
  await t.test('audit failure rolls back catalog mutation and does not occupy event_id',async()=>{
   await owner.query(`CREATE FUNCTION history.reject_audit_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.actor_id='reject-audit' THEN RAISE EXCEPTION 'synthetic audit rejection'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_audit_fixture BEFORE INSERT ON history.events FOR EACH ROW EXECUTE FUNCTION history.reject_audit_fixture()`);
   const request=category({actor_id:'reject-audit'});const before=await count('sys_categories');
   try{await assert.rejects(core.categoryCreate(request),fault('INTERNAL'));assert.equal(await count('sys_categories'),before);assert.equal((await owner.query('SELECT count(*)::integer AS n FROM history.events WHERE id=$1',[request.event_id])).rows[0].n,0);}finally{await owner.query('DROP TRIGGER reject_audit_fixture ON history.events; DROP FUNCTION history.reject_audit_fixture()');}
   const retry=await core.categoryCreate(request);assert.equal(retry.result.code,request.code);
  });
  await t.test('web RLS denies other users/system/empty context and clears context after commit and rollback',async()=>{
   const a=(await core.appendEvent(event())).event;
   const b=(await core.appendEvent(event({scope_id:'user-b'}))).event;
   const system=(await core.appendEvent(event({scope_type:'system',scope_id:'service_history'}))).event;
   const list=await core.listForWeb({user_id:'user-a',limit:100});assert.ok(list.items.length>0);assert.ok(list.items.every(e=>e.scope_type==='user'&&e.scope_id==='user-a'));
   await assert.rejects(core.getForWeb({user_id:'user-a',source:b.source,id:b.id}),fault('NOT_FOUND'));
   await assert.rejects(core.getForWeb({user_id:'user-a',source:system.source,id:system.id}),fault('NOT_FOUND'));
   await assert.rejects(core.listForWeb({user_id:'user-a',filters:{scope_type:'system'}}),fault('INVALID_ARGUMENT'));
   assert.deepEqual((await core.getForWeb({user_id:'user-a',source:a.source,id:a.id})).event,a);
   assert.equal((await web.query('SELECT count(*)::integer AS n FROM history.events')).rows[0].n,0);
   const oneStore=createPostgresStore(app,isolatedWeb);
   await oneStore.transaction('user-a',undefined,async tx=>{assert.ok(await tx.event(a.source,a.id));});
   assert.equal((await isolatedWeb.query("SELECT current_setting('app.user_id',true) AS scope,count(*)::integer AS n FROM history.events")).rows[0].n,0);
   await assert.rejects(oneStore.transaction('user-a',undefined,async tx=>{assert.ok(await tx.event(a.source,a.id));throw new HistoryFault('INVALID_ARGUMENT');}),fault('INVALID_ARGUMENT'));
   const reset=await isolatedWeb.query("SELECT current_setting('app.user_id',true) AS scope,count(*)::integer AS n FROM history.events");assert.equal(reset.rows[0].n,0);assert.ok(!reset.rows[0].scope);
   const client=await isolatedWeb.connect();try{await client.query('BEGIN');await client.query("SELECT set_config('app.user_id','user-b',true)");const rows=(await client.query('SELECT scope_id,scope_type FROM history.events')).rows;assert.ok(rows.length);assert.ok(rows.every(r=>r.scope_type==='user'&&r.scope_id==='user-b'));await client.query('COMMIT');}finally{client.release();}
   assert.equal((await isolatedWeb.query('SELECT count(*)::integer AS n FROM history.events')).rows[0].n,0);
   assert.equal((await core.getEvent({source:system.source,id:system.id})).event.id,system.id);
  });
  await t.test('micros and equal-time cursor pages never skip; HMAC rejects tuple/filter/scope tampering',async()=>{
   const source='cursor_fixture';const rows=[];for(let i=0;i<7;i++)rows.push((await core.appendEvent(event({source}))).event);
   await owner.query("UPDATE history.events SET recorded_at='2026-10-05T18:11:00.100001Z' WHERE source=$1",[source]);
   await owner.query("UPDATE history.events SET recorded_at='2026-10-05T18:11:00.100002Z' WHERE source=$1 AND id=$2",[source,rows[0].id]);
   let cursor=null;const ids=[];let first;
   do{const page=await core.listForWeb({user_id:'user-a',filters:{source},limit:2,cursor});first??=page;ids.push(...page.items.map(e=>e.id));cursor=page.next_cursor;}while(cursor);
   assert.equal(ids.length,7);assert.equal(new Set(ids).size,7);assert.equal(ids[0],rows[0].id);
   const [payload,sig]=first.next_cursor.split('.');const forged=JSON.parse(Buffer.from(payload,'base64url'));forged.position[0]='2026-01-01T00:00:00.000000Z';
   await assert.rejects(core.listForWeb({user_id:'user-a',filters:{source},cursor:Buffer.from(JSON.stringify(forged)).toString('base64url')+'.'+sig}),fault('INVALID_CURSOR'));
   await assert.rejects(core.listForWeb({user_id:'user-b',filters:{source},cursor:first.next_cursor}),fault('INVALID_CURSOR'));
   await assert.rejects(core.listForWeb({user_id:'user-a',filters:{source:'other'},cursor:first.next_cursor}),fault('INVALID_CURSOR'));
   await assert.rejects(core.searchEvents({filters:{source},cursor:first.next_cursor}),fault('INVALID_CURSOR'));
   const categories=await core.categoriesList({limit:3});assert.equal(categories.items.length,3);assert.ok(categories.next_cursor);assert.equal((await core.categoriesList({limit:3,cursor:categories.next_cursor})).items[0].id,4);
   const types=await core.typesList({category_id:1,limit:2});assert.equal(types.items.length,2);assert.ok(types.items.every(x=>x.category_id===1));
   await assert.rejects(core.typesList({category_id:2,cursor:types.next_cursor}),fault('INVALID_CURSOR'));
  });
  await t.test('page byte envelope shrinks without losing remaining rows and oversized single result fails',async()=>{
   const source='size_fixture';for(let i=0;i<10;i++)await core.appendEvent(event({source,data:{payload:'x'.repeat(59000)}}));
   const first=await core.listForWeb({user_id:'user-a',filters:{source},limit:100});assert.ok(first.items.length>0&&first.items.length<10);assert.ok(first.next_cursor);assert.ok(Buffer.byteLength(JSON.stringify(first))<=524288);
   const second=await core.listForWeb({user_id:'user-a',filters:{source},limit:100,cursor:first.next_cursor});assert.equal(new Set([...first.items,...second.items].map(e=>e.id)).size,10);assert.equal(second.next_cursor,null);
   const ctx={deadlineAt:performance.now()+1000,signal:new AbortController().signal,responseBudgetBytes:100};
   await assert.rejects(core.listForWeb({user_id:'user-a',filters:{source}},ctx),fault('RESULT_TOO_LARGE'));
   await assert.rejects(core.getForWeb({user_id:'user-a',source,id:first.items[0].id},ctx),fault('RESULT_TOO_LARGE'));
   await assert.rejects(core.appendEvent(event({data:{payload:'x'.repeat(65536)}})),fault('REQUEST_TOO_LARGE'));
  });
  await t.test('deadline cancels blocked SQL and releases connection only after rollback',async()=>{
   const request=category();const locker=await owner.connect();const txKey='service_history:'+request.event_id;
   await locker.query('BEGIN');await locker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,70482318))',[txKey]);
   const ctx={deadlineAt:performance.now()+180,signal:new AbortController().signal};const started=performance.now();
   try{await assert.rejects(core.categoryCreate(request,ctx),fault('DEADLINE_EXCEEDED'));assert.ok(performance.now()-started<1500);assert.equal((await owner.query('SELECT count(*)::integer AS n FROM history.sys_categories WHERE code=$1',[request.code])).rows[0].n,0);}finally{await locker.query('ROLLBACK');locker.release();}
   await core.categoryCreate(request);await store.ready();
   const aborted=new AbortController();aborted.abort();await assert.rejects(core.listForWeb({user_id:'user-a'},{deadlineAt:performance.now()+1000,signal:aborted.signal}),fault('DEADLINE_EXCEEDED'));
  });
  await t.test('unavailable database is a safe public error',async()=>{
   const dead=new Pool({connectionString:urls[1].replace(':15479/',':1/'),connectionTimeoutMillis:300});
   try{await assert.rejects(createPostgresStore(dead,web).transaction(null,undefined,async tx=>tx.event('fixture',randomUUID())),fault('DATABASE_UNAVAILABLE'));}finally{await dead.end();}
  });
 }finally{await Promise.all([owner.end(),app.end(),web.end(),isolatedWeb.end()]);}
});
