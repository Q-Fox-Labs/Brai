// ABOUTME: Собирает самостоятельный service_channels из PostgreSQL и NATS адаптеров.
// ABOUTME: Не запускает Telegram, Temporal, миграции или отсутствующие соседние сервисы.
import {Pool} from 'pg';
import {connect} from 'nats';
import {readFileSync} from 'node:fs';
import {loadConfig} from './config.js';
import {createStore} from './storage.js';
import {createService} from './domain.js';
import {serve} from './nats.js';
async function main(){
 const cfg=loadConfig(),key=readFileSync(cfg.cursorKeyFile);if(key.length<32)throw Error('INVALID_CURSOR_KEY');
 const pool=new Pool({connectionString:cfg.databaseUrl,max:4,connectionTimeoutMillis:1000,statement_timeout:5000,idle_in_transaction_session_timeout:5000});
 pool.on('error',()=>{});
 let nc,server;let closing=false;
 try{
  nc=await connect({...JSON.parse(readFileSync(cfg.natsOptionsFile,'utf8')),servers:cfg.natsUrl,name:'service_channels',maxReconnectAttempts:-1,timeout:5000});
  server=await serve(nc,createService(createStore(pool),cfg.callers,key),cfg.callers);
  const close=async()=>{if(closing)return;closing=true;await server!.close();await nc!.drain();};
  process.once('SIGTERM',()=>void close());process.once('SIGINT',()=>void close());
  await nc.closed();
 }finally{await server?.close();await nc?.close();await pool.end();}
}
main().catch(()=>{console.error('CHANNELS_STARTUP_OR_SHUTDOWN_FAILED');process.exitCode=1;});
