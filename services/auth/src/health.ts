// ABOUTME: Проверяет доступ auth к собственной БД и соединение с NATS.
// ABOUTME: Не отправляет письма и не меняет сессии или конфигурацию.
import { Pool } from "pg";
import { config } from "./config.js";
import { connectNats } from "./nats.js";
const cfg=config();const pool=new Pool({connectionString:cfg.databaseURL,connectionTimeoutMillis:3000,statement_timeout:3000});
try{await pool.query('SELECT 1 FROM "session" LIMIT 0');const nc=await connectNats(cfg);try{await nc.flush();console.log("auth connections ready");}finally{await nc.close();}}
catch{console.error("auth connections unavailable");process.exitCode=1;}finally{await pool.end();}
