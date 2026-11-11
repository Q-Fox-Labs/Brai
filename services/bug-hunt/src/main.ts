// ABOUTME: Собирает bug-hunt из PostgreSQL, Auth, NATS Services и MCP.
// ABOUTME: Только эта точка сборки знает внешние технологии и credentials экземпляра.
import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {pathToFileURL} from "node:url";
import {Pool} from "pg";
import {connect,credsAuthenticator,type NatsConnection} from "nats";
import {config as loadConfig,processingConfig,approvedProjection,type Config} from "./config.js";
import {Fault,failure,limits,type Operation,type Principal} from "./contracts.js";
import {createHandlers} from "./domain.js";
import {createStore} from "./storage.js";
import {createGate,type WorkContext} from "./load.js";
import {codexPrincipal,natsPrincipal,activeIdentity,type Wire} from "./identity.js";
import {startMcp} from "./mcp.js";
import {createProcessingStore} from "./processing-store.js";
import {invokeProcessing,processingOperations} from "./processing-api.js";
import {createProcessor,ModelFault,type ProcessingJob} from "./processing.js";
import {createModelPorts} from "./model-ports.js";
import {createSystemStore} from "./system-store.js";
import {invokeSystem,systemFailure,systemOperations,SystemFault,type SystemOperation} from "./system-contracts.js";

