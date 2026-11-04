// ABOUTME: Проверяет live-миграцию PostgreSQL и локальный listener Диалогов.
// ABOUTME: Не читает тексты переписки и не раскрывает входные данные.
import { Pool } from "pg";
const pool=new Pool({connectionString:process.env.DIALOGUES_DATABASE_URL,connectionTimeoutMillis:3000});
try {
  const version=await pool.query("SELECT version FROM dialogues_live.migrations WHERE version=4");
  if(version.rowCount!==1)throw new Error("MIGRATION_REQUIRED");
  const host=process.env.DIALOGUES_MCP_HOST==="::1"?"[::1]":"127.0.0.1";
  const response=await fetch("http://"+host+":"+process.env.DIALOGUES_MCP_PORT+"/health",{signal:AbortSignal.timeout(3000)});
  if(!response.ok)throw new Error("LISTENER_UNAVAILABLE");
  console.log("dialogues ready");
} catch {console.error("dialogues unavailable");process.exitCode=1;}
finally{await pool.end();}
