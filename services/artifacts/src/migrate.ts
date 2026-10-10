// ABOUTME: Применяет собственную миграцию artifacts и минимальные права runtime.
// ABOUTME: Проверяет владельца БД и роли до DDL; запускается отдельно от сервиса.
import {readFileSync} from "node:fs";
import {pathToFileURL} from "node:url";
import {Pool} from "pg";
const quote=(name:string)=>'"'+name.replaceAll('"','""')+'"';
/** Выполняет DDL атомарно под владельцем отдельной БД; роли создаёт оператор. */
export async function migrate(pool:Pool,ownerRole:string,appRole:string) {
  if(!ownerRole||!appRole||ownerRole===appRole)throw new Error("OWNER_AND_APP_MUST_DIFFER");
  const client=await pool.connect();
  try{
    await client.query("BEGIN");await client.query("SELECT pg_advisory_xact_lock(73490218)");
    const {rows}=await client.query("SELECT current_user AS role,current_database() AS db,(SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database()) AS owner");
    const identity=rows[0];if(identity.role!==ownerRole||identity.owner!==ownerRole)throw new Error("MIGRATION_REQUIRES_DATABASE_OWNER");
    const roles=(await client.query("SELECT rolname,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=ANY($1::text[])",[[ownerRole,appRole]])).rows;
    if(roles.length!==2||roles.some(role=>Object.entries(role).some(([key,value])=>key!=="rolname"&&value)))throw new Error("UNSAFE_DATABASE_ROLE");
    const memberships=(await client.query("SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON m.member=r.oid WHERE r.rolname=ANY($1::text[]) LIMIT 1",[[ownerRole,appRole]])).rowCount;
    if(memberships)throw new Error("DATABASE_ROLE_MEMBERSHIP_NOT_ALLOWED");
    await client.query(`REVOKE ALL ON DATABASE ${quote(identity.db)} FROM PUBLIC,${quote(appRole)}`);
    await client.query("REVOKE CREATE ON SCHEMA public FROM PUBLIC");await client.query(`REVOKE ALL ON SCHEMA public FROM ${quote(appRole)}`);
    const exists=(await client.query("SELECT to_regclass('artifacts.migrations') AS table_name")).rows[0].table_name;
    if(!exists)await client.query(readFileSync(new URL("../migrations/001.sql",import.meta.url),"utf8"));
    else if(!(await client.query("SELECT 1 FROM artifacts.migrations WHERE version=1")).rowCount)throw new Error("UNKNOWN_MIGRATION_STATE");
    if(!(await client.query("SELECT 1 FROM artifacts.migrations WHERE version=2")).rowCount)await client.query(readFileSync(new URL("../migrations/002.sql",import.meta.url),"utf8"));
    await client.query(`REVOKE ALL ON SCHEMA artifacts FROM PUBLIC,${quote(appRole)}`);
    await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA artifacts FROM PUBLIC,${quote(appRole)}`);
    await client.query(`GRANT CONNECT ON DATABASE ${quote(identity.db)} TO ${quote(appRole)}`);
    await client.query(`GRANT USAGE ON SCHEMA artifacts TO ${quote(appRole)}`);
    const tables="artifacts.artifacts,artifacts.artifact_links,artifacts.artifact_relations,artifacts.artifact_references,artifacts.artifact_output_bindings";
    await client.query(`GRANT SELECT,INSERT ON ${tables} TO ${quote(appRole)}`);
    await client.query(`GRANT UPDATE(status,source,size_bytes,document) ON artifacts.artifacts TO ${quote(appRole)}`);
    await client.query(`GRANT UPDATE(document) ON artifacts.artifact_links,artifacts.artifact_references TO ${quote(appRole)}`);
    await client.query(`GRANT DELETE ON artifacts.artifact_relations TO ${quote(appRole)}`);
    await client.query("COMMIT");
  }catch(error){await client.query("ROLLBACK").catch(()=>{});throw error;}finally{client.release();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const pool=new Pool({connectionString:process.env.ARTIFACTS_DATABASE_URL,connectionTimeoutMillis:5000,statement_timeout:10000});
  try{if(!process.env.ARTIFACTS_DATABASE_URL)throw new Error("ARTIFACTS_DATABASE_URL_REQUIRED");await migrate(pool,process.env.ARTIFACTS_OWNER_ROLE??"",process.env.ARTIFACTS_APP_ROLE??"");console.log("artifacts migration complete");}
  catch(error){console.error("artifacts migration failed",error instanceof Error&&/^[A-Z_]+$/.test(error.message)?error.message:"MIGRATION_FAILED");process.exitCode=1;}
  finally{await pool.end();}
}
