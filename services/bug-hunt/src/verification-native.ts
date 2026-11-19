// ABOUTME: Ведёт один приватный stdio-сеанс Codex и получает авторитетные metadata через credential owner.
// ABOUTME: Не хранит bearer, не повторяет RPC и не связывает native state с версией CLI или OAuth binding.
import {spawn,execFile} from "node:child_process";
import {createConnection} from "node:net";
import {createHash,randomUUID} from "node:crypto";
import {mkdir,writeFile,rename} from "node:fs/promises";
import path from "node:path";
import {VerificationFault as VF} from "./verification.js";
type Json=Record<string,any>;
export interface NativeProcessProfile {
 binary:string;python:string;credentialClient:string;credentialSocket:string;stateRoot:string;sourceRef:string;
 /** Приватный metadata файл внутри stateRoot; child получает его только read-only. */
 catalogPath:string;
 /** Фиксированный доверенный launcher; args предшествуют закрытому bwrap argv. */
 launcher?:{binary:string;args:string[]};
}
export interface NativeCredential {ready?:boolean;code?:string;binding:string;accountId:string;expiresAt:number;baseUrl:string;sourceRef:string;access?:string}
export interface NativePreparation {models:any[];catalog_revision:string;binding:string;accountId:string;sourceRef:string;model:string;version:string;contextWindow:number;effective_catalog_revision:string}
export interface NativeRpc {
 connect():Promise<void>;call(method:string,params:unknown,timeout?:number):Promise<any>;send(packet:Json):void;
 subscribe(fn:(packet:Json)=>void):()=>void;onDisconnect?(fn:()=>void):()=>void;close():void|Promise<void>;connected?():boolean;
 prepare?():Promise<NativePreparation>;checkBinding?():Promise<void>;preparation?():NativePreparation|undefined;
}
const baseUrl="https://chatgpt.com/backend-api/codex";
const hash=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** Один UDS вызов owner без собственного срока: ждёт owner reply/EOF; неизвестный ответ не повторяется. */
export function credentialCall(socketPath:string,method:"status"|"resolve",params:Json={}):Promise<NativeCredential>{
 return new Promise((yes,no)=>{
  const id=randomUUID(),socket=createConnection(socketPath);let data="",done=false;
  const finish=(error?:Error,value?:any)=>{if(done)return;done=true;socket.destroy();error?no(error):yes(value);};
  socket.setEncoding("utf8");
  socket.on("connect",()=>socket.write(JSON.stringify({jsonrpc:"2.0",id,method:"credentials."+method,params})+"\n"));
  socket.on("data",chunk=>{data+=chunk;const end=data.indexOf("\n");if(end<0)return;try{const packet=JSON.parse(data.slice(0,end));if(packet.jsonrpc!=="2.0"||packet.id!==id||packet.error||!packet.result)throw Error();finish(undefined,packet.result);}catch{finish(new VF("NATIVE_CREDENTIAL_UNAVAILABLE"));}});
  socket.on("error",()=>finish(new VF("NATIVE_CREDENTIAL_UNAVAILABLE")));
  socket.on("close",()=>finish(new VF("NATIVE_CREDENTIAL_UNAVAILABLE")));
 });
}
/** Проецирует только tool_mode выбранной stable Sol; все прочие catalog metadata сохраняются. */
export function projectNativeCatalog(catalog:Json){
 if(!Array.isArray(catalog.models))throw new VF("SOL_CATALOG_UNAVAILABLE");
 const seen=new Set<string>();for(const m of catalog.models){if(typeof m.slug!=="string"||seen.has(m.slug))throw new VF("NATIVE_CATALOG_INVALID");seen.add(m.slug);}
 const candidates=catalog.models.filter((m:Json)=>m.visibility==="list"&&/^gpt-[1-9]\d*(?:\.\d+)?-sol$/.test(m.slug));
 candidates.sort((a:Json,b:Json)=>{const x=a.slug.slice(4,-4).split(".").map(Number),y=b.slug.slice(4,-4).split(".").map(Number);return y[0]-x[0]||(y[1]??0)-(x[1]??0);});
 const selected=candidates[0];if(!selected)throw new VF("SOL_CATALOG_UNAVAILABLE");
 if(!selected.supported_reasoning_levels?.some((e:Json)=>e.effort==="high"))throw new VF("SOL_HIGH_UNAVAILABLE");
 if(!Number.isSafeInteger(selected.context_window)||selected.context_window<=0)throw new VF("NATIVE_CONTEXT_MISSING");
 const projected=structuredClone(catalog);projected.models.find((m:Json)=>m.slug===selected.slug).tool_mode="direct";
 return {catalog:projected,model:selected.slug,contextWindow:selected.context_window,revision:hash(catalog),effectiveRevision:hash(projected),models:[{id:selected.slug,supportedReasoningEfforts:selected.supported_reasoning_levels.map((e:Json)=>({reasoningEffort:e.effort}))}]};
}
function assertCredential(value:NativeCredential,profile:NativeProcessProfile){
 if(!value.binding||!value.accountId||value.sourceRef!==profile.sourceRef||value.baseUrl!==baseUrl||!Number.isFinite(value.expiresAt)||value.expiresAt<=Date.now()/1000)throw new VF("NATIVE_CREDENTIAL_BINDING_CHANGED");
}
const toml=(value:any):string=>value&&typeof value==="object"&&!Array.isArray(value)?"{"+Object.entries(value).map(([key,v])=>JSON.stringify(key)+"="+toml(v)).join(",")+"}":JSON.stringify(value);
/** Добавляет закрытый stdio argv к защищённому installer launcher; пути не выбирает модель. */
export function nativeProcessCommand(profile:NativeProcessProfile,prepared:NativePreparation,config:Json){
 const args=[profile.binary,"app-server","--listen","stdio://"];
 const startup={...config,model:prepared.model,model_provider:"bug_hunt_subscription",check_for_update_on_startup:false,model_catalog_json:profile.catalogPath,
  "model_providers.bug_hunt_subscription.name":"Bug Hunt private subscription","model_providers.bug_hunt_subscription.base_url":baseUrl,
  "model_providers.bug_hunt_subscription.wire_api":"responses","model_providers.bug_hunt_subscription.requires_openai_auth":false,
  "model_providers.bug_hunt_subscription.auth.command":profile.python,"model_providers.bug_hunt_subscription.auth.args":["-I","-S","-B",profile.credentialClient,"--socket",profile.credentialSocket,"--binding",prepared.binding],
  "model_providers.bug_hunt_subscription.auth.refresh_interval_ms":0,"model_providers.bug_hunt_subscription.http_headers":{"ChatGPT-Account-Id":prepared.accountId},
  "model_providers.bug_hunt_subscription.supports_websockets":false,"model_providers.bug_hunt_subscription.request_max_retries":0,"model_providers.bug_hunt_subscription.stream_max_retries":0};
 for(const [key,value] of Object.entries(startup))args.push("-c",key+"="+toml(value));
 if(!profile.launcher?.binary||!Array.isArray(profile.launcher.args))throw new VF("NATIVE_LAUNCHER_REQUIRED");
 return {binary:profile.launcher.binary,args:[...profile.launcher.args,...args]};
}
/** Строит stdio transport. Bootstrap GET metadata не является inference и никогда не повторяет 401. */
export function nativeProcessRpc(profile:NativeProcessProfile,config:Json,deps:{credential?:typeof credentialCall;fetch?:typeof fetch;version?:()=>Promise<string>;launch?:typeof spawn}={}):NativeRpc{
 const credential=deps.credential??credentialCall,fetchCatalog=deps.fetch??fetch,launch=deps.launch??spawn;
 let prepared:NativePreparation|undefined,child:ReturnType<typeof spawn>|undefined,next=0,buffer="",live=false;
 const pending=new Map<number,{yes:(v:any)=>void;no:(e:Error)=>void;timer:NodeJS.Timeout}>(),listeners=new Set<(packet:Json)=>void>(),disconnectListeners=new Set<()=>void>();
 function disconnected(){const wasLive=live;live=false;if(wasLive)for(const listener of disconnectListeners){try{listener();}catch{/* Все pending RPC должны завершиться даже при отказе listener. */}}for(const p of pending.values()){clearTimeout(p.timer);p.no(new VF("NATIVE_CONNECTION_LOST","unknown"));}pending.clear();}
 function packet(p:Json){if(p.method){for(const listener of listeners)listener(p);return;}const wait=pending.get(p.id);if(!wait)return;pending.delete(p.id);clearTimeout(wait.timer);if(p.error)wait.no(new VF("NATIVE_RPC_REJECTED"));else if(Object.hasOwn(p,"result"))wait.yes(p.result);else wait.no(new VF("NATIVE_PROTOCOL","unknown"));}
 async function checkBinding(){if(!prepared)throw new VF("NATIVE_CREDENTIAL_BINDING_CHANGED");const value=await credential(profile.credentialSocket,"status");assertCredential(value,profile);if(value.ready!==true||value.binding!==prepared.binding||value.accountId!==prepared.accountId)throw new VF("NATIVE_CREDENTIAL_BINDING_CHANGED");}
 return {
  async prepare(){
   if(prepared){await checkBinding();return prepared;}
   const version=(await (deps.version?.()??new Promise<string>((yes,no)=>execFile(profile.binary,["--version"],{env:{PATH:"/usr/bin:/bin",HOME:profile.stateRoot}},(error,stdout)=>error?no(new VF("NATIVE_BINARY_UNAVAILABLE")):yes(stdout.trim().split(/\s+/).at(-1)!))))).trim();
   if(!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version))throw new VF("NATIVE_VERSION_INVALID");
   let value=await credential(profile.credentialSocket,"resolve");assertCredential(value,profile);if(!value.access)throw new VF("NATIVE_CREDENTIAL_UNAVAILABLE");
   let catalog:Json;
   try{const response=await fetchCatalog(baseUrl+"/models?client_version="+encodeURIComponent(version),{headers:{Authorization:"Bearer "+value.access,"ChatGPT-Account-Id":value.accountId,"User-Agent":"brai-bug-hunt/"+version,originator:"codex_cli_rs"},redirect:"error"});if(!response.ok)throw new VF(response.status===401?"NATIVE_AUTH_REJECTED":"NATIVE_CATALOG_UNAVAILABLE");catalog=await response.json() as Json;}catch(error){throw error instanceof VF?error:new VF("NATIVE_CATALOG_UNAVAILABLE");}finally{delete value.access;}
   const projected=projectNativeCatalog(catalog);
   const root=path.resolve(profile.stateRoot),catalogPath=path.resolve(profile.catalogPath);
   if(!catalogPath.startsWith(root+path.sep))throw new VF("NATIVE_CATALOG_PATH_INVALID");
   await mkdir(root,{recursive:true,mode:0o700});
   const temp=catalogPath+"."+randomUUID()+".tmp";
   await writeFile(temp,JSON.stringify(projected.catalog),{mode:0o400,flag:"wx"});await rename(temp,catalogPath);
   prepared={models:projected.models,catalog_revision:projected.revision,binding:value.binding,accountId:value.accountId,sourceRef:value.sourceRef,model:projected.model,version,contextWindow:projected.contextWindow,effective_catalog_revision:projected.effectiveRevision};
   await checkBinding();return prepared;
  },
  preparation:()=>prepared,checkBinding,connected:()=>live,
  async connect(){
   if(live)return;if(child)throw new VF("NATIVE_CONNECTION_LOST","unknown");if(!prepared)throw new VF("NATIVE_NOT_PREPARED");await checkBinding();
   await mkdir(path.join(profile.stateRoot,".codex"),{recursive:true,mode:0o700});
   const command=nativeProcessCommand(profile,prepared,config);child=launch(command.binary,command.args,{env:{PATH:"/usr/bin:/bin",HOME:profile.stateRoot,CODEX_HOME:path.join(profile.stateRoot,".codex")},stdio:["pipe","pipe","ignore"]});live=true;
   child.on("error",disconnected);child.on("exit",disconnected);child.stdout!.on("end",disconnected);
   child.stdin!.on("error",disconnected);
   child.stdout!.setEncoding("utf8");
   child.stdout!.on("data",data=>{buffer+=data;let newline;while((newline=buffer.indexOf("\n"))>=0){const line=buffer.slice(0,newline);buffer=buffer.slice(newline+1);try{packet(JSON.parse(line));}catch{disconnected();child?.kill();return;}}});
  },
  async call(method,params,timeout=10000){if(!live)throw new VF("NATIVE_CONNECTION_LOST","unknown");const id=++next;return new Promise((yes,no)=>{const timer=setTimeout(()=>{pending.delete(id);no(new VF("NATIVE_RPC_TIMEOUT","unknown"));},timeout);pending.set(id,{yes,no,timer});child!.stdin!.write(JSON.stringify({id,method,params})+"\n",error=>{if(error)disconnected();});});},
  send(p){if(!live)throw new VF("NATIVE_CONNECTION_LOST","unknown");child!.stdin!.write(JSON.stringify(p)+"\n",error=>{if(error)disconnected();});},
  subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},
  onDisconnect(fn){disconnectListeners.add(fn);return()=>disconnectListeners.delete(fn);},
  close(){disconnected();if(!child?.pid||child.exitCode!==null||child.signalCode!==null)return;const exiting=new Promise<void>(resolve=>child!.once("exit",()=>resolve()));child.stdin?.end();child.kill("SIGTERM");return exiting;}
 };
}
