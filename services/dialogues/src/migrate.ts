// ABOUTME: Применяет только live-миграцию от владельца существующей БД dialogues.
// ABOUTME: Не меняет архивную схему и не передаёт пароль owner в runtime.
import { Pool } from "pg";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const quote=(value:string)=>'"'+value.replaceAll('"','""')+'"';
/** Атомарно подготавливает live-схему с ограниченными правами app. */
export async function migrate(pool:Pool,owner:string,app:string) {
  if(!owner||!app||owner===app)throw new Error("INVALID_ROLES");
  const db=await pool.connect();
  try {
    await db.query("BEGIN");await db.query("SELECT pg_advisory_xact_lock(81374305)");
    const row=(await db.query("SELECT current_user AS role,(SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database()) AS owner")).rows[0];
    if(row.role!==owner||row.owner!==owner)throw new Error("DATABASE_OWNER_REQUIRED");
    const role=(await db.query("SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=$1",[app])).rows[0];
    if(!role||Object.values(role).some(Boolean))throw new Error("UNSAFE_APP_ROLE");
    const ns=(await db.query("SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname='dialogues_live'")).rows[0];
    if(ns&&ns.owner!==owner)throw new Error("SCHEMA_OWNER_CONFLICT");
    await db.query(readFileSync(new URL("../migrations/002_live.sql",import.meta.url),"utf8"));
    await db.query(readFileSync(new URL("../migrations/003_context_jobs.sql",import.meta.url),"utf8"));
    await db.query(readFileSync(new URL("../migrations/004_managed_turns.sql",import.meta.url),"utf8"));
    await db.query("REVOKE ALL ON SCHEMA dialogues_live FROM PUBLIC,"+quote(app));
    await db.query("REVOKE ALL ON ALL TABLES IN SCHEMA dialogues_live FROM PUBLIC,"+quote(app));
    await db.query("REVOKE ALL ON ALL SEQUENCES IN SCHEMA dialogues_live FROM PUBLIC,"+quote(app));
    await db.query("GRANT USAGE ON SCHEMA dialogues_live TO "+quote(app));
    await db.query("GRANT SELECT ON dialogues_live.migrations TO "+quote(app));
    await db.query("GRANT SELECT,INSERT,UPDATE ON dialogues_live.dialogues,dialogues_live.turns TO "+quote(app));
    await db.query("GRANT SELECT,INSERT ON dialogues_live.messages,dialogues_live.message_summaries,dialogues_live.dialogue_summaries,dialogues_live.requests TO "+quote(app));
    await db.query("GRANT SELECT,INSERT,UPDATE ON dialogues_live.context_consumers,dialogues_live.context_deliveries,dialogues_live.summary_jobs,dialogues_live.turn_results TO "+quote(app));
    await db.query("GRANT USAGE,SELECT ON SEQUENCE dialogues_live.change_seq TO "+quote(app));
    await db.query("COMMIT");
  } catch(e){await db.query("ROLLBACK").catch(()=>{});throw e;}
  finally{db.release();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  const pool=new Pool({connectionString:process.env.DIALOGUES_OWNER_DATABASE_URL,connectionTimeoutMillis:5000});
  migrate(pool,process.env.DIALOGUES_OWNER_ROLE??"",process.env.DIALOGUES_APP_ROLE??"").then(()=>console.log("dialogues live migration complete"),()=>{console.error("dialogues live migration failed");process.exitCode=1;}).finally(()=>pool.end());
}
