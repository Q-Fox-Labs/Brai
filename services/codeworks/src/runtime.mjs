// ABOUTME: Собирает ядро и ограниченный локальный исполнитель durable Git операций.
// ABOUTME: Не запускает миграции или установку; после рестарта читает pending/running из БД.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Pool } from 'pg';
import { createStore } from './storage.mjs';
import { createGit } from './git.mjs';
import { createHandlers } from './domain.mjs';
import { Fault } from './errors.mjs';
/** Запускает один worker под flock; FD 3 наследуют Node и его Git/preparer потомки. */
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
  try {await pool.query('SELECT o.archived,w.removed_at FROM codeworks.operations o LEFT JOIN codeworks.workspaces w ON w.id=o.workspace_id LIMIT 0');}catch(error){await pool.end();throw error;}
  const store=createStore(pool),handlers=createHandlers(store,createGit(),{adminExecutor,allowedRepositories});
  let stopping=false,scanning=false,active=0;
  const workers=new Map();
  async function recover() {
    if(stopping||scanning||active>=4)return;
    scanning=true;
    try {
      for(const op of await store.pending(16)) {
        if(stopping||active>=4)break;
        if(workers.has(op.id))continue;
        active++;
        const child=launchWorker(op.common_dir,op.id,{...process.env,CODEWORKS_DATABASE_URL:databaseURL,CODEWORKS_ALLOWED_REPOSITORIES:JSON.stringify(allowedRepositories)});
        workers.set(op.id,child);
        child.stderr.on('data',()=>{});
        child.once('error',()=>{});
        child.once('close',()=>{workers.delete(op.id);active--;});
      }
    } catch {console.error('codeworks recovery scan unavailable');}
    finally {scanning=false;}
  }
  const timer=startRecovery?setInterval(()=>void recover(),1000):null;
  timer?.unref();
  if(startRecovery)await recover();
  return {
    handlers,pool,
    /** Выполняет короткий API вызов; durable worker переживает разрыв вызывающего транспорта. */
    async call(method,args,executor) {
      if(stopping)throw new Fault('BUSY');
      return handlers.call(method,args,executor);
    },
    /** Останавливает приём и ждёт собственные workers; намерения не отменяются. */
    async close() {stopping=true;if(timer)clearInterval(timer);while(scanning)await new Promise(resolve=>setTimeout(resolve,10));await Promise.all([...workers.values()].map(child=>new Promise(resolve=>{if(child.exitCode!==null)resolve();else child.once('close',resolve);})));await pool.end();},
  };
}
