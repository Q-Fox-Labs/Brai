// ABOUTME: Собирает отдельные Temporal worker, schedule и доставку допущенных намерений v3.
// ABOUTME: Отказ этой программы не выключает intake, поиск или worker систематизации v2.
import {Pool} from "pg";
import {Worker,NativeConnection} from "@temporalio/worker";
import {Client,Connection} from "@temporalio/client";
import {Context} from "@temporalio/activity";
import {readFileSync} from "node:fs";
import {isAbsolute} from "node:path";
import {fileURLToPath,pathToFileURL} from "node:url";
import {config as loadConfig,type Config} from "./config.js";
import {connectNats} from "./main.js";
import {activeIdentity} from "./identity.js";
import {policyReader,type VerificationPolicy} from "./verification.js";
import {createVerificationStore} from "./verification-store.js";
import {sourceReader,type SourceRegistration} from "./verification-sources.js";
import {runnerClient} from "./verification-runner.js";
import {codexExecutor,providersExecutor,type NativeProfile} from "./verification-models.js";
import {createVerificationEngine,type PreparedRecipe} from "./verification-engine.js";
import {verificationProcess,shutdownVerification,verificationReadiness} from "./verification-process.js";
interface RuntimeConfig {temporal:{address:string;namespace:string;taskQueue:string;identity:string};runnerSocket:string;sources:SourceRegistration[];recipes:PreparedRecipe[];nativeProfiles:Record<string,NativeProfile>;readinessFile?:string}
/** Проверяет обязательные защищённые входы worker; endpoint и путь не берутся из наблюдения. */
export function verificationRuntime(value:unknown):RuntimeConfig{
 const r=value as RuntimeConfig;
 if(!r||typeof r!=="object"||Object.keys(r).some(k=>!["temporal","runnerSocket","sources","recipes","nativeProfiles","readinessFile"].includes(k))||r.readinessFile!==undefined&&(typeof r.readinessFile!=="string"||!isAbsolute(r.readinessFile))||!r.temporal?.address||!r.temporal.namespace||!r.temporal.taskQueue?.startsWith("bug-hunt-")||!r.temporal.identity?.startsWith("bug-hunt-")||!r.runnerSocket?.startsWith("/")||!Array.isArray(r.sources)||!Array.isArray(r.recipes)||!r.nativeProfiles||typeof r.nativeProfiles!=="object")throw new Error("VERIFICATION_RUNTIME_UNPREPARED");
 return r;
}
/** Повторяет доставку только сохранённого workflowId после подтверждённого NotFound. */
export async function deliverVerification(store:Pick<ReturnType<typeof createVerificationStore>,"pending"|"workflow">,client:Client,taskQueue:string){
  for(const pending of await store.pending()){
   const handle=client.workflow.getHandle(pending.workflow_id);let exists=false;
   try{await handle.describe();exists=true;}catch(e:any){if(e.name!=="WorkflowNotFoundError")continue;}
   if(exists){await store.workflow(pending.id,"active");await handle.signal("wake").catch(()=>{});continue;}
   await store.workflow(pending.id,"starting");
   try{await client.workflow.start("verificationWorkflow",{workflowId:pending.workflow_id,taskQueue:taskQueue,args:[pending.id],workflowIdReusePolicy:"REJECT_DUPLICATE"});await store.workflow(pending.id,"active");}
   catch{await store.workflow(pending.id,"unknown");}
  }
}
const workerDependencies={Pool,connectNats,createVerificationStore,createVerificationEngine,NativeConnection,Connection,Client,Worker};
/** Запускает process-owned проход и публикует readiness после SQL/NATS/Temporal, независимо от dispatch policy. */
export async function startVerificationWorker(cfg?:Config,dependencies:Partial<typeof workerDependencies>={}){
 const fromFile=cfg===undefined,configPath=process.env.BRAI_BUG_HUNT_CONFIG;
 const initialBytes=fromFile?readFileSync(configPath??""):undefined;
 cfg??=loadConfig();const fixedConfig=cfg,dep={...workerDependencies,...dependencies};
 const infra=verificationRuntime(cfg.verificationRuntime),policies=policyReader(()=>(fromFile?loadConfig():fixedConfig).verification);
 const readiness=verificationReadiness(infra.readinessFile,configPath,initialBytes);
 const close:(()=>Promise<unknown>)[]=[];let shutdownWorker:(()=>Promise<unknown>)|undefined;
 try{
 const pool=new dep.Pool({connectionString:cfg.databaseURL,max:3,statement_timeout:3000,connectionTimeoutMillis:2000});
 close.push(()=>pool.end());await pool.query("SELECT 1");
 const store=dep.createVerificationStore(pool,{installationId:cfg.installationId,cursorKey:cfg.cursorKey,maxDatabaseBytes:cfg.maxDatabaseBytes,policy:()=>policies.get()});
 const nc=await dep.connectNats(cfg);close.push(()=>nc.close());
 let execution:ReturnType<typeof verificationProcess>|undefined;
 const engine=dep.createVerificationEngine({stopping:()=>execution?.stopping??false,store,sources:sourceReader(infra.sources),runner:runnerClient(infra.runnerSocket),recipes:infra.recipes,
  activeOwner:async owner=>{try{await activeIdentity(async(subject,input)=>{const msg=await nc.request(subject,Buffer.from(JSON.stringify(input)),{timeout:2000});if(msg.headers?.has("Nats-Service-Error")||msg.data.length>65536)throw Error();return JSON.parse(new TextDecoder("utf8",{fatal:true}).decode(msg.data));},owner);return true;}catch{return false;}},
  executor:(r,d)=>{
   if(r.executor==="providers")return providersExecutor(nc,r.owner_id,r.policy.profiles.providers,d);
   const key=r.policy.profiles.codex_app_server.endpointRef+"/"+r.policy.profiles.codex_app_server.revision,profile=infra.nativeProfiles[key];
   if(!profile)throw new Error("CODEX_PROFILE_UNPREPARED");
   return codexExecutor(profile,d);
  }
 });
 execution=verificationProcess(engine);
 const native=await dep.NativeConnection.connect({address:infra.temporal.address});
 close.push(()=>native.close());
 const control=await dep.Connection.connect({address:infra.temporal.address});
 close.push(()=>control.close());
 const client=new dep.Client({connection:control,namespace:infra.temporal.namespace});
 const worker=await dep.Worker.create({connection:native,namespace:infra.temporal.namespace,taskQueue:infra.temporal.taskQueue,identity:infra.temporal.identity,workflowBundle:{codePath:fileURLToPath(new URL("./verification-workflow-bundle.cjs",import.meta.url))},maxConcurrentActivityTaskExecutions:1,maxConcurrentWorkflowTaskExecutions:2,maxCachedWorkflows:50,activities:{
  async advance(id:string){if(Context.current().cancellationSignal.aborted)return {terminal:false,wait_ms:60000,code:"ACTIVITY_CANCELLED"};return execution!.advance(id);}
 }});
 let stopped=false,pumping=false,stopPromise:Promise<void>|undefined;
 async function pump(){if(stopped||pumping)return;pumping=true;try{
  await store.tick();
  await deliverVerification(store,client,infra.temporal.taskQueue);
 }catch{console.error(JSON.stringify({service:"bug-hunt-verification",code:"PUMP_UNAVAILABLE"}));}finally{pumping=false;}}
 const running=worker.run();void running.catch(()=>{});
 shutdownWorker=async()=>{if(worker.getState()==="RUNNING")worker.shutdown();await running;};
 if(worker.getState()!=="RUNNING")throw Error("VERIFICATION_WORKER_NOT_RUNNING");
 readiness.ready();
 const timer=setInterval(()=>void pump(),30000);
 const runtime={store,worker,running,stop(){if(stopPromise)return stopPromise;stopped=true;clearInterval(timer);let markerError:unknown;try{readiness.remove();}catch(error){markerError=error;}const stoppedExecution=execution!.stop(),stoppedWorker=shutdownWorker!().then(()=>{if(markerError)throw markerError;});stopPromise=shutdownVerification(stoppedWorker,stoppedExecution,close);return stopPromise;}};
 void running.then(()=>{if(!stopped)return runtime.stop();},()=>{if(!stopped)return runtime.stop();}).catch(()=>{console.error("VERIFICATION_STOP_UNKNOWN");});
 await pump();return runtime;
 }catch(error){try{readiness.remove();}catch{/* Отказ marker не должен оставлять открытые транспорты. */}await Promise.allSettled([Promise.resolve().then(()=>shutdownWorker?.()),...close.map(fn=>Promise.resolve().then(fn))]);throw error;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{const runtime=await startVerificationWorker();for(const signal of ["SIGTERM","SIGINT"] as const)process.once(signal,()=>void runtime.stop().catch(()=>{console.error("VERIFICATION_STOP_UNKNOWN");process.exitCode=1;}));await runtime.running;}
 catch{console.error("VERIFICATION_WORKER_UNAVAILABLE");process.exitCode=1;}
}
