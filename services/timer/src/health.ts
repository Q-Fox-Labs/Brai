// ABOUTME: Проверяет готовность реальных подключений БД и JetStream.
// ABOUTME: Не меняет streams, consumers или данные таймера.
import { Pool } from "pg";
import { config } from "./config.js";
import { createStore } from "./storage.js";
import { connectNats } from "./nats.js";
const cfg=config();const pool=new Pool({connectionString:cfg.databaseURL,connectionTimeoutMillis:3000,statement_timeout:3000});
try{const nc=await connectNats({...cfg});try{await createStore(pool).ready();const manager=await nc.jetstreamManager({timeout:3000});await manager.getAccountInfo();console.log("timer connections ready");}finally{await nc.close();}}
catch{console.error("timer connections unavailable");process.exitCode=1;}finally{await pool.end();}
