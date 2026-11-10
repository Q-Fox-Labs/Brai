// ABOUTME: Выполняет миграции отдельной owner-ролью bug-hunt.
// ABOUTME: Runtime получает ограниченные DML-права и не запускает этот entrypoint.
import {readFileSync} from "node:fs";
import {pathToFileURL} from "node:url";
import {Pool} from "pg";
const ident=(value:string)=>{if(!/^[a-z][a-z0-9_]{0,62}$/.test(value))throw new Error("INVALID_ROLE");return '"'+value+'"';};
/** Повторно применяет схему и ограниченные права без удаления существующих данных. */
export async function migrate(pool:Pool,ownerRole:string,appRole:string){
 if(ownerRole===appRole)throw new Error("DISTINCT_ROLES_REQUIRED");
 const owner=ident(ownerRole),app=ident(appRole),db=await pool.connect();
 try{
  await db.query("BEGIN");
  await db.query("SELECT pg_advisory_xact_lock(79001501)");
  const current=await db.query("SELECT current_user AS name");
  if(current.rows[0].name!==ownerRole)throw new Error("OWNER_ROLE_REQUIRED");
  const identity=(await db.query("SELECT current_database() AS name,pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname=current_database()")).rows[0];
  if(identity.owner!==ownerRole)throw new Error("DATABASE_OWNER_REQUIRED");
  const runtime=(await db.query("SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,EXISTS(SELECT 1 FROM pg_auth_members WHERE member=pg_roles.oid) AS memberships FROM pg_roles WHERE rolname=$1",[appRole])).rows[0];
  if(!runtime||Object.values(runtime).some(Boolean))throw new Error("UNSAFE_RUNTIME_ROLE");
  const database='"'+identity.name.replaceAll('"','""')+'"';
  await db.query("REVOKE ALL ON DATABASE "+database+" FROM PUBLIC");
  await db.query("REVOKE CREATE,TEMPORARY ON DATABASE "+database+" FROM "+app);
  await db.query("GRANT CONNECT ON DATABASE "+database+" TO "+app);
  await db.query(readFileSync(new URL("../migrations/001.sql",import.meta.url),"utf8"));
  await db.query("REVOKE CREATE ON SCHEMA public FROM PUBLIC,"+app);
  await db.query("GRANT USAGE ON SCHEMA public TO "+app);
  await db.query("REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC,"+app);
  await db.query("GRANT SELECT ON sys_schema,bug_case,report,review,mutation TO "+app);
  await db.query("GRANT INSERT ON bug_case,report,review,mutation TO "+app);
  await db.query("GRANT UPDATE(review_state,revision,updated_at) ON bug_case TO "+app);
  await db.query("COMMIT");
 }catch(error){await db.query("ROLLBACK");throw error;}finally{db.release();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const pool=new Pool({connectionString:process.env.BUG_HUNT_OWNER_DATABASE_URL,connectionTimeoutMillis:3000,max:1});
 try{if(!process.env.BUG_HUNT_OWNER_DATABASE_URL)throw new Error();await migrate(pool,process.env.BUG_HUNT_OWNER_ROLE??"",process.env.BUG_HUNT_APP_ROLE??"");}
 catch{console.error("BUG_HUNT_MIGRATION_FAILED");process.exitCode=1;}finally{await pool.end();}
}
