// ABOUTME: Принимает потоковые загрузки и выдаёт только явно разрешённые sharing-файлы.
// ABOUTME: Внутренние /files остаются ответственностью Caddy.
import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import type {Socket} from 'node:net';
import {open,constants} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pipeline} from 'node:stream/promises';
import type {Pool} from 'pg';import type {NatsConnection} from 'nats';
import type {ArtifactsCore} from './core.js';import type {Config} from './config.js';import {artifactsReadiness} from './health.js';import {ArtifactError,storageError} from './errors.js';
const send=(res:ServerResponse,status:number,code:string,close=false)=>{if(!res.headersSent){res.writeHead(status,{'Cache-Control':'no-store',...(close?{'Connection':'close'}:{})});res.end(code);}};
const rejectBody=(req:IncomingMessage,res:ServerResponse,status:number,code:string)=>{send(res,status,code,true);res.once('finish',()=>req.destroy());};
const tokenPath=/^\/(upload|share)\/([A-Za-z0-9_-]{16,512})$/;
function streamBody(req:IncomingMessage):AsyncIterable<Uint8Array>{return req;}
function bounded<T>(work:Promise<T>,ms:number):Promise<T>{let timer:NodeJS.Timeout|undefined;return Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new ArtifactError('STORAGE_UNAVAILABLE')),ms);timer.unref();})]).finally(()=>{if(timer)clearTimeout(timer);});}
/** Запускает минимальный HTTP-вход; request close после полного body не отменяет работу. */
export function startArtifactsHttp(cfg:Config,core:ArtifactsCore,pool:Pool,nc:NatsConnection):Promise<{stop():Promise<void>}>{
 const root=resolve(cfg.dataDir,'files');let activeUploads=0;const uploads=new Set<AbortController>();const sockets=new Set<Socket>();const server=createServer((req,res)=>{void handle(req,res).catch(error=>{const safe=error instanceof ArtifactError?error:storageError(error);send(res,safe.status,safe.code);});});server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});
 async function handle(req:IncomingMessage,res:ServerResponse){const url=new URL(req.url??'/','http://localhost');
  if(url.pathname==='/health'&&req.method==='GET'){let status:{status:'ready'|'not-ready'};try{status=await bounded(artifactsReadiness(pool,nc,cfg.dataDir),cfg.requestTimeoutMs);}catch{status={status:'not-ready'};}res.writeHead(status.status==='ready'?200:503,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(status));return;}
  const match=tokenPath.exec(url.pathname);if(!match){send(res,404,'NOT_FOUND');return;}
  if(match[1]==='upload'){
   if(req.method!=='PUT'){rejectBody(req,res,405,'METHOD_NOT_ALLOWED');return;}
   if(activeUploads>=cfg.maxConcurrentUploads){rejectBody(req,res,429,'OVERLOADED');return;}
   const declared=req.headers['content-length'];if(declared!==undefined&&(!/^\d+$/.test(declared)||Number(declared)>cfg.maxUploadBytes)){rejectBody(req,res,413,'PAYLOAD_TOO_LARGE');return;}
   activeUploads++;const started=Date.now();const abort=new AbortController();uploads.add(abort);let complete=false;
   const cancel=()=>{if(!complete)abort.abort();};const deadline=setTimeout(cancel,cfg.requestTimeoutMs);deadline.unref();req.once('aborted',cancel);req.setTimeout(cfg.receiveTimeoutMs,cancel);res.once('close',()=>{if(!res.writableEnded)cancel();});
   try{const artifact=await core.upload(match[2],streamBody(req),abort.signal);complete=true;
    if(res.destroyed)return;
    res.writeHead(201,{'X-Artifact-Id':artifact.artifactId,'X-Artifact-State':'ready','X-Artifact-Size':String(artifact.sizeBytes),'X-Artifact-SHA256':artifact.sha256!,'Location':artifact.internalUrl!,'Content-Length':'0','Cache-Control':'no-store'});res.end();
    console.info(JSON.stringify({requestId:artifact.requestId,operationId:artifact.requestId,endpoint:'http.upload',result:'success',durationMs:Date.now()-started,executor:'http'}));
   }catch(error){complete=true;const safe=error instanceof ArtifactError?error:storageError(error);if(req.complete)send(res,safe.status,safe.code);else rejectBody(req,res,safe.status,safe.code);console.info(JSON.stringify({endpoint:'http.upload',result:'error',code:safe.code,durationMs:Date.now()-started,executor:'http'}));}
   finally{clearTimeout(deadline);req.removeListener('aborted',cancel);uploads.delete(abort);activeUploads--;}
   return;
  }
  if(match[1]==='share'){
   if(req.method!=='GET'&&req.method!=='HEAD'){rejectBody(req,res,405,'METHOD_NOT_ALLOWED');return;}
   if(!cfg.externalBaseURL){send(res,503,'SHARING_NOT_CONFIGURED');return;}
   const abort=new AbortController();let rejectDeadline!: (error:Error)=>void;let handle:Awaited<ReturnType<typeof open>>|undefined;
   const deadlinePromise=new Promise<never>((_,reject)=>{rejectDeadline=reject;});const deadline=setTimeout(()=>{const error=new ArtifactError('STORAGE_UNAVAILABLE');abort.abort(error);rejectDeadline(error);},cfg.requestTimeoutMs);deadline.unref();
   const authorizedFile=async()=>{const artifact=await core.shared(match[2]);abort.signal.throwIfAborted();const file=await open(join(root,artifact.artifactId),constants.O_RDONLY|constants.O_NOFOLLOW);
    // AIDEV-NOTE: open/stat не отменяются AbortSignal; поздний результат сам закрывает свой descriptor.
    try{abort.signal.throwIfAborted();const info=await file.stat();abort.signal.throwIfAborted();if(!info.isFile())throw new Error('not-file');return {file,info};}catch(error){await file.close().catch(()=>{});throw error;}
   };
   try{const result=await Promise.race([authorizedFile(),deadlinePromise]);handle=result.file;const info=result.info;
    res.writeHead(200,{'content-type':'application/octet-stream','content-length':String(info.size),'content-disposition':'attachment; filename=\"artifact\"','cache-control':'private, no-store','x-content-type-options':'nosniff'});
    if(req.method==='HEAD'){res.end();const file=handle;handle=undefined;await file.close();return;}
    const stream=handle.createReadStream({autoClose:true});handle=undefined;await pipeline(stream,res,{signal:abort.signal});
   }catch(error){await handle?.close().catch(()=>{});if(!res.headersSent)send(res,error instanceof ArtifactError?error.status:404,error instanceof ArtifactError?error.code:'NOT_FOUND');else res.destroy(error as Error);}
   finally{clearTimeout(deadline);}
   return;
  }
 }
 return new Promise((resolveServer,reject)=>{server.once('error',reject);server.listen(cfg.httpPort,cfg.httpHost,()=>{server.removeListener('error',reject);resolveServer({stop:async()=>{for(const upload of uploads)upload.abort();await new Promise<void>(resolve=>{const deadline=setTimeout(()=>{server.closeAllConnections();for(const socket of sockets)socket.destroy();},cfg.requestTimeoutMs+1000);deadline.unref();server.close(()=>{clearTimeout(deadline);resolve();});});}});});});
}
