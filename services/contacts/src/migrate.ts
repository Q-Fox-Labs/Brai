// ABOUTME: Применяет собственную схему Контактов отдельной owner-ролью.
// ABOUTME: Runtime не получает DDL, удаления или обновления исторических записей.
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {Pool} from 'pg';
/** Применяет идемпотентный DDL и проверяет отдельные owner/runtime роли. */
export async function migrate(pool:Pool,role:string):Promise<void>{
 if(!/^[a-z_][a-z0-9_]{0,62}$/.test(role))throw Error('INVALID_RUNTIME_ROLE');
 const c=await pool.connect();
 try{
  await c.query('BEGIN');await c.query('SELECT pg_advisory_xact_lock(81632502)');
  const identity=(await c.query("SELECT current_user AS role,(SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database()) AS owner")).rows[0];
  if(identity.role!==identity.owner||identity.role===role)throw Error('DEDICATED_DATABASE_OWNER_REQUIRED');
  const flags=(await c.query('SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=$1',[role])).rows[0];
  if(!flags||Object.values(flags).some(Boolean)||(await c.query('SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=$1)',[role])).rowCount)throw Error('UNSAFE_RUNTIME_ROLE');
  await c.query(await readFile(new URL('../migrations/001.sql',import.meta.url),'utf8'));
  await c.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
  await c.query('REVOKE ALL ON SCHEMA contacts FROM "'+role+'"');await c.query('REVOKE ALL ON ALL TABLES IN SCHEMA contacts FROM "'+role+'"');
  await c.query('GRANT USAGE ON SCHEMA contacts TO "'+role+'"');
  await c.query('GRANT SELECT ON ALL TABLES IN SCHEMA contacts TO "'+role+'"');
  await c.query('GRANT INSERT ON contacts.contacts,contacts.contact_identities,contacts.contact_operations TO "'+role+'"');
  await c.query('GRANT UPDATE(name,username,photo_artifact_id,field_origins,first_observed_at,last_observed_at) ON contacts.contact_identities TO "'+role+'"');
  await c.query('COMMIT');
 }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 const url=process.env.CONTACTS_OWNER_DATABASE_URL,role=process.env.CONTACTS_RUNTIME_ROLE;if(!url||!role)throw Error('MISSING_MIGRATION_CONFIG');
 const pool=new Pool({connectionString:url,max:1});
 try{await migrate(pool,role);}finally{await pool.end();}
}
