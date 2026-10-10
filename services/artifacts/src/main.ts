// ABOUTME: Собирает runtime artifacts из PostgreSQL, файлового тома, NATS и HTTP.
// ABOUTME: Не запускает миграции; завершает собственные ресурсы по сигналу.
import {Pool} from 'pg';
import {createFileStore} from './files.js';import {createPostgresStore} from './postgres.js';import {createArtifactsCore} from './core.js';
import {loadArtifactsConfig} from './config.js';import {startArtifactsNats} from './nats.js';import {startArtifactsHttp} from './http.js';
export type ArtifactsRuntime={stop():Promise<void>;instanceId:string};
/** Подключает adapters и запускает reconcile без параллельных проходов. */
export async function startArtifactsRuntime(cfg=loadArtifactsConfig()):Promise<ArtifactsRuntime>{
 const pool=new Pool({connectionString:cfg.databaseURL,max:8,connectionTimeoutMillis:5000,statement_timeout:cfg.queryTimeoutMs,query_timeout:cfg.queryTimeoutMs});pool.on('error',()=>console.error(JSON.stringify({component:'artifacts',event:'postgres-client-error'})));
 let nats:Awaited<ReturnType<typeof startArtifactsNats>>|undefined;let http:Awaited<ReturnType<typeof startArtifactsHttp>>|undefined;let timer:NodeJS.Timeout|undefined;let stopping=false;let reconciliation:Promise<void>|undefined;
 try{await pool.query('SELECT 1 FROM artifacts.artifacts,artifacts.artifact_output_bindings LIMIT 0');const files=await createFileStore(cfg.dataDir);const store=createPostgresStore(pool,{lockTimeoutMs:cfg.lockTimeoutMs,queryTimeoutMs:cfg.queryTimeoutMs});const core=createArtifactsCore({store,files,config:{maxUploadBytes:cfg.maxUploadBytes,maxResultBytes:cfg.maxNatsResponseBytes,staleTempAgeMs:cfg.staleTempAgeMs,uploadBaseURL:cfg.uploadBaseURL,internalBaseURL:cfg.internalBaseURL,externalBaseURL:cfg.externalBaseURL}});
  nats=await startArtifactsNats(cfg,core);http=await startArtifactsHttp(cfg,core,pool,nats.connection);
  const reconcile=()=>{if(stopping)return Promise.resolve();if(reconciliation)return reconciliation;reconciliation=(async()=>{try{await core.reconcile();}catch(error){console.error(JSON.stringify({component:'artifacts',event:'reconcile-failed',code:error instanceof Error&&'code' in error?(error as {code:string}).code:'STORAGE_UNAVAILABLE'}));}})().finally(()=>{reconciliation=undefined;});return reconciliation;};
  await reconcile();timer=setInterval(()=>void reconcile(),cfg.reconcileIntervalMs);timer.unref();
  let stopPromise:Promise<void>|undefined;return {instanceId:nats.instanceId,stop(){return stopPromise??=(async()=>{stopping=true;if(timer)clearInterval(timer);if(reconciliation){let timer:NodeJS.Timeout|undefined;await Promise.race([reconciliation,new Promise<void>(resolve=>{timer=setTimeout(resolve,cfg.requestTimeoutMs);timer.unref();})]);if(timer)clearTimeout(timer);}const closeHttp=http!.stop();await nats!.stop();await closeHttp;await pool.end();})();}};
 }catch(error){await http?.stop().catch(()=>{});await nats?.stop().catch(()=>{});await pool.end().catch(()=>{});throw error;}
}
if(process.argv[1]&&import.meta.url===new URL(`file://${process.argv[1]}`).href){let runtime:ArtifactsRuntime|undefined;let stopping:Promise<void>|undefined;
 try{runtime=await startArtifactsRuntime();console.info(JSON.stringify({component:'artifacts',event:'ready',instanceId:runtime.instanceId}));const stop=()=>{stopping??=runtime!.stop().then(()=>{process.exitCode=0;});};process.once('SIGTERM',stop);process.once('SIGINT',stop);await new Promise<void>(resolve=>{process.once('beforeExit',resolve);});}
 catch(error){console.error(JSON.stringify({component:'artifacts',event:'startup-failed',code:error instanceof Error&&'code' in error?(error as {code:string}).code:'STARTUP_FAILED'}));process.exitCode=1;}
}
