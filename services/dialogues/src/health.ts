// ABOUTME: Проверяет live-миграцию PostgreSQL и локальный listener Диалогов.
// ABOUTME: Не читает тексты переписки и не раскрывает входные данные.
import { Pool } from "pg";
import {verifyOwnerConnection} from "./isolation.js";
import {connectAuthAccess} from './auth-access.js';
import {createPersonalAuthorizer} from "./personal-auth.js";
import {summaryQueueStatus} from './jobs.js';
const pool=new Pool({connectionString:process.env.DIALOGUES_DATABASE_URL,max:1,connectionTimeoutMillis:3000});
const queueStatus=process.argv[2]==='--summary-queue';
let authAccess:Awaited<ReturnType<typeof connectAuthAccess>>|undefined;
try {
  const version=await pool.query("SELECT version FROM dialogues_live.migrations WHERE version=$1",[process.env.DIALOGUES_MCP_USER_ID?6:5]);
  if(version.rowCount!==1)throw new Error("MIGRATION_REQUIRED");
  if(process.env.DIALOGUES_MCP_USER_ID)await verifyOwnerConnection(pool,{userId:process.env.DIALOGUES_MCP_USER_ID,ownerId:process.env.DIALOGUES_MCP_OWNER_ID??"",profileId:process.env.DIALOGUES_MCP_PROFILE_ID??""});
  if(!queueStatus&&process.env.DIALOGUES_MCP_USER_ID&&process.env.DIALOGUES_HEALTH_DATABASE_ONLY!=='true'){
    const binding={userId:process.env.DIALOGUES_MCP_USER_ID,profileId:process.env.DIALOGUES_MCP_PROFILE_ID??''};
    authAccess=process.env.DIALOGUES_AUTH_SUBJECT?await connectAuthAccess(process.env,binding):undefined;
    await (authAccess?.authorize??createPersonalAuthorizer(process.env.DIALOGUES_IDENTITY_SOCKET??'',binding))();
  }
  if(queueStatus){
    const owner=process.env.DIALOGUES_MCP_OWNER_ID;
    if(!owner)throw new Error('MISSING_OWNER');
    console.log(JSON.stringify(await summaryQueueStatus(pool,owner)));
  }else{
    const host=process.env.DIALOGUES_MCP_HOST==="::1"?"[::1]":"127.0.0.1";
    const response=await fetch("http://"+host+":"+process.env.DIALOGUES_MCP_PORT+"/health",{signal:AbortSignal.timeout(3000),redirect:"error"});
    if(response.status!==200)throw new Error("LISTENER_UNAVAILABLE");
    const health=await response.json() as {ready?:boolean;tools?:string[]};
    if(health.ready!==true||health.tools?.slice().sort().join(',')!=='dialogues_context_ack,dialogues_exchange')throw new Error("TOOLS_UNAVAILABLE");
    console.log("dialogues ready");
  }
} catch {console.error("dialogues unavailable");process.exitCode=1;}
finally{await authAccess?.close();await pool.end();}
