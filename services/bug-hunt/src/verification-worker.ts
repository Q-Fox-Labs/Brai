// ABOUTME: Собирает отдельные Temporal worker, schedule и доставку допущенных намерений v3.
// ABOUTME: Отказ этой программы не выключает intake, поиск или worker систематизации v2.
import {Pool} from "pg";
import {Worker,NativeConnection} from "@temporalio/worker";
import {Client,Connection} from "@temporalio/client";
import {heartbeat,Context} from "@temporalio/activity";
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
interface RuntimeConfig {temporal:{address:string;namespace:string;taskQueue:string;identity:string};runnerSocket:string;sources:SourceRegistration[];recipes:PreparedRecipe[];nativeProfiles:Record<string,NativeProfile>}
/** Проверяет обязательные защищённые входы worker; endpoint и путь не берутся из наблюдения. */
export function verificationRuntime(value:unknown):RuntimeConfig{
 const r=value as RuntimeConfig;
 if(!r||typeof r!=="object"||Object.keys(r).some(k=>!["temporal","runnerSocket","sources","recipes","nativeProfiles"].includes(k))||!r.temporal?.address||!r.temporal.namespace||!r.temporal.taskQueue?.startsWith("bug-hunt-")||!r.temporal.identity?.startsWith("bug-hunt-")||!r.runnerSocket?.startsWith("/")||!Array.isArray(r.sources)||!Array.isArray(r.recipes)||!r.nativeProfiles||typeof r.nativeProfiles!=="object")throw new Error("VERIFICATION_RUNTIME_UNPREPARED");
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
/** Запускает один model/runner Activity одновременно; пауза и политики читаются перед каждым эффектом. */
export async function startVerificationWorker(cfg:Config=loadConfig()){
 const fromFile=arguments.length===0;
 const infra=verificationRuntime(cfg.verificationRuntime),policies=policyReader(()=>(fromFile?loadConfig():cfg).verification);
 const pool=new Pool({connectionString:cfg.databaseURL,max:3,statement_timeout:3000,connectionTimeoutMillis:2000});
 const store=createVerificationStore(pool,{installationId:cfg.installationId,cursorKey:cfg.cursorKey,maxDatabaseBytes:cfg.maxDatabaseBytes,policy:()=>policies.get()});
 const nc=await connectNats(cfg);
 const engine=createVerificationEngine({store,sources:sourceReader(infra.sources),runner:runnerClient(infra.runnerSocket),recipes:infra.recipes,
  activeOwner:async owner=>{try{await activeIdentity(async(subject,input)=>{const msg=await nc.request(subject,Buffer.from(JSON.stringify(input)),{timeout:2000});if(msg.headers?.has("Nats-Service-Error")||msg.data.length>65536)throw Error();return JSON.parse(new TextDecoder("utf8",{fatal:true}).decode(msg.data));},owner);return true;}catch{return false;}},
  executor:(r,d)=>{
   if(r.executor==="providers")return providersExecutor(nc,r.owner_id,r.policy.profiles.providers,d);
   const key=r.policy.profiles.codex_app_server.endpointRef+"/"+r.policy.profiles.codex_app_server.revision,profile=infra.nativeProfiles[key];
   if(!profile)throw new Error("CODEX_PROFILE_UNPREPARED");
   return codexExecutor(profile,d);
  }
 });
 const native=await NativeConnection.connect({address:infra.temporal.address});
 const control=await Connection.connect({address:infra.temporal.address});
 const client=new Client({connection:control,namespace:infra.temporal.namespace});
 const worker=await Worker.create({connection:native,namespace:infra.temporal.namespace,taskQueue:infra.temporal.taskQueue,identity:infra.temporal.identity,workflowBundle:{codePath:fileURLToPath(new URL("./verification-workflow-bundle.cjs",import.meta.url))},maxConcurrentActivityTaskExecutions:1,maxConcurrentWorkflowTaskExecutions:2,maxCachedWorkflows:50,shutdownGraceTime:"16 minutes",activities:{
  async advance(id:string){const timer=setInterval(()=>heartbeat({investigation_id:id}),2000);try{if(Context.current().cancellationSignal.aborted)return {terminal:false,wait_ms:60000,code:"ACTIVITY_CANCELLED"};return await engine.advance(id);}finally{clearInterval(timer);}}
 }});
 let stopped=false,pumping=false;
 async function pump(){if(stopped||pumping)return;pumping=true;try{
  await store.tick();
  await deliverVerification(store,client,infra.temporal.taskQueue);
 }catch{console.error(JSON.stringify({service:"bug-hunt-verification",code:"PUMP_UNAVAILABLE"}));}finally{pumping=false;}}
 const timer=setInterval(()=>void pump(),30000);await pump();const running=worker.run();
 return {store,worker,running,async stop(){stopped=true;clearInterval(timer);worker.shutdown();await running;await nc.drain();await Promise.all([pool.end(),native.close(),control.close()]);}};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{const runtime=await startVerificationWorker();for(const signal of ["SIGTERM","SIGINT"] as const)process.once(signal,()=>void runtime.stop());await runtime.running;}
 catch{console.error("VERIFICATION_WORKER_UNAVAILABLE");process.exitCode=1;}
}
