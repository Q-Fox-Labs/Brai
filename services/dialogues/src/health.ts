// ABOUTME: Проверяет live-миграцию PostgreSQL и локальный listener Диалогов.
// ABOUTME: Не читает тексты переписки и не раскрывает входные данные.
import { Pool } from "pg";
import {verifyOwnerConnection} from "./isolation.js";
import {createPersonalAuthorizer} from "./personal-auth.js";
const pool=new Pool({connectionString:process.env.DIALOGUES_DATABASE_URL,max:1,connectionTimeoutMillis:3000});
try {
  const version=await pool.query("SELECT version FROM dialogues_live.migrations WHERE version=$1",[process.env.DIALOGUES_MCP_USER_ID?6:5]);
  if(version.rowCount!==1)throw new Error("MIGRATION_REQUIRED");
  if(process.env.DIALOGUES_MCP_USER_ID)await verifyOwnerConnection(pool,{userId:process.env.DIALOGUES_MCP_USER_ID,ownerId:process.env.DIALOGUES_MCP_OWNER_ID??"",profileId:process.env.DIALOGUES_MCP_PROFILE_ID??""});
  if(process.env.DIALOGUES_MCP_USER_ID&&process.env.DIALOGUES_HEALTH_DATABASE_ONLY!=='true'){
    await createPersonalAuthorizer(process.env.DIALOGUES_IDENTITY_SOCKET??'',{userId:process.env.DIALOGUES_MCP_USER_ID,profileId:process.env.DIALOGUES_MCP_PROFILE_ID??''})();
  }
  const host=process.env.DIALOGUES_MCP_HOST==="::1"?"[::1]":"127.0.0.1";
  const response=await fetch("http://"+host+":"+process.env.DIALOGUES_MCP_PORT+"/health",{signal:AbortSignal.timeout(3000)});
  if(!response.ok)throw new Error("LISTENER_UNAVAILABLE");
  console.log("dialogues ready");
} catch {console.error("dialogues unavailable");process.exitCode=1;}
finally{await pool.end();}
