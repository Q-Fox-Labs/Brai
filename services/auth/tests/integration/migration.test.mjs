// ABOUTME: Проверяет отказ миграции до DDL при ошибочных и привилегированных ролях.
// ABOUTME: Допускает только явно указанный временный PostgreSQL стенд auth.
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {Pool} from 'pg';
const fixtureURL=name=>{const value=process.env[name];if(!value)throw new Error(`Explicit ${name} required`);const url=new URL(value);if(url.pathname!=='/brai_auth_test'||url.hostname!=='127.0.0.1'||url.port!=='15459')throw new Error('Refusing non-fixture database');return value;};
const ownerURL=fixtureURL('AUTH_TEST_OWNER_URL');const appURL=fixtureURL('AUTH_TEST_APP_URL');
const owner=new Pool({connectionString:ownerURL});const app=new Pool({connectionString:appURL});
const run=promisify(execFile);
const env={AUTH_DATABASE_URL:ownerURL,AUTH_SECRET:'fixture-auth-secret-32-characters-long',AUTH_ORIGIN:'https://fixture.example',AUTH_EMAIL_FROM:'Fixture <test@example.com>'};
const migrate=roles=>run(process.execPath,[fileURLToPath(new URL('../../dist/migrate.js',import.meta.url))],{env:{...process.env,...env,...roles},timeout:30000});
const schema=async()=>JSON.stringify((await owner.query("SELECT table_schema,table_name,column_name,data_type FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,ordinal_position")).rows);
test('migration rejects missing, same, wrong and privileged roles before schema changes',async()=>{
 try{
 const before=await schema();
 for(const roles of [
  {AUTH_OWNER_ROLE:'',AUTH_APP_ROLE:'auth_app'},
  {AUTH_OWNER_ROLE:'auth_owner',AUTH_APP_ROLE:''},
  {AUTH_OWNER_ROLE:'auth_owner',AUTH_APP_ROLE:'auth_owner'},
  {AUTH_OWNER_ROLE:'wrong_owner',AUTH_APP_ROLE:'auth_app'},
  {AUTH_OWNER_ROLE:'auth_owner',AUTH_APP_ROLE:'postgres'},
  {AUTH_OWNER_ROLE:'auth_owner',AUTH_APP_ROLE:'missing_app'},
 ]){await assert.rejects(()=>migrate(roles),error=>error.code===1);assert.equal(await schema(),before);}
 const result=await migrate({AUTH_OWNER_ROLE:'auth_owner',AUTH_APP_ROLE:'auth_app'});assert.match(result.stdout,/migrations complete/);
 const privileges=(await app.query("SELECT has_database_privilege(current_user,current_database(),'CREATE') AS database_create,has_schema_privilege(current_user,'public','CREATE') AS schema_create")).rows[0];assert.deepEqual(privileges,{database_create:false,schema_create:false});
 await assert.rejects(()=>app.query('CREATE TABLE public.denied_migration_test(id integer)'),error=>error.code==='42501');
 await app.query('SELECT 1 FROM "session" LIMIT 0');
 }finally{await app.end();await owner.end();}
});
