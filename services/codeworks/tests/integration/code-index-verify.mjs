// ABOUTME: Независимо сверяет только использованную disposable PostgreSQL после приёмки индексов.
// ABOUTME: Не меняет HBA, роли, миграции или данные и не выводит connection strings.
import {Pool} from 'pg';
import {readConfig} from './fixture.mjs';
const config=await readConfig(),pool=new Pool({connectionString:config.owner_url,max:1});
try{
  await pool.query('BEGIN READ ONLY');
  const column=await pool.query("SELECT 1 FROM information_schema.columns WHERE table_schema='codeworks' AND table_name='workspaces' AND column_name='code_index'");
  const migrations=await pool.query('SELECT version FROM public.codeworks_migrations ORDER BY version');
  const roles=await pool.query('SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=ANY($1)',[[config.owner_role,config.app_role,config.verifier_role]]);
  if(column.rowCount!==1||migrations.rows.at(-1)?.version!==9||roles.rowCount!==3||roles.rows.some(r=>Object.values(r).some(Boolean)))throw Error('FIXTURE_VERIFY_FAILED');
  await pool.query('ROLLBACK');console.log('PASS disposable schema 009, separate restricted roles and read-only inspection');
}catch{console.error('FIXTURE_VERIFY_FAILED');process.exitCode=1;}
finally{await pool.end();}
