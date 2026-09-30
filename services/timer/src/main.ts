// ABOUTME: Собирает PostgreSQL, NATS и прикладной поток таймера в один процесс.
// ABOUTME: Не создаёт БД и роли и не выполняет миграции при запуске.
import { Pool } from "pg";
import { config } from "./config.js";
import { createStore } from "./storage.js";
import { connectNats, runNats } from "./nats.js";
const cfg=config();
const pool=new Pool({connectionString:cfg.databaseURL,max:4,connectionTimeoutMillis:5000,statement_timeout:30000});
pool.on("error",()=>console.error("timer database connection error"));
const nc=await connectNats(cfg);
try{
 const runtime=await runNats(nc,cfg,createStore(pool));
 console.log("timer ready");
 let stopping=false;
 const stop=async()=>{if(stopping)return;stopping=true;await runtime.stop();await nc.drain();await pool.end();};
 process.on("SIGTERM",()=>void stop());process.on("SIGINT",()=>void stop());
 await nc.closed();await stop();
}catch(error){console.error("timer startup failed",error instanceof Error?error.name:"UNKNOWN");await nc.close();await pool.end();process.exitCode=1;}
