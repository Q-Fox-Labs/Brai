// ABOUTME: Исполняет принятые recipes в отдельном namespace без сети и credentials.
// ABOUTME: Сохраняет intent до запуска и terminal tombstone; неизвестный запуск не повторяет.
import {createServer,request as httpRequest} from "node:http";
import {spawn,type ChildProcess} from "node:child_process";
import {mkdir,readFile,writeFile,rename,lstat,chmod,readdir,readlink,realpath} from "node:fs/promises";
import {readFileSync,createReadStream} from "node:fs";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import {join,resolve,isAbsolute} from "node:path";
import {pathToFileURL} from "node:url";
import {randomUUID,createHash} from "node:crypto";
import {VerificationFault as VF,sameScope,type RunSpec,type RunnerReceipt,type Scope,type ReproductionRunner} from "./verification.js";
import {verificationHash as hash} from "./verification-store.js";
import {readPrivate} from "./config.js";
export interface RunnerRecipe {id:string;version:string;harness:string;harness_sha256:string;source_root:string;source_file:string;source_commit:string;source_sha256:string;source_tree_sha256:string;fixture_refs:string[];fixture_sha256:Record<string,string>}
export interface RunnerConfig {socket:string;stateRoot:string;node:string;nodeRoot:string;dependenciesRoot:string;dependencies_sha256:string;node_sha256:string;recipes:RunnerRecipe[]}
const contract=JSON.parse(readFileSync(new URL("../runner.openrpc.json",import.meta.url),"utf8"));
const validator=new Ajv.default({strict:true});addFormats.default(validator);
const validSpec=validator.compile(contract.components.schemas.RunSpec),validScope=validator.compile(contract.components.schemas.Scope);
const uuid=(v:string)=>/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
/** Digest охватывает каждый исполняемый sibling; symlink не расширяет mount. */
export async function fileDigest(path:string){const sum=createHash("sha256");for await(const chunk of createReadStream(path))sum.update(chunk);return sum.digest("hex");}
export async function treeDigest(root:string,maxBytes=67108864){
 const base=await realpath(root),entries:Record<string,string>={};let files=0,bytes=0;
 async function walk(relative:string,depth:number){if(depth>32)throw new VF("INPUT_TREE_LIMIT");
  for(const name of (await readdir(join(base,relative))).sort()){
   const path=join(base,relative,name),key=relative?relative+"/"+name:name,st=await lstat(path);
   if(++files>50000)throw new VF("INPUT_TREE_LIMIT");
   if(st.isDirectory())await walk(key,depth+1);
   else if(st.isFile()){bytes+=st.size;if(bytes>maxBytes)throw new VF("INPUT_TREE_LIMIT");entries[key]=await fileDigest(path);}
   else if(st.isSymbolicLink()){const target=await realpath(path);if(!target.startsWith(base+"/"))throw new VF("INPUT_TREE_SYMLINK");entries[key]="symlink:"+await readlink(path);}
   else throw new VF("INPUT_TREE_INVALID");
  }
 }
 await walk("",0);return hash(entries);
}
/** Собирает отдельный runner; program argv, mounts и лимиты не поступают от модели. */
export function createRunner(config:RunnerConfig,onDiagnostic?:(event:{execution_id:string;exit_code:number|null;stderr:string})=>void):ReproductionRunner{
 const live=new Map<string,{child:ChildProcess;scope:Scope;done:Promise<void>}>();let busy=false;
 const location=(id:string)=>{if(!uuid(id))throw new VF("INVALID_ARGUMENT");return join(config.stateRoot,id);};
 async function privateFile(path:string){const s=await lstat(path);if(!s.isFile()||s.isSymbolicLink()||s.size>262144||s.mode&0o022)throw new VF("RUNNER_STATE_UNSAFE");return JSON.parse(await readFile(path,"utf8"));}
 async function save(id:string,state:unknown){const root=location(id),tmp=join(root,"receipt-"+randomUUID()+".tmp");await writeFile(tmp,JSON.stringify(state),{mode:0o600,flag:"wx"});await rename(tmp,join(root,"receipt.json"));}
 async function get(scope:Scope,id:string):Promise<RunnerReceipt|null>{
  let value;try{value=await privateFile(join(location(id),"receipt.json"));}catch(e:any){if(e.code==="ENOENT")return null;throw e;}
  if(!validScope(scope)||!sameScope(scope,value.scope))throw new VF("NOT_FOUND");
  if(!value.finished_at&&!live.has(id))return {...value,state:"unknown",cleanup:"pending"};return value;
 }
 async function prepare(spec:RunSpec){
  if(!validSpec(spec))throw new VF("INVALID_ARGUMENT");
  try{await mkdir(location(spec.execution_id),{mode:0o700});}catch(e:any){if(e.code!=="EEXIST")throw e;const st=await lstat(location(spec.execution_id));if(!st.isDirectory()||st.isSymbolicLink()||st.mode&0o077)throw new VF("RUNNER_STATE_UNSAFE");}
  const path=join(location(spec.execution_id),"intent.json");
  try{await writeFile(path,JSON.stringify(spec),{mode:0o400,flag:"wx"});}catch(e:any){if(e.code!=="EEXIST")throw e;if(hash(await privateFile(path))!==hash(spec))throw new VF("IDEMPOTENCY_CONFLICT");}
  return {execution_id:spec.execution_id,spec_sha256:spec.spec_sha256,state:"prepared" as const};
 }
 return {
  get,prepare,collect:get,
  async cleanup(scope,id){const receipt=await get(scope,id);if(live.has(id))return receipt;if(receipt&&!receipt.finished_at)return {...receipt,state:"unknown",cleanup:"pending"};return receipt;},
  async start(spec){
   if(!validSpec(spec)||!isAbsolute(config.stateRoot)||!isAbsolute(config.nodeRoot)||!isAbsolute(config.dependenciesRoot)||!config.node.startsWith(config.nodeRoot+"/"))throw new VF("INVALID_ARGUMENT");
   const previous=await get(spec.scope,spec.execution_id);
   if(previous){const original=await privateFile(join(location(spec.execution_id),"intent.json"));if(hash(original)!==hash(spec))throw new VF("IDEMPOTENCY_CONFLICT");return previous;}
   if(busy)throw new VF("RUNNER_BUSY");
   const recipe=config.recipes.find(r=>r.id===spec.recipe_id&&r.version===spec.recipe_version);
   if(!recipe||recipe.source_tree_sha256!==spec.source_tree_sha256||recipe.source_commit!==spec.source_commit||recipe.source_sha256!==spec.source_sha256||!recipe.fixture_refs.includes(spec.fixture_ref))throw new VF("RECIPE_NOT_ALLOWED");
   if(!recipe.source_file||recipe.source_file.startsWith("/")||recipe.source_file.split("/").some(p=>p===".."||!p)||hash(await readFile(join(recipe.source_root,recipe.source_file),"utf8"))!==recipe.source_sha256||hash(await readFile(recipe.harness,"utf8"))!==recipe.harness_sha256||spec.oracle_sha256!==hash(spec.oracle))throw new VF("RECIPE_INTEGRITY");
   if(!/^[a-z0-9-]{1,100}$/.test(spec.fixture_ref)||hash(await readFile(join(recipe.source_root,"fixtures",spec.fixture_ref+".json"),"utf8"))!==recipe.fixture_sha256?.[spec.fixture_ref])throw new VF("FIXTURE_INTEGRITY");
   const {spec_sha256,deadline_at,...body}=spec;if(hash(body)!==spec_sha256)throw new VF("SPEC_INTEGRITY");
   if(await treeDigest(recipe.source_root)!==spec.source_tree_sha256||await fileDigest(config.node)!==config.node_sha256||await treeDigest(config.dependenciesRoot,2147483648)!==config.dependencies_sha256)throw new VF("INPUT_TREE_INTEGRITY");
   const deadline=Date.parse(spec.deadline_at);if(!Number.isFinite(deadline)||deadline<=Date.now()||deadline>Date.now()+120000)throw new VF("INVALID_DEADLINE");
   if(busy)throw new VF("RUNNER_BUSY");
   await prepare(spec);
   if(busy)throw new VF("RUNNER_BUSY");
   busy=true;
   const receipt:RunnerReceipt={execution_id:spec.execution_id,scope:spec.scope,recipe_id:recipe.id,recipe_version:recipe.version,source_commit:spec.source_commit,source_sha256:spec.source_sha256,source_tree_sha256:spec.source_tree_sha256,node_sha256:config.node_sha256,dependencies_sha256:config.dependencies_sha256,spec_sha256:spec.spec_sha256,oracle_sha256:spec.oracle_sha256,started_at:new Date().toISOString(),finished_at:null,exit_code:null,outcome:"not_attempted",assertions:[],log_sha256:hash(""),fidelity:"synthetic",substituted_boundaries:["network","user_data","credentials"],cleanup:"pending",state:"unknown"};
   try{await save(spec.execution_id,receipt);}catch(e){busy=false;throw e;}
   const args=["--cpu=120","--fsize=268435456","--","/usr/bin/bwrap","--unshare-all","--die-with-parent","--new-session","--clearenv","--ro-bind","/lib","/lib","--ro-bind","/lib64","/lib64","--ro-bind","/usr/lib","/usr/lib","--ro-bind","/usr/bin/prlimit","/prlimit","--ro-bind",config.dependenciesRoot,"/node_modules","--ro-bind",config.nodeRoot,"/runtime","--ro-bind",recipe.source_root,"/source","--ro-bind",recipe.harness,"/recipe.mjs","--ro-bind",join(location(spec.execution_id),"intent.json"),"/spec.json","--proc","/proc","--dev","/dev","--size","268435456","--tmpfs","/work","--chdir","/work","--setenv","HOME","/work","--setenv","BRAI_RECIPE_SOURCE_FILE",recipe.source_file,"/prlimit","--nproc=128","--","/runtime/"+config.node.slice(config.nodeRoot.length+1),"--max-old-space-size=256","/recipe.mjs","/spec.json"];
   const child=spawn("/usr/bin/prlimit",args,{env:{PATH:"/usr/bin:/bin"},stdio:["ignore","pipe","pipe"],detached:true});
   let output=Buffer.alloc(0),error=Buffer.alloc(0),overflow=false,cancelled=false;
   const stop=()=>{try{process.kill(-child.pid!,"SIGKILL");}catch{}};
   child.stdout!.on("data",(b:Buffer)=>{if(output.length+error.length+b.length>262144){overflow=true;stop();}else output=Buffer.concat([output,b]);});
   child.stderr!.on("data",(b:Buffer)=>{if(output.length+error.length+b.length>262144){overflow=true;stop();}else error=Buffer.concat([error,b]);});
   const timer=setTimeout(stop,Math.max(1,deadline-Date.now()));
   const done=new Promise<void>(resolve=>{
    let settled=false;
    const finish=async(code:number|null)=>{if(settled)return;settled=true;clearTimeout(timer);
     receipt.finished_at=new Date().toISOString();receipt.exit_code=code;receipt.log_sha256=hash(Buffer.concat([output,error]).toString("base64"));receipt.cleanup="done";
     receipt.state=cancelled?"cancelled":"failed";receipt.outcome="invalid_test";
     if(!cancelled&&!overflow&&code===0){try{const result=JSON.parse(new TextDecoder("utf8",{fatal:true}).decode(output));
      if(!Array.isArray(result.assertions)||!result.assertions.length||result.assertions.length>50||result.assertions.some((a:any)=>typeof a.name!=="string"||typeof a.actual!=="string"||a.actual.length>4000))throw 0;
      receipt.assertions=result.assertions.map((a:any)=>({name:a.name,expected:spec.oracle.expected,actual:a.actual,passed:a.actual===spec.oracle.expected}));
      receipt.outcome=receipt.assertions.every(a=>a.passed)?"not_reproduced":"reproduced";receipt.state="completed";
     }catch{}}
     try{onDiagnostic?.({execution_id:spec.execution_id,exit_code:code,stderr:error.toString("utf8")});}catch{}
     try{await save(spec.execution_id,receipt);}catch{console.error("RUNNER_RECEIPT_UNAVAILABLE");}finally{live.delete(spec.execution_id);busy=false;resolve();}
    };
    child.once("error",()=>void finish(null));child.once("close",code=>void finish(code));
   });
   // Cancel действует только через живой handle собственного дочернего процесса.
   Object.assign(child,{cancelOwn:()=>{cancelled=true;stop();}});
   live.set(spec.execution_id,{child,scope:spec.scope,done});void done;
   return structuredClone(receipt);
  },
  async cancel(scope,id){const current=await get(scope,id);if(!current)throw new VF("NOT_FOUND");const owned=live.get(id);
   if(owned&&sameScope(owned.scope,scope)){(owned.child as any).cancelOwn();await owned.done;return (await get(scope,id))!;}return current;}
 };
}
/** Клиент локального JSON-RPC: start timeout восстанавливается только get того же ID. */
export function runnerClient(socket:string):ReproductionRunner{
 async function call(method:string,params:unknown):Promise<any>{
  const id=randomUUID(),body=JSON.stringify({jsonrpc:"2.0",id,method,params});
  return new Promise((yes,no)=>{const req=httpRequest({socketPath:socket,path:"/",method:"POST",headers:{"content-type":"application/json","content-length":Buffer.byteLength(body)}},res=>{
   let raw=Buffer.alloc(0);res.on("data",b=>{raw=Buffer.concat([raw,b]);if(raw.length>262144){req.destroy();no(new VF("RUNNER_PROTOCOL","unknown"));}});
   res.on("end",()=>{try{const reply=JSON.parse(raw.toString());if(reply.id!==id||reply.jsonrpc!=="2.0"||reply.error||!("result"in reply))throw 0;yes(reply.result);}catch{no(new VF("RUNNER_PROTOCOL","unknown"));}});
  });req.setTimeout(3000,()=>{req.destroy();no(new VF("RUNNER_TIMEOUT","unknown"));});req.on("error",()=>no(new VF("RUNNER_UNAVAILABLE","unknown")));req.end(body);});
 }
 return {prepare:spec=>call("prepare",{spec}),collect:(scope,id)=>call("collect",{scope,execution_id:id}),cleanup:(scope,id)=>call("cleanup",{scope,execution_id:id}),start:spec=>call("start",{spec}),get:(scope,id)=>call("get",{scope,execution_id:id}),cancel:(scope,id)=>call("cancel",{scope,execution_id:id})};
}
/** Запускает приватный RPC socket; owner/group/mode выдаёт установщик, не предметный запрос. */
export async function startRunnerServer(config:RunnerConfig,onDiagnostic?:(event:{execution_id:string;exit_code:number|null;stderr:string})=>void){
 const runner=createRunner(config,onDiagnostic);
 async function rpc(p:any):Promise<any>{
  if(!p||Array.isArray(p)||p.jsonrpc!=="2.0"||typeof p.method!=="string"||Object.hasOwn(p,"id")&&p.id!==null&&typeof p.id!=="string"&&typeof p.id!=="number"||Object.keys(p).some(k=>!["jsonrpc","id","method","params"].includes(k)))return {jsonrpc:"2.0",id:null,error:{code:-32600,message:"Invalid Request"}};
  const notification=!Object.hasOwn(p,"id");
  let result;
  try{const a=p.params;
   if(!a||typeof a!=="object")throw new VF("INVALID_ARGUMENT");
   if(["prepare","start"].includes(p.method)&&Object.keys(a).length===1&&validSpec(a.spec))result=await runner[p.method as "prepare"|"start"](a.spec);
   else if(["get","cancel","collect","cleanup"].includes(p.method)&&Object.keys(a).every(k=>["scope","execution_id"].includes(k))&&validScope(a.scope)&&uuid(a.execution_id))result=await runner[p.method as "get"|"cancel"|"collect"|"cleanup"](a.scope,a.execution_id);
   else if(!["prepare","start","get","cancel","collect","cleanup"].includes(p.method))return notification?null:{jsonrpc:"2.0",id:p.id,error:{code:-32601,message:"Method not found"}};
   else throw new VF("INVALID_ARGUMENT");
   return notification?null:{jsonrpc:"2.0",id:p.id,result};
  }catch(e){return notification?null:{jsonrpc:"2.0",id:p.id,error:{code:e instanceof VF&&e.code==="INVALID_ARGUMENT"?-32602:-32000,message:e instanceof VF?e.code:"RUNNER_FAILED"}};}
 }
 const server=createServer(async(req,res)=>{
  let raw=Buffer.alloc(0);try{
   if(req.method!=="POST"||req.url!=="/"){res.writeHead(404).end();return;}
   for await(const b of req){raw=Buffer.concat([raw,b]);if(raw.length>65536){res.writeHead(413).end();return;}}
   let input;try{input=JSON.parse(new TextDecoder("utf8",{fatal:true}).decode(raw));}catch{res.end(JSON.stringify({jsonrpc:"2.0",id:null,error:{code:-32700,message:"Parse error"}}));return;}
   let result;if(Array.isArray(input)){result=input.length&&input.length<=8?((await Promise.all(input.map(rpc))).filter(Boolean)): {jsonrpc:"2.0",id:null,error:{code:-32600,message:"Invalid Request"}};}else result=await rpc(input);
   if(!result||Array.isArray(result)&&!result.length)res.writeHead(204).end();else res.setHeader("content-type","application/json").end(JSON.stringify(result));
  }catch{res.writeHead(500).end();}
 });
 server.maxConnections=4;server.requestTimeout=5000;server.headersTimeout=5000;
 await mkdir(config.stateRoot,{recursive:true,mode:0o700});
 await new Promise<void>((yes,no)=>{server.once("error",no);server.listen(config.socket,yes);});await chmod(config.socket,0o660);
 return {server,runner};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const config=readPrivate(process.env.BRAI_BUG_HUNT_RUNNER_CONFIG??"") as RunnerConfig;
 try{await startRunnerServer(config);}catch{console.error("RUNNER_STARTUP_FAILED");process.exitCode=1;}
}
