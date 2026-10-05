// ABOUTME: Проверяет готовность artifacts по PostgreSQL, файловому тому и NATS.
// ABOUTME: Не запускает миграции и не меняет состояние хранилищ.
import type {Pool} from 'pg';
import type {NatsConnection} from 'nats';
import {access,constants,stat} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {loadArtifactsConfig} from './config.js';
/** Возвращает готовность runtime после короткой проверки собственных зависимостей. */
export async function artifactsReadiness(pool:Pool,nc:NatsConnection,dataDir:string){
 try{const checks=[pool.query('SELECT 1 FROM artifacts.artifacts LIMIT 0').then(()=>undefined),Promise.all([stat(`${dataDir}/files`),access(`${dataDir}/files`,constants.R_OK),access(`${dataDir}/tmp`,constants.W_OK)]).then(([info])=>{if(!info.isDirectory())throw new Error();}),new Promise<void>((resolve,reject)=>{if(nc.isClosed()||nc.isDraining()){reject(new Error('nats-unavailable'));return;}let timer:NodeJS.Timeout|undefined;timer=setTimeout(()=>reject(new Error('nats-flush-timeout')),1000);timer.unref();void nc.flush().then(resolve,reject).finally(()=>{if(timer)clearTimeout(timer);});})];await Promise.all(checks);return {status:'ready' as const};}
 catch{return {status:'not-ready' as const};}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){try{const cfg=loadArtifactsConfig();const host=cfg.httpHost==='0.0.0.0'?'127.0.0.1':cfg.httpHost==='::'?'::1':cfg.httpHost;const address=host.includes(':')?`[${host}]`:host;const response=await fetch(`http://${address}:${cfg.httpPort}/health`,{signal:AbortSignal.timeout(3000)});if(!response.ok)throw new Error();}catch{console.error('artifacts health check failed');process.exitCode=1;}}
