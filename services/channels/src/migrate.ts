// ABOUTME: Применяет собственную схему и установленный профиль отдельной owner-ролью.
// ABOUTME: Runtime не получает DDL, удаления или обновления исторических записей.
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {Pool} from 'pg';
import {hash,profile} from './contracts.js';
/** Применяет идемпотентный DDL и проверяет неизменяемую семантику профиля. */
export async function migrate(pool:Pool,role:string):Promise<void>{
 if(!/^[a-z_][a-z0-9_]{0,62}$/.test(role))throw Error('INVALID_RUNTIME_ROLE');
 const c=await pool.connect();
 try{
  await c.query('BEGIN');await c.query('SELECT pg_advisory_xact_lock(81632501)');
  const identity=(await c.query("SELECT current_user AS role,(SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database()) AS owner")).rows[0];
  if(identity.role!==identity.owner||identity.role===role)throw Error('DEDICATED_DATABASE_OWNER_REQUIRED');
  const flags=(await c.query('SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=$1',[role])).rows[0];
  if(!flags||Object.values(flags).some(Boolean)||(await c.query('SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=$1)',[role])).rowCount)throw Error('UNSAFE_RUNTIME_ROLE');
  await c.query(await readFile(new URL('../migrations/001.sql',import.meta.url),'utf8'));
  const old=(await c.query('SELECT descriptor FROM channels.sys_channel_types WHERE code=$1 AND version=$2',[profile.type.code,profile.type.version])).rows[0]?.descriptor;
  if(old&&hash({...old,name:profile.name})!==hash(profile))throw Error('PROFILE_SEMANTICS_CONFLICT');
  if(!old)await c.query('INSERT INTO channels.sys_channel_types(code,version,name,descriptor) VALUES($1,$2,$3,$4)',[profile.type.code,profile.type.version,profile.name,profile]);
  await c.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
  await c.query('REVOKE ALL ON SCHEMA channels FROM "'+role+'"');await c.query('REVOKE ALL ON ALL TABLES IN SCHEMA channels FROM "'+role+'"');
  await c.query('GRANT USAGE ON SCHEMA channels TO "'+role+'"');
  await c.query('GRANT SELECT ON ALL TABLES IN SCHEMA channels TO "'+role+'"');
  await c.query('GRANT INSERT ON channels.channel_connections,channels.channel_connection_versions,channels.channels,channels.channel_versions,channels.channel_resolutions,channels.channel_operation_receipts TO "'+role+'"');
  await c.query('GRANT UPDATE(current_version) ON channels.channel_connections,channels.channels TO "'+role+'"');
  await c.query('COMMIT');
 }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 const url=process.env.CHANNELS_OWNER_DATABASE_URL,role=process.env.CHANNELS_RUNTIME_ROLE;if(!url||!role)throw Error('MISSING_MIGRATION_CONFIG');
 const pool=new Pool({connectionString:url,max:1});
 try{await migrate(pool,role);}finally{await pool.end();}
}