const statusCodes:Record<string,number>={INVALID_ARGUMENT:400,REQUEST_TOO_LARGE:413,RESULT_TOO_LARGE:413,UNAUTHENTICATED:401,FORBIDDEN:403,NOT_FOUND:404,IDEMPOTENCY_CONFLICT:409,REVISION_CONFLICT:409,BUSY:429,DATABASE_UNAVAILABLE:503,DEPENDENCY_UNAVAILABLE:503,DEADLINE_EXCEEDED:504,INTERNAL:500};
/** Подключает NATS только с явными runtime inputs; не загружает .env. */
export async function connectNats(cfg:Config):Promise<NatsConnection>{
 return connect({servers:cfg.nats.servers,user:cfg.nats.user,pass:cfg.nats.password,
  ...(cfg.nats.credsFile?{authenticator:credsAuthenticator(readFileSync(cfg.nats.credsFile))}:{}),
  inboxPrefix:cfg.nats.inboxPrefix,name:"brai_bug_hunt",timeout:3000,maxReconnectAttempts:-1});
}
/** Запускает оба адаптера одного ядра и возвращает штатное управление завершением. */
export async function startRuntime(cfg=loadConfig()){
 const pool=new Pool({connectionString:cfg.databaseURL,max:8,connectionTimeoutMillis:2000,statement_timeout:7000,idle_in_transaction_session_timeout:10000});
 pool.on("error",()=>console.error(JSON.stringify({service:"bug-hunt",code:"DATABASE_UNAVAILABLE"})));
 const refreshFromFile=arguments.length===0;
 const readProcessing=()=>{
  try{return processingConfig((refreshFromFile?loadConfig():cfg).processing);}
  catch{return processingConfig(undefined);}
 };
 const initialProcessing=readProcessing();
 const backgroundPool=new Pool({connectionString:cfg.databaseURL,max:2,connectionTimeoutMillis:1500,statement_timeout:3000,idle_in_transaction_session_timeout:5000});
 backgroundPool.on("error",()=>console.error(JSON.stringify({service:"bug-hunt",code:"PROCESSING_DATABASE_UNAVAILABLE"})));
 let processor:ReturnType<typeof createProcessor>|undefined;
 const gate=createGate();
 let nc:NatsConnection|undefined,mcp:Awaited<ReturnType<typeof startMcp>>|undefined,service:Awaited<ReturnType<NatsConnection["services"]["add"]>>|undefined;
 let systemService:Awaited<ReturnType<NatsConnection["services"]["add"]>>|undefined;
 const counters:Record<string,number>={accepted:0,replayed:0,IDEMPOTENCY_CONFLICT:0,FORBIDDEN:0,BUSY:0,DATABASE_UNAVAILABLE:0};
 try{
  nc=await connectNats(cfg);
  const wire:Wire=async(subject,input)=>{
   try{
    const response=await nc!.request(subject,Buffer.from(JSON.stringify(input)),{timeout:2000});
    if(response.headers?.has("Nats-Service-Error")||response.headers?.has("Nats-Service-Error-Code"))throw new Fault("DEPENDENCY_UNAVAILABLE");
    if(response.data.length>262144)throw new Fault("DEPENDENCY_UNAVAILABLE");
    return JSON.parse(new TextDecoder("utf8",{fatal:true}).decode(response.data));
   }catch(error){if(error instanceof Fault)throw error;throw new Fault("DEPENDENCY_UNAVAILABLE");}
  };
  const evidence=async(owner:string,ids:string[],ctx?:WorkContext)=>{
   if(!cfg.artifactsEnabled)throw new Fault("DEPENDENCY_UNAVAILABLE");
   for(const artifactId of ids){
    if(ctx&&(ctx.signal.aborted||Date.now()>=ctx.deadlineAt))throw new Fault("DEADLINE_EXCEEDED");
    const value=await wire("brai.artifacts.v1.get",{artifactId});
    const artifact=value;
    if(artifact?.artifactId!==artifactId||artifact.ownerId!==owner||artifact.status!=="ready")throw new Fault("NOT_FOUND");
   }
  };
  const makeStore=(deadlineAt?:number)=>createStore(pool,{installationId:cfg.installationId,cursorKey:cfg.cursorKey,maxReports:cfg.maxReports,reportsPerMinute:cfg.reportsPerMinute,maxDatabaseBytes:cfg.maxDatabaseBytes,deadlineAt,targetGeneration:()=>readProcessing().targetGeneration});
  const execute=async(op:Operation,p:Principal,input:unknown,ctx:WorkContext,operator=false)=>{
   const start=Date.now();let outcome="accepted";
   try{
    if(ctx.signal.aborted||Date.now()>=ctx.deadlineAt)throw new Fault("DEADLINE_EXCEEDED");
    const core=createHandlers({store:makeStore(ctx.deadlineAt),evidence:(owner,ids)=>evidence(owner,ids,ctx)});
    const value=await core.invoke(op,p,input,operator);
    if(Buffer.byteLength(JSON.stringify(value))>limits.responseBytes-4096)throw new Fault("RESULT_TOO_LARGE");
    if(op==="report")counters[(value as any).replayed?"replayed":"accepted"]++;
    return value;
   }catch(error){
    const dto=failure(error,op==="report"||op==="review");outcome=dto.code;counters[dto.code]=(counters[dto.code]??0)+1;throw error;
   }finally{
    console.log(JSON.stringify({service:"bug-hunt",operation:op,outcome,duration_ms:Date.now()-start,request_id_sha256:typeof (input as any)?.request_id==="string"?createHash("sha256").update((input as any).request_id).digest("hex"):undefined}));
   }
  };
  const makeSystemStore=(deadlineAt?:number)=>createSystemStore(pool,{installationId:cfg.installationId,cursorKey:cfg.cursorKey,maxDatabaseBytes:cfg.maxDatabaseBytes,deadlineAt});
  const systemStore=makeSystemStore();
  const processingStore=createProcessingStore(backgroundPool,{target:()=>readProcessing().targetGeneration,installationId:cfg.installationId,cursorKey:cfg.cursorKey,maxDatabaseBytes:cfg.maxDatabaseBytes,leaseMs:initialProcessing.leaseMs,intakeReserveBytes:initialProcessing.intakeReserveBytes,maxDerivativeBytes:initialProcessing.maxDerivativeBytes,dailyLimits:initialProcessing.dailyLimits,policy:()=>({...readProcessing(),maxDatabaseBytes:cfg.maxDatabaseBytes})});
  const externalProjection=async(job:ProcessingJob)=>approvedProjection(readProcessing(),job.owner_id,job.input_hash);
  const models=createModelPorts({connection:nc});
  processor=createProcessor({store:processingStore,indexReport:async id=>{
    if(!await processingStore.mayIndex())throw new ModelFault("DERIVATIVE_CAPACITY","not_sent");
    const local=createSystemStore(pool,{installationId:cfg.installationId,cursorKey:cfg.cursorKey,maxDatabaseBytes:Math.max(0,cfg.maxDatabaseBytes-readProcessing().intakeReserveBytes)});
    return local.indexReport(id);
   },...models,
   activeOwner:async owner=>{try{await activeIdentity(wire,owner);return true;}catch{return false;}},
   settings:()=>({...readProcessing(),externalProjection})});
  processor.start();
  const executeSystem=async(op:SystemOperation,p:Principal,input:unknown,ctx:WorkContext)=>{
   if(ctx.signal.aborted||Date.now()>=ctx.deadlineAt)throw new SystemFault("DEADLINE_EXCEEDED");
   const base=makeSystemStore(ctx.deadlineAt);
   const store={...base,
    similar:(principal:Principal,value:any)=>processingStore.similar(principal,value),
    enrichment:async(principal:Principal,value:{case_id:string})=>{
     const local=await base.enrichment(principal,value) as object;
     const processing=await processingStore.enrichmentModel(principal,value.case_id);
     return {...local,processing};
    }};
   return invokeSystem(store,op,p,input);
  };
  await makeStore().status();
  service=await nc.services.add({name:"brai_bug_hunt",version:"1.0.0",queue:"brai_bug_hunt",statsHandler:async()=>({...counters,BUSY:counters.BUSY+gate.metrics.busy,DEADLINE_EXCEEDED:gate.metrics.deadlineExceeded})});
  for(const endpoint of ["report","get","list","operator-list","review","status"]){
   service.addEndpoint(endpoint.replaceAll("-","_"),{subject:"brai.bug_hunt.v1."+endpoint,queue:"brai_bug_hunt",
    handler:(err,msg)=>{
     if(err)return;
     const mutation=endpoint==="report"||endpoint==="review";
     void gate.run(async ctx=>{
      if(msg.data.length>limits.requestBytes+4096)throw new Fault("REQUEST_TOO_LARGE");
      let input:any;try{input=JSON.parse(new TextDecoder("utf8",{fatal:true}).decode(msg.data));}catch{throw new Fault("INVALID_ARGUMENT");}
      if(endpoint==="status"){
       if(!input||Array.isArray(input)||Object.keys(input).length)throw new Fault("INVALID_ARGUMENT");
       return {...await makeStore(ctx.deadlineAt).status() as object,nats_ready:!nc!.isClosed(),counters:{...counters,BUSY:counters.BUSY+gate.metrics.busy,DEADLINE_EXCEEDED:gate.metrics.deadlineExceeded}};
      }
      if(!input||Array.isArray(input)||Object.keys(input).some(k=>!["context","input"].includes(k))||!("context" in input)||!("input" in input))throw new Fault("INVALID_ARGUMENT");
      const p=await natsPrincipal(wire,input.context);
      return execute(endpoint==="operator-list"?"list":endpoint as Operation,p,input.input,ctx,endpoint==="operator-list");
     },mutation).then(value=>msg.respond(Buffer.from(JSON.stringify(value))),error=>{
      const dto=failure(error,mutation);msg.respondError(statusCodes[dto.code],dto.code,Buffer.from(JSON.stringify(dto)));
     });
    },
   });
  }
  systemService=await nc.services.add({name:"brai_bug_hunt_v2",version:"2.0.0",queue:"brai_bug_hunt_v2"});
  for(const endpoint of systemOperations){
   systemService.addEndpoint(endpoint.replaceAll("-","_"),{subject:"brai.bug_hunt.v2."+endpoint,queue:"brai_bug_hunt_v2",
    handler:(err,msg)=>{
     if(err)return;
     const mutation=["membership-update","proposal-resolve","classification-override"].includes(endpoint);
     void gate.run(async ctx=>{
      if(msg.data.length>limits.requestBytes+4096)throw new SystemFault("REQUEST_TOO_LARGE");
      let body:any;try{body=JSON.parse(new TextDecoder("utf8",{fatal:true}).decode(msg.data));}catch{throw new SystemFault("INVALID_ARGUMENT");}
      if(!body||Array.isArray(body)||Object.keys(body).some(k=>!["context","input"].includes(k))||!("context" in body)||!("input" in body))throw new SystemFault("INVALID_ARGUMENT");
      const p=await natsPrincipal(wire,body.context);
      return executeSystem(endpoint,p,body.input,ctx);
     },mutation).then(value=>msg.respond(Buffer.from(JSON.stringify(value))),error=>{
      const dto=systemFailure(error,mutation);
      const status=statusCodes[dto.code]??({CURSOR_STALE:409,INDEX_NOT_READY:503,PROCESSING_PENDING:503} as Record<string,number>)[dto.code]??500;
      msg.respondError(status,dto.code,Buffer.from(JSON.stringify(dto)));
     });
    },
   });
  }
  for(const endpoint of processingOperations){
   systemService.addEndpoint("processing_"+endpoint,{subject:"brai.bug_hunt.v2.processing."+endpoint,queue:"brai_bug_hunt_v2",
    handler:(err,msg)=>{
     if(err)return;
     const mutation=endpoint!=="status";
     void gate.run(async()=>{
      if(msg.data.length>limits.requestBytes)throw new SystemFault("REQUEST_TOO_LARGE");
      let body:any;try{body=JSON.parse(new TextDecoder("utf8",{fatal:true}).decode(msg.data));}catch{throw new SystemFault("INVALID_ARGUMENT");}
      return invokeProcessing(processingStore,endpoint,body);
     },mutation).then(value=>msg.respond(Buffer.from(JSON.stringify(value))),error=>{
      const dto=systemFailure(error,mutation);msg.respondError(statusCodes[dto.code]??500,dto.code,Buffer.from(JSON.stringify(dto)));
     });
    },
   });
  }
  mcp=await startMcp(cfg.mcp,gate,authorization=>codexPrincipal(wire,cfg.mcp.principalsFile,authorization),execute,executeSystem);
  let stopping:Promise<void>|undefined;
  return {pool,backgroundPool,nc,service,systemService,systemStore,processingStore,processor,mcp,counters,
   stop(){return stopping??=(async()=>{gate.stop();await processor!.stop();await Promise.all([service!.stop(),systemService!.stop(),mcp!.close()]);await gate.drain();await nc!.drain();await Promise.all([pool.end(),backgroundPool.end()]);})();}};
 }catch(error){gate.stop();await processor?.stop().catch(()=>{});await mcp?.close().catch(()=>{});await service?.stop().catch(()=>{});await systemService?.stop().catch(()=>{});await gate.drain();await nc?.drain().catch(()=>{});await Promise.all([pool.end(),backgroundPool.end()]);throw error;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{const runtime=await startRuntime();console.log(JSON.stringify({service:"bug-hunt",outcome:"ready"}));
  const stop=()=>void runtime.stop().then(()=>process.exit(0));
  process.once("SIGTERM",stop);process.once("SIGINT",stop);
 }catch{console.error(JSON.stringify({service:"bug-hunt",code:"STARTUP_FAILED"}));process.exitCode=1;}
}
