// ABOUTME: Собирает NATS ядро, доставщик поручений и Temporal worker одного сервиса.
// ABOUTME: Не запускает миграции; legacy recovery scanner после передачи владения отключён.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Pool } from 'pg';
import { createStore } from './storage.mjs';
import { createGit } from './git.mjs';
import { createHandlers } from './domain.mjs';
import { Fault } from './errors.mjs';
import {startTemporal} from './temporal.mjs';
/** Сохраняет legacy launcher для изолированных recovery fixtures; Temporal Activities его не используют. */
export function launchWorker(commonDir,operationId,env=process.env) {
  const script='exec 3>"$1" || exit 74; flock -n -E 75 3 || exit $?; export CODEWORKS_LOCK_HELD=1; exec "$2" "$3" "$4"';
  return spawn('/bin/sh',['-c',script,'codeworks',path.join(commonDir,'codeworks.lock'),process.execPath,fileURLToPath(new URL('./worker.mjs',import.meta.url)),operationId],{env,stdio:['ignore','ignore','pipe']});
}
/** Создаёт доверенный runtime по явной конфигурации; startRecovery можно отключить в fixture. */
export async function startRuntime({databaseURL,adminExecutor='codeworks_admin',startRecovery=true,allowedRepositories=JSON.parse(process.env.CODEWORKS_ALLOWED_REPOSITORIES??'[]')}={}) {
  if(!databaseURL)throw new Error('CODEWORKS_DATABASE_URL_REQUIRED');
  if(!Array.isArray(allowedRepositories)||!allowedRepositories.length||allowedRepositories.some(p=>typeof p!=='string'||!path.isAbsolute(p)))throw new Error('CODEWORKS_ALLOWED_REPOSITORIES_REQUIRED');
  const pool=new Pool({connectionString:databaseURL,max:8,connectionTimeoutMillis:3000,statement_timeout:10000});
  pool.on('error',()=>console.error('codeworks database disconnected'));
  pool.on('connect',client=>client.on('error',()=>console.error('codeworks database request disconnected')));
  try {await pool.query('SELECT o.archived,w.removed_at,r.workflow_id FROM codeworks.operations o LEFT JOIN codeworks.workspaces w ON w.id=o.workspace_id LEFT JOIN codeworks.workflow_registry r ON r.workspace_id=w.id LIMIT 0');}catch(error){await pool.end();throw error;}
  const store=createStore(pool),handlers=createHandlers(store,createGit(),{adminExecutor,allowedRepositories,requireTemporal:startRecovery});
  let stopping=false;
  let temporal;
  try{temporal=startRecovery?startTemporal(pool,{databaseURL,allowedRepositories,address:process.env.CODEWORKS_TEMPORAL_ADDRESS,namespace:process.env.CODEWORKS_TEMPORAL_NAMESPACE,taskQueue:process.env.CODEWORKS_TEMPORAL_TASK_QUEUE}):null;}catch(error){await pool.end();throw error;}
  return {
    handlers,pool,
    /** Выполняет короткий API вызов; durable worker переживает разрыв вызывающего транспорта. */
    async call(method,args,executor) {
      if(stopping)throw new Fault('BUSY');
      return handlers.call(method,args,executor);
    },
    /** Ограниченно останавливает worker; принятые команды и внешний rollout сохраняются. */
    async close() {stopping=true;await temporal?.close();await pool.end();},
  };
}
