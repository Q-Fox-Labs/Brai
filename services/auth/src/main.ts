// ABOUTME: Собирает изолированную БД auth, Better Auth и NATS adapter.
// ABOUTME: Не открывает HTTP-listener и не выполняет миграции при старте.
import { Pool } from "pg";
import { config } from "./config.js";
import { createAuth } from "./auth.js";
import { connectNats,runNats } from "./nats.js";
const cfg=config();const pool=new Pool({connectionString:cfg.databaseURL,max:8,connectionTimeoutMillis:5000,statement_timeout:10000});
pool.on("error",()=>console.error("auth database unavailable"));
try{await pool.query('SELECT 1 FROM "session" LIMIT 0');const auth=createAuth(cfg,pool);const nc=await connectNats(cfg);const runtime=await runNats(nc,cfg,auth.handler);console.log("auth ready");
 let stopping=false;const stop=async()=>{if(stopping)return;stopping=true;await runtime.stop();await nc.drain();await pool.end();};
 process.on("SIGTERM",()=>void stop());process.on("SIGINT",()=>void stop());await nc.closed();await stop();
}catch{console.error("auth startup failed");await pool.end();process.exitCode=1;}
