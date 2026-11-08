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
  const checks=await Promise.all(Array.from({length:60},async(_,i)=>({i,rows:await read(i%2?a:b)})));
  for(const {i,rows}of checks)assert.equal(rows[0].owner_id,i%2?'legacy-owner':'account-b');
  await owner.query("UPDATE dialogues_access.sys_owner_bindings SET enabled=false WHERE login_role='dialogues_fixture_a'");
  assert.deepEqual(await read(a),[]);
  await assert.rejects(verifyOwnerConnection(a,bindingA),/BINDING_MISMATCH/);
 }finally{await Promise.all(pools.map(p=>p.end()));await owner.end();}
});
