// ABOUTME: Собирает самостоятельный вход Приёма и read-only API.
// ABOUTME: Lazy Temporal connection сохраняет доступность режима JetStream при остановленном Temporal.
import { Pool } from 'pg';
import { Client, Connection } from '@temporalio/client';
import { loadConfig } from './config.js';
import { createStore } from './storage.js';
import { createPorts } from './ports.js';
import { connectBroker, runBroker } from './nats.js';
const cfg=loadConfig(),pool=new Pool({application_name:'service_intake',connectionString:cfg.databaseUrl,max:4,connectionTimeoutMillis:5000,statement_timeout:15000});
pool.on('error',()=>{});
const connection=Connection.lazy({address:cfg.temporalAddress});
const client=new Client({connection,namespace:cfg.temporalNamespace});
const nc=await connectBroker(cfg);
const runtime=await runBroker(nc,createStore(pool),createPorts(nc,client,cfg),cfg,async()=>{
 try {await connection.withDeadline(Date.now()+1000,()=>connection.workflowService.describeNamespace({namespace:cfg.temporalNamespace}));return true;}catch{return false;}
});
let closing=false;
/** Останавливает источник и ждёт завершения только уже взятых ограниченных операций. */
async function close(){if(closing)return;closing=true;await runtime.close();await nc.drain();await connection.close();await pool.end();}
process.once('SIGTERM',()=>void close());process.once('SIGINT',()=>void close());
await runtime.finished;
await close();
