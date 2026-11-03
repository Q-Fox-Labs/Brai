// ABOUTME: Собирает PostgreSQL и MCP независимого live-сервиса Диалогов.
// ABOUTME: Миграции и подготовка входных данных выполняются отдельной owner-операцией.
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { createStore } from "./store.js";
import { startMcp } from "./mcp.js";
import {createLuna} from "./luna.js";
import {createJobs} from "./jobs.js";
function required(name:string){const s=process.env[name]?.trim();if(!s)throw new Error("MISSING_"+name);return s;}
const token=readFileSync(required("DIALOGUES_MCP_TOKEN_FILE"),"utf8").trim();
const port=Number(required("DIALOGUES_MCP_PORT"));if(!Number.isInteger(port)||port<1||port>65535)throw new Error("INVALID_PORT");
const pool=new Pool({connectionString:required("DIALOGUES_DATABASE_URL"),max:8,connectionTimeoutMillis:3000,statement_timeout:10_000});
pool.on("error",()=>console.error('{"service":"dialogues","code":"DATABASE_CONNECTION_ERROR"}'));
let jobs:ReturnType<typeof createJobs>|undefined,luna:ReturnType<typeof createLuna>|undefined;
let mcp:Awaited<ReturnType<typeof startMcp>>;
try {
  if((await pool.query("SELECT version FROM dialogues_live.migrations WHERE version=3")).rowCount!==1)throw new Error("MIGRATION_REQUIRED");
  mcp=await startMcp(createStore(pool,token),{host:required("DIALOGUES_MCP_HOST"),port,owner:required("DIALOGUES_MCP_OWNER_ID"),hosts:required("DIALOGUES_MCP_ALLOWED_HOSTS").split(","),origins:required("DIALOGUES_MCP_ALLOWED_ORIGINS").split(","),token});
  if(process.env.DIALOGUES_SUMMARY_ENABLED==="true"){
    luna=createLuna(required("DIALOGUES_CODEX_SOCKET_URL"),required("DIALOGUES_SUMMARY_CWD"));
    jobs=createJobs(pool,required("DIALOGUES_MCP_OWNER_ID"),luna);jobs.start();
  }
} catch {await pool.end();console.error('{"service":"dialogues","code":"STARTUP_FAILED"}');process.exit(1);}
let stopping=false;
async function stop(){if(stopping)return;stopping=true;await mcp.close();await jobs?.stop();await luna?.close();await pool.end();}
process.once("SIGTERM",()=>void stop());process.once("SIGINT",()=>void stop());
