// ABOUTME: Применяет миграцию и минимальные права прикладной роли.
// ABOUTME: Запускается отдельно с владельцем БД; процесс таймера DDL не выполняет.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
const quote=(name:string)=>'"'+name.replaceAll('"','""')+'"';
/** Повторно применяет версию 1 и grants в одной транзакции; роли создаёт оператор. */
export async function migrate(pool: Pool, ownerRole: string, appRole: string) {
  if (!ownerRole || !appRole || ownerRole===appRole) throw new Error("OWNER_AND_APP_MUST_DIFFER");
  const client=await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(28491837)");
    const {rows}=await client.query("SELECT current_user AS role,current_database() AS db,(SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database()) AS owner");
    if(rows[0].role!==ownerRole||rows[0].owner!==ownerRole) throw new Error("MIGRATION_REQUIRES_DATABASE_OWNER");
    const app=(await client.query("SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=$1",[appRole])).rows[0];
    if(!app||Object.values(app).some(Boolean)) throw new Error("UNSAFE_RUNTIME_ROLE");
    await client.query(`REVOKE ALL ON DATABASE ${quote(rows[0].db)} FROM PUBLIC`);
    await client.query("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
    await client.query(readFileSync(new URL("../migrations/001.sql",import.meta.url),"utf8"));
    await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA timer FROM PUBLIC,${quote(appRole)}`);
    await client.query(`GRANT CONNECT ON DATABASE ${quote(rows[0].db)} TO ${quote(appRole)}`);
    await client.query(`REVOKE ALL ON SCHEMA timer FROM ${quote(appRole)}`);
    await client.query(`GRANT USAGE ON SCHEMA timer TO ${quote(appRole)}`);
    await client.query(`GRANT SELECT ON timer.state,timer.intervals,timer.commands TO ${quote(appRole)}`);
    await client.query(`GRANT INSERT ON timer.intervals,timer.commands TO ${quote(appRole)}`);
    await client.query(`GRANT UPDATE(version,active_timer_id) ON timer.state TO ${quote(appRole)}`);
    await client.query(`GRANT UPDATE(stopped_at,duration_ms) ON timer.intervals TO ${quote(appRole)}`);
    await client.query("COMMIT");
  } catch(error){await client.query("ROLLBACK").catch(()=>{});throw error;}finally{client.release();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 if(!process.env.DATABASE_URL)throw new Error("DATABASE_URL_REQUIRED");
 const pool=new Pool({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:5000});
 try {await migrate(pool,process.env.TIMER_OWNER_ROLE??"",process.env.TIMER_APP_ROLE??"");console.log("timer migration complete");}
 catch(error){console.error("timer migration failed",error instanceof Error?error.message:"UNKNOWN");process.exitCode=1;}
 finally{await pool.end();}
}
