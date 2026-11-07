// ABOUTME: Применяет изоляцию и выдаёт персональные права отдельно от runtime.
// ABOUTME: Не создаёт логины и не изменяет исходную историю или привязку другого аккаунта.
import type {Pool,PoolClient} from 'pg';
import {readFileSync} from 'node:fs';

export const ownerTables=['dialogues','turns','messages','message_summaries','dialogue_summaries','requests',
 'context_consumers','context_deliveries','summary_jobs','turn_results','exchange_events','message_backfill'] as const;
export type OwnerBinding={userId:string;ownerId:string;profileId:string};
const quote=(value:string)=>'"'+value.replaceAll('"','""')+'"';
const valid=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=256&&!value.includes('\0');

/** Проверяет оператора миграции; приложение не может подготовить себе права. */
async function requireOwner(db:PoolClient,owner:string){
 const result=await db.query("SELECT current_user AS actor,pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname=current_database()");
 if(!owner||result.rows[0]?.actor!==owner||result.rows[0]?.owner!==owner)throw new Error('DATABASE_OWNER_REQUIRED');
 for(const schema of ['dialogues_live','dialogues_access']){
  const row=(await db.query("SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname=$1",[schema])).rows[0];
  if(row&&row.owner!==owner)throw new Error('SCHEMA_OWNER_CONFLICT');
 }
}

/** Включает миграцию 006 только явно; непривязанный старый runtime после неё закрыт. */
export async function migrateIsolation(pool:Pool,owner:string){
 const db=await pool.connect();
 try{
  await db.query('BEGIN');await db.query('SELECT pg_advisory_xact_lock(81374305)');
  await requireOwner(db,owner);
  if(!(await db.query('SELECT 1 FROM dialogues_live.migrations WHERE version=5')).rowCount)throw new Error('MIGRATION_REQUIRED');
  const foreign=(await db.query("SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('dialogues_live','dialogues_access') AND c.relkind IN ('r','p') AND pg_get_userbyid(c.relowner)<>$1 LIMIT 1",[owner])).rowCount;
  if(foreign)throw new Error('TABLE_OWNER_CONFLICT');
  await db.query(readFileSync(new URL('../migrations/006_owner_isolation.sql',import.meta.url),'utf8'));
  await db.query('COMMIT');
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}

/** Идемпотентно привязывает заранее созданный безопасный логин без переписывания owner_id. */
export async function bindOwner(pool:Pool,owner:string,login:string,binding:OwnerBinding){
 if(!/^[a-z][a-z0-9_]{0,62}$/.test(login)||!binding||!Object.values(binding).every(valid)||
  Object.keys(binding).sort().join(',')!=='ownerId,profileId,userId')throw new Error('INVALID_BINDING');
 const db=await pool.connect();
 try{
  await db.query('BEGIN');await db.query('SELECT pg_advisory_xact_lock(81374305)');
  await requireOwner(db,owner);
  if(login===owner)throw new Error('UNSAFE_APP_ROLE');
  const role=(await db.query("SELECT rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=$1",[login])).rows[0];
  if(!role||!role.rolcanlogin||Object.entries(role).some(([key,value])=>key!=='rolcanlogin'&&value))throw new Error('UNSAFE_APP_ROLE');
  if((await db.query('SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=$1)',[login])).rowCount)throw new Error('UNSAFE_ROLE_MEMBERSHIP');
  const owns=(await db.query("SELECT 1 FROM pg_class WHERE relowner=(SELECT oid FROM pg_roles WHERE rolname=$1) LIMIT 1",[login])).rowCount;
  if(owns)throw new Error('UNSAFE_ROLE_OWNERSHIP');
  await db.query('INSERT INTO dialogues_access.sys_owner_bindings(login_role,user_id,owner_id,profile_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[login,binding.userId,binding.ownerId,binding.profileId]);
  const row=(await db.query('SELECT user_id,owner_id,profile_id,enabled FROM dialogues_access.sys_owner_bindings WHERE login_role=$1',[login])).rows[0];
  if(!row||row.user_id!==binding.userId||row.owner_id!==binding.ownerId||row.profile_id!==binding.profileId||!row.enabled)throw new Error('BINDING_CONFLICT');
  const name=quote(login);
  await db.query('REVOKE ALL ON SCHEMA dialogues_access FROM '+name);
  await db.query('REVOKE ALL ON ALL TABLES IN SCHEMA dialogues_access FROM '+name);
  await db.query('GRANT USAGE ON SCHEMA dialogues_live,dialogues_access TO '+name);
  await db.query('GRANT EXECUTE ON FUNCTION dialogues_access.current_binding() TO '+name);
  await db.query('REVOKE ALL ON ALL TABLES IN SCHEMA dialogues_live FROM '+name);
  await db.query('GRANT SELECT ON dialogues_live.migrations TO '+name);
  await db.query('GRANT SELECT,INSERT,UPDATE ON dialogues_live.dialogues,dialogues_live.turns,dialogues_live.context_consumers,dialogues_live.context_deliveries,dialogues_live.summary_jobs,dialogues_live.turn_results,dialogues_live.message_backfill TO '+name);
  await db.query('GRANT SELECT,INSERT ON dialogues_live.messages,dialogues_live.message_summaries,dialogues_live.dialogue_summaries,dialogues_live.requests,dialogues_live.exchange_events TO '+name);
  await db.query('GRANT USAGE,SELECT ON SEQUENCE dialogues_live.change_seq TO '+name);
  await db.query('COMMIT');
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}

/** До работы с данными сверяет аккаунт, профиль, права и все политики одной SQL-сессии. */
export async function verifyOwnerConnection(pool:Pool,binding:OwnerBinding){
 const db=await pool.connect();
 try{
  const role=(await db.query("SELECT current_user=session_user AS original,rolsuper,rolbypassrls,rolcreaterole,rolcreatedb,rolreplication FROM pg_roles WHERE rolname=session_user")).rows[0];
  if(!role?.original||Object.entries(role).some(([key,value])=>key!=='original'&&value))throw new Error('UNSAFE_APP_ROLE');
  const row=(await db.query('SELECT * FROM dialogues_access.current_binding()')).rows[0];
  if(!row||row.user_id!==binding.userId||row.owner_id!==binding.ownerId||row.profile_id!==binding.profileId)throw new Error('BINDING_MISMATCH');
  const result=await db.query(`SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity,
   pg_get_userbyid(c.relowner)=session_user AS owns,
   EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid AND p.polname='personal_owner' AND NOT p.polpermissive) AS guarded
   FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='dialogues_live' AND c.relname=ANY($1::text[])`,[ownerTables]);
  if(result.rows.length!==ownerTables.length||result.rows.some(r=>!r.relrowsecurity||!r.relforcerowsecurity||r.owns||!r.guarded))throw new Error('ISOLATION_REQUIRED');
  if((await db.query('SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=session_user)')).rowCount)throw new Error('UNSAFE_ROLE_MEMBERSHIP');
  if(!(await db.query('SELECT 1 FROM dialogues_live.migrations WHERE version=6')).rowCount)throw new Error('MIGRATION_REQUIRED');
 }finally{db.release();}
}
