// ABOUTME: Собирает PostgreSQL и MCP независимого live-сервиса Диалогов.
// ABOUTME: Миграции и подготовка входных данных выполняются отдельной owner-операцией.
import {createSubscriptionLuna} from './subscription-luna.js';
import { readFileSync,statSync } from "node:fs";
import { Pool } from "pg";
import { createStore } from "./store.js";
import { startMcp } from "./mcp.js";
import {createLuna} from "./luna.js";
import {startTopicSocket,suggestTopic} from './topic-socket.js';
import {createJobs} from "./jobs.js";
import {createTopicJobs,seedTopicIndex} from "./topic-jobs.js";
import {DialoguesFault} from "./domain.js";
import {verifyOwnerConnection} from "./isolation.js";
import {connectAuthAccess} from './auth-access.js';
import {createPersonalAuthorizer} from "./personal-auth.js";
import {createPersonalSummarizer} from "./personal-summary.js";
function required(name:string){const s=process.env[name]?.trim();if(!s)throw new Error("MISSING_"+name);return s;}
const token=readFileSync(required("DIALOGUES_MCP_TOKEN_FILE"),"utf8").trim();
const port=Number(required("DIALOGUES_MCP_PORT"));if(!Number.isInteger(port)||port<1||port>65535)throw new Error("INVALID_PORT");
const pool=new Pool({connectionString:required("DIALOGUES_DATABASE_URL"),max:2,idleTimeoutMillis:10_000,connectionTimeoutMillis:3000,statement_timeout:10_000});
pool.on("error",()=>console.error('{"service":"dialogues","code":"DATABASE_CONNECTION_ERROR"}'));
let jobs:ReturnType<typeof createJobs>|undefined,luna:ReturnType<typeof createLuna>|ReturnType<typeof createPersonalSummarizer>|undefined;
let authAccess:Awaited<ReturnType<typeof connectAuthAccess>>|undefined;
let mcp:Awaited<ReturnType<typeof startMcp>>;
let closeTopics:Awaited<ReturnType<typeof startTopicSocket>>|undefined;
try {
  if((await pool.query("SELECT version FROM dialogues_live.migrations WHERE version=9")).rowCount!==1)throw new Error("MIGRATION_REQUIRED");
  const owner=required("DIALOGUES_MCP_OWNER_ID");
  const isolated=Boolean((await pool.query('SELECT 1 FROM dialogues_live.migrations WHERE version=6')).rowCount);
  let personal:Parameters<typeof startMcp>[1]['personal'];
  let cursorKey=token;
  if(isolated||process.env.DIALOGUES_MCP_USER_ID){
    const binding={userId:required('DIALOGUES_MCP_USER_ID'),ownerId:owner,profileId:required('DIALOGUES_MCP_PROFILE_ID')};
    await verifyOwnerConnection(pool,binding);
    cursorKey=readFileSync(required('DIALOGUES_CURSOR_KEY_FILE'),'utf8').trim();
    if(!/^[A-Za-z0-9_-]{32,128}$/.test(cursorKey))throw new Error('INVALID_CURSOR_KEY');
    authAccess=process.env.DIALOGUES_AUTH_SUBJECT?await connectAuthAccess(process.env,binding):undefined;
    const authorize=authAccess?.authorize??createPersonalAuthorizer(required('DIALOGUES_IDENTITY_SOCKET'),binding);
    personal={userId:binding.userId,profileId:binding.profileId,authorize:async()=>{
      await authorize();
      const row=(await pool.query('SELECT * FROM dialogues_access.current_binding()')).rows[0];
      if(!row||row.user_id!==binding.userId||row.owner_id!==binding.ownerId||row.profile_id!==binding.profileId)throw new Error('PERSONAL_BINDING_CHANGED');
    }};
    if(process.env.DIALOGUES_OPERATOR_TOKEN_FILE)personal.operatorToken=readFileSync(required('DIALOGUES_OPERATOR_TOKEN_FILE'),'utf8').trim();
    // AIDEV-NOTE: Общий управляющий socket Codex не передаётся персональному runtime.
    if(process.env.DIALOGUES_SUMMARY_ENABLED==='true'){
      if(authAccess){
        const subscription=JSON.parse(readFileSync(required('DIALOGUES_SUBSCRIPTION_CONFIG_FILE'),'utf8'));
        luna=createSubscriptionLuna(subscription);
        personal.suggestTopic=async (input,signal)=>{
          signal.throwIfAborted();
          const generator=createSubscriptionLuna(subscription);
          const abort=()=>{void generator.close();};
          signal.addEventListener('abort',abort,{once:true});
          try{return await suggestTopic(input,generator);}
          finally{signal.removeEventListener('abort',abort);await generator.close();}
        };
      }else{
        luna=createPersonalSummarizer(required('DIALOGUES_IDENTITY_SOCKET'),personal.authorize);
      }
    }
  }
  if((await pool.query("SELECT 1 FROM dialogues_live.messages m WHERE m.owner_id=$1 AND char_length(m.text)>100 AND NOT EXISTS(SELECT 1 FROM dialogues_live.message_summaries s WHERE s.owner_id=m.owner_id AND s.dialogue_id=m.dialogue_id AND s.message_id=m.id) LIMIT 1",[owner])).rowCount)throw new Error("BACKFILL_REQUIRED");
  if(process.env.DIALOGUES_SUMMARY_ENABLED==="true"&&!personal)
    luna=createLuna(required("DIALOGUES_CODEX_SOCKET_URL"),required("DIALOGUES_SUMMARY_CWD"));
  if (process.env.DIALOGUES_TELEGRAM_TOPIC_SOCKET) {
    if (personal) throw new Error('SHARED_TOPIC_SOCKET_FOR_PERSONAL_PROFILE');
    closeTopics=await startTopicSocket(required('DIALOGUES_TELEGRAM_TOPIC_SOCKET'),
      required('DIALOGUES_CODEX_SOCKET_URL'),required('DIALOGUES_SUMMARY_CWD'));
  }
  const generator=luna;
  const topicJobs=generator&&'structured' in generator?createTopicJobs(pool,owner,generator,personal?.authorize):undefined;
  if(topicJobs)await topicJobs.seed();
  else await seedTopicIndex(pool,owner);
  const marker=process.env.DIALOGUES_MCP_HOLD_FILE;
  const hold=marker?{active:()=>statSync(marker,{throwIfNoEntry:false})!==undefined,
    token:readFileSync(required('DIALOGUES_MCP_HOLD_TOKEN_FILE'),'utf8').trim()}:undefined;
  mcp=await startMcp(createStore(pool,cursorKey),{host:required("DIALOGUES_MCP_HOST"),port,owner:required("DIALOGUES_MCP_OWNER_ID"),hosts:required("DIALOGUES_MCP_ALLOWED_HOSTS").split(","),origins:required("DIALOGUES_MCP_ALLOWED_ORIGINS").split(","),token,personal,hold});
  if(generator){
    jobs=createJobs(pool,owner,generator,personal?.authorize,topicJobs&& (async()=>{
      try{return await topicJobs.tick();}
      catch(error){
        const details=error instanceof DialoguesFault&&error.code==='TOPIC_SUMMARY_TOO_LONG'?error.details:undefined;
        console.error(JSON.stringify({service:'dialogues',event:'topic_job_failed',code:error instanceof DialoguesFault?error.code:'INTERNAL',
          ...(Number.isInteger(details?.extended_tokens)?{extended_tokens:details!.extended_tokens}:{}),
          ...(Number.isInteger(details?.compact_tokens)?{compact_tokens:details!.compact_tokens}:{})}));
        return false;
      }
    }));jobs.start();
  }
} catch(error) {await closeTopics?.();await luna?.close();await authAccess?.close();await pool.end();const code=error instanceof Error&&error.message==='BACKFILL_REQUIRED'?'BACKFILL_REQUIRED':'STARTUP_FAILED';console.error(JSON.stringify({service:'dialogues',code}));process.exit(1);}
let stopping=false;
async function stop(){if(stopping)return;stopping=true;await closeTopics?.();await mcp.close();await jobs?.stop();await luna?.close();await authAccess?.close();await pool.end();}
process.once("SIGTERM",()=>void stop());process.once("SIGINT",()=>void stop());
