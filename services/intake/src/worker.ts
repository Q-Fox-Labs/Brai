// ABOUTME: Запускает worker только для отдельной task queue Приёма.
// ABOUTME: Ограничивает параллелизм; не содержит Telegram-получателя или синтетических соседей.
import { Pool } from 'pg';
import { fileURLToPath } from 'node:url';
import { Client, Connection } from '@temporalio/client';
import { NativeConnection, Worker } from '@temporalio/worker';
import { loadConfig } from './config.js';
import { connectBroker } from './nats.js';
import { createStore } from './storage.js';
import { createPorts } from './ports.js';
import { createActivities } from './activities.js';
const cfg=loadConfig(),pool=new Pool({application_name:'service_intake_worker',connectionString:cfg.databaseUrl,max:4,connectionTimeoutMillis:5000,statement_timeout:15000});
pool.on('error',()=>{});
const connection=await Connection.connect({address:cfg.temporalAddress});
const client=new Client({connection,namespace:cfg.temporalNamespace});
const native=await NativeConnection.connect({address:cfg.temporalAddress});
const nc=await connectBroker(cfg);
const activities=createActivities(createStore(pool),createPorts(nc,client,cfg),cfg.ports);
const worker=await Worker.create({connection:native,namespace:cfg.temporalNamespace,taskQueue:cfg.taskQueue,workflowsPath:fileURLToPath(new URL('./workflows.js',import.meta.url)),activities,maxConcurrentActivityTaskExecutions:4,maxConcurrentWorkflowTaskExecutions:8,maxCachedWorkflows:32,shutdownGraceTime:'20 seconds'});
process.once('SIGTERM',()=>worker.shutdown());process.once('SIGINT',()=>worker.shutdown());
try {await worker.run();}finally{await nc.drain();await native.close();await connection.close();await pool.end();}
