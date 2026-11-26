// ABOUTME: Проверяет изоляцию настоящими раздельно аутентифицированными подключениями PostgreSQL.
// ABOUTME: Запускается только на явно переданной одноразовой базе с синтетическими данными.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Pool} from 'pg';
import {migrate} from '../dist/migrate.js';
import {migrateIsolation,bindOwner,verifyOwnerConnection,ownerTables} from '../dist/isolation.js';
const url=process.env.DIALOGUES_ISOLATION_TEST_URL;
test('RLS: независимые логины, старая история, запреты подмены и повтор миграции',{skip:!url},async()=>{
 const owner=new Pool({connectionString:url}),pools=[];
 const bindingA={userId:'account-a',ownerId:'legacy-owner',profileId:'profile-a'};
 const bindingB={userId:'account-b',ownerId:'account-b',profileId:'profile-b'};
 const connect=login=>{const u=new URL(url);u.username=login;u.password='synthetic-fixture';const p=new Pool({connectionString:u.toString(),max:2});pools.push(p);return p;};
 try{
  const who=(await owner.query('SELECT current_user AS actor')).rows[0].actor;
  assert.equal(who,'dialogues_fixture_owner','Тест требует отдельный fixture owner');
  for(const login of ['dialogues_fixture_a','dialogues_fixture_b','dialogues_fixture_legacy']){
   await owner.query("CREATE ROLE "+login+" LOGIN PASSWORD 'synthetic-fixture' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT");
  }
  await migrate(owner,who,'dialogues_fixture_legacy');
  const legacy=connect('dialogues_fixture_legacy');
  await legacy.query("INSERT INTO dialogues_live.dialogues(owner_id,id,channel,title) VALUES('legacy-owner','same','synthetic','private A')");
  await migrateIsolation(owner,who);await migrateIsolation(owner,who);
  await bindOwner(owner,who,'dialogues_fixture_a',bindingA);
  await bindOwner(owner,who,'dialogues_fixture_b',bindingB);
  await bindOwner(owner,who,'dialogues_fixture_a',bindingA);
  const a=connect('dialogues_fixture_a'),b=connect('dialogues_fixture_b');
  await verifyOwnerConnection(a,bindingA);await verifyOwnerConnection(b,bindingB);
  await assert.rejects(verifyOwnerConnection(a,bindingB),/BINDING_MISMATCH/);
  await assert.rejects(bindOwner(owner,who,'dialogues_fixture_a',bindingB),/BINDING_CONFLICT/);
  await b.query("INSERT INTO dialogues_live.dialogues(owner_id,id,channel,title) VALUES('account-b','same','synthetic','private B')");
  const read=async p=>(await p.query('SELECT owner_id,title FROM dialogues_live.dialogues')).rows;
  assert.deepEqual(await read(a),[{owner_id:'legacy-owner',title:'private A'}]);
  assert.deepEqual(await read(b),[{owner_id:'account-b',title:'private B'}]);
  await a.query("SET app.user_id='account-b'");
  assert.deepEqual(await read(a),[{owner_id:'legacy-owner',title:'private A'}]);
  for(const sql of ["SET ROLE dialogues_fixture_b","SET SESSION AUTHORIZATION dialogues_fixture_b",
   "UPDATE dialogues_access.sys_owner_bindings SET owner_id='account-b'",
   "INSERT INTO dialogues_live.dialogues(owner_id,id,channel,title) VALUES('account-b','forged','synthetic','forbidden')"]){
   await assert.rejects(a.query(sql),{code:'42501'});
  }
  await assert.rejects(read(legacy),{code:'42501'});
  for(const table of ownerTables)assert.equal((await a.query('SELECT count(*)::int n FROM dialogues_live.'+table+" WHERE owner_id='account-b'")).rows[0].n,0);
  // Fixture имитирует уже настроенные профили с версией 006 до установки тем.
  const withoutWorker=`DROP TRIGGER topics_message_changed ON dialogues_live.messages;
   DROP TRIGGER topics_message_summary_changed ON dialogues_live.message_summaries;
   DROP TRIGGER topics_dialogue_summary_changed ON dialogues_live.dialogue_summaries;
   DROP TRIGGER topics_final_changed ON dialogues_live.turns;
   DROP FUNCTION dialogues_live.mark_topic_dirty();
   DELETE FROM dialogues_live.migrations WHERE version=8;`;
  const beforeTopics=withoutWorker+`DROP TABLE dialogues_live.message_compact_summaries,dialogues_live.topic_summaries,
    dialogues_live.topic_members,dialogues_live.topic_separations,dialogues_live.topics;
   ALTER TABLE dialogues_live.context_consumers DROP COLUMN topic_view;
   ALTER TABLE dialogues_live.context_deliveries DROP COLUMN topic_view;
   DELETE FROM dialogues_live.migrations WHERE version=7`;
  for(const upgrade of [()=>migrate(owner,who,'dialogues_fixture_a'),()=>migrateIsolation(owner,who)]){
   await owner.query(beforeTopics);
   await upgrade();
   await verifyOwnerConnection(a,bindingA);await verifyOwnerConnection(b,bindingB);
   await b.query("INSERT INTO dialogues_live.topics(owner_id,id,title) VALUES('account-b','same','private topic')");
   assert.deepEqual((await a.query('SELECT id FROM dialogues_live.topics')).rows,[]);
   assert.deepEqual((await b.query('SELECT id FROM dialogues_live.topics')).rows,[{id:'same'}]);
  }
  // Обновление 007 сохраняет готовые темы и привязки, а откат runtime может писать историю.
  await owner.query(withoutWorker+`ALTER TABLE dialogues_live.topics DROP COLUMN dirty_seq;
   ALTER TABLE dialogues_live.topic_members DROP COLUMN checked_evidence,DROP COLUMN evidence_seq;`);
  await b.query("INSERT INTO dialogues_live.topic_members(owner_id,dialogue_id,topic_id) VALUES('account-b','same','same')");
  await migrateIsolation(owner,who);
  assert.equal((await b.query("SELECT evidence_seq FROM dialogues_live.topic_members WHERE dialogue_id='same'")).rows[0].evidence_seq,'-1');
  await owner.query('REVOKE ALL ON dialogues_live.topics,dialogues_live.topic_members FROM dialogues_fixture_b');
  await b.query(`INSERT INTO dialogues_live.turns(owner_id,dialogue_id,id,turn_order,status,change_seq)
   VALUES('account-b','same','legacy-turn',1,'completed',1)`);
  await b.query(`INSERT INTO dialogues_live.messages(owner_id,dialogue_id,turn_id,id,role,kind,message_order,item_order,text,payload,content_hash,source,change_seq)
   VALUES('account-b','same','legacy-turn','legacy-input','user','input',1,1,'Старая версия пишет историю','{}','synthetic','{}',3)`);
  await bindOwner(owner,who,'dialogues_fixture_b',bindingB);
  assert.deepEqual((await b.query(`SELECT evidence_seq,dirty_seq FROM dialogues_live.topic_members
   JOIN dialogues_live.topics ON topics.owner_id=topic_members.owner_id AND topics.id=topic_members.topic_id WHERE dialogue_id='same'`)).rows,
  [{evidence_seq:'3',dirty_seq:'3'}]);
  // Переход с 008 назначает номера даже строкам под FORCE RLS, повтор их сохраняет.
  await owner.query(`ALTER TABLE dialogues_live.topics DROP COLUMN short_id;
   ALTER TABLE dialogues_live.dialogues DROP COLUMN short_id;
   ALTER TABLE dialogues_live.messages DROP COLUMN short_id;
   DELETE FROM dialogues_live.migrations WHERE version=9`);
  const shortIdsSql=`SELECT t.short_id AS topic,m.short_id AS message,d.short_id AS dialogue
   FROM dialogues_live.topics t,dialogues_live.messages m,dialogues_live.dialogues d`;
  await migrateIsolation(owner,who);
  const archived=(await b.query(shortIdsSql)).rows;
  assert.equal(archived.length,1);
  assert.ok(Object.values(archived[0]).every(n=>/^[1-9]\d*$/.test(n)));
  assert.deepEqual((await a.query(shortIdsSql)).rows,[]);
  await migrateIsolation(owner,who);
  assert.deepEqual((await b.query(shortIdsSql)).rows,archived);
  const checks=await Promise.all(Array.from({length:60},async(_,i)=>({i,rows:await read(i%2?a:b)})));
  for(const {i,rows}of checks)assert.equal(rows[0].owner_id,i%2?'legacy-owner':'account-b');
  await owner.query("UPDATE dialogues_access.sys_owner_bindings SET enabled=false WHERE login_role='dialogues_fixture_a'");
  assert.deepEqual(await read(a),[]);
  await assert.rejects(verifyOwnerConnection(a,bindingA),/BINDING_MISMATCH/);
 }finally{await Promise.all(pools.map(p=>p.end()));await owner.end();}
});
