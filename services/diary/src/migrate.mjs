// ABOUTME: Применяет схему Дневника отдельным владельцем БД.
// ABOUTME: Не создаёт LOGIN/пароли; runtime не получает owner credentials.
import pg from 'pg';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
/** Применяет owner-миграцию только для трёх разных безопасных ролей без runtime membership. */
export async function migrate(db,cfg){
 for(const name of [cfg.ownerRole,cfg.appRole,cfg.workerRole])if(!/^[a-z_][a-z0-9_]{0,62}$/.test(name))throw Error('INVALID_ROLE');
 if(new Set([cfg.ownerRole,cfg.appRole,cfg.workerRole]).size!==3)throw Error('DISTINCT_ROLES_REQUIRED');
 const who=(await db.query('SELECT current_database() AS db,current_user AS name,pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname=current_database()')).rows[0];
 if(who.name!==cfg.ownerRole||who.owner!==cfg.ownerRole)throw Error('OWNER_REQUIRED');
 const roles=await db.query('SELECT oid,rolname,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=ANY($1)',[[cfg.appRole,cfg.workerRole]]);
 if(roles.rows.length!==2||roles.rows.some(r=>r.rolsuper||r.rolcreatedb||r.rolcreaterole||r.rolreplication||r.rolbypassrls))throw Error('UNSAFE_ROLE');
 const memberships=await db.query('SELECT 1 FROM pg_auth_members WHERE member=ANY($1::oid[]) LIMIT 1',[roles.rows.map(r=>r.oid)]);
 if(memberships.rowCount)throw Error('RUNTIME_MEMBERSHIP_FORBIDDEN');
 try{
 await db.query('BEGIN');await db.query(await readFile(new URL('../migrations/001.sql',import.meta.url),'utf8'));
 for(const role of [cfg.appRole,cfg.workerRole])await db.query('GRANT CONNECT ON DATABASE "'+who.db.replaceAll('"','""')+'" TO "'+role+'"');
 await db.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC,"'+cfg.appRole+'","'+cfg.workerRole+'"');
 for(const role of [cfg.appRole,cfg.workerRole])await db.query('GRANT USAGE ON SCHEMA diary TO "'+role+'"');
 await db.query('GRANT SELECT,INSERT,UPDATE ON diary.entries TO "'+cfg.appRole+'"');
 await db.query('GRANT SELECT,UPDATE ON diary.entries TO "'+cfg.workerRole+'"');
 await db.query('DROP POLICY IF EXISTS diary_user ON diary.entries');
 await db.query('CREATE POLICY diary_user ON diary.entries TO "'+cfg.appRole+'" USING(owner_id=current_setting(\'diary.owner_id\',true)) WITH CHECK(owner_id=current_setting(\'diary.owner_id\',true))');
 await db.query('DROP POLICY IF EXISTS diary_worker ON diary.entries');
 await db.query('CREATE POLICY diary_worker ON diary.entries TO "'+cfg.workerRole+'" USING(true) WITH CHECK(true)');
 await db.query('REVOKE ALL ON SCHEMA diary FROM PUBLIC');await db.query('REVOKE ALL ON diary.entries FROM PUBLIC');
 await db.query('COMMIT');
 }catch(error){await db.query('ROLLBACK').catch(()=>{});throw error;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const cfg=JSON.parse(await readFile(process.env.DIARY_CONFIG,'utf8')),db=new pg.Client({connectionString:cfg.ownerDatabaseUrl});
 try{await db.connect();await migrate(db,cfg);console.log('DIARY_SCHEMA_READY');}
 catch{console.error('DIARY_MIGRATION_FAILED');process.exitCode=1;}finally{await db.end();}
}
