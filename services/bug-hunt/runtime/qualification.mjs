// ABOUTME: Проверяет отдельный native Codex настоящим dynamic tool и непредсказуемым oracle.
// ABOUTME: Не запускается из health, не повторяет неизвестный start и не получает bearer для диагностики.
import {randomBytes} from "node:crypto";
import {lstat} from "node:fs/promises";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {readPrivate} from "../dist/config.js";
import {nativeProcessRpc} from "../dist/verification-native.js";
import {nativeThreadConfig,nativeMcpClosed} from "../dist/verification-models.js";
const fault=(code,unknown=false)=>Object.assign(new Error(code),{code,unknown});
const initial=()=>({state:"failed",model:null,contextWindow:null,toolCalls:0,oracleMatched:false,sourceRef:null,catalog_revision:null,effective_catalog_revision:null,authStoreAbsent:null,bearerPersisted:"unknown"});
const items=new Set(["userMessage","agentMessage","reasoning","dynamicToolCall","contextCompaction"]);
/** Один private native turn без SQL/Temporal. rpcFactory подменяет только transport в локальном тесте. */
export async function qualification(cfg,{rpcFactory=nativeProcessRpc,oracle=()=>"BHQ-"+randomBytes(24).toString("hex")}={}){
 const result=initial();
 let rpc,threadId,turnId,terminal=false,unsubscribe=()=>{},detach=()=>{},lost=false,wake=()=>{};
 const queue=[];
 try{
  const profiles=Object.values(cfg?.verificationRuntime?.nativeProfiles??{}).filter(p=>p?.process);
  if(profiles.length!==1)throw fault("QUALIFICATION_PROFILE_REQUIRED");
  const profile=profiles[0];
  if(!profile.filesystem_isolation_verified||profile.tool_policy_version!=="no-environment-scoped-tools-v2")throw fault("NATIVE_NOT_QUALIFIED");
  rpc=rpcFactory(profile.process,nativeThreadConfig([]));
  const prepared=await rpc.prepare();
  Object.assign(result,{model:prepared.model,contextWindow:prepared.contextWindow,sourceRef:prepared.sourceRef,catalog_revision:prepared.catalog_revision,effective_catalog_revision:prepared.effective_catalog_revision});
  const expected=oracle();
  if(typeof expected!=="string"||!expected)throw fault("QUALIFICATION_ORACLE_INVALID");
  unsubscribe=rpc.subscribe(packet=>{
   if(threadId&&packet.params?.threadId!==threadId)return;
   if(packet.id===undefined&&!["item/started","item/completed","turn/completed","thread/tokenUsage/updated"].includes(packet.method))return;
   queue.push(packet);wake();
  });
  if(typeof rpc.onDisconnect!=="function")throw fault("NATIVE_DISCONNECT_SIGNAL_REQUIRED");
  detach=rpc.onDisconnect(()=>{lost=true;wake();});
  await rpc.connect();
  await rpc.call("initialize",{clientInfo:{name:"brai_bug_hunt_qualification",version:"1.0.0"},capabilities:{experimentalApi:true}});
  rpc.send({method:"initialized",params:{}});
  const actual=[],seen=new Set();let cursor=null;
  do{const page=await rpc.call("model/list",{includeHidden:true,limit:100,cursor});if(!Array.isArray(page.data))throw fault("NATIVE_MODEL_CATALOG_MISMATCH");actual.push(...page.data);cursor=page.nextCursor;if(cursor){if(seen.has(cursor))throw fault("CATALOG_INCOMPLETE");seen.add(cursor);}}while(cursor);
  const match=actual.filter(model=>model.model===prepared.model&&model.id===prepared.model);
  if(match.length!==1||!match[0].supportedReasoningEfforts?.some(e=>e.reasoningEffort==="high"))throw fault("NATIVE_MODEL_CATALOG_MISMATCH");
  const config=await rpc.call("config/read",{cwd:profile.cwd,includeLayers:false});
  const restricted=nativeThreadConfig(Object.keys(config.config?.mcp_servers??{}),Object.keys(config.config?.plugins??{}));
  await rpc.checkBinding();
  const started=await rpc.call("thread/start",{model:prepared.model,allowProviderModelFallback:false,ephemeral:false,cwd:profile.cwd,sandbox:"read-only",approvalPolicy:"never",baseInstructions:"Connection qualification: call probe_echo exactly once with value qualification. Use only this dynamic tool. Reply only with the exact string returned by that tool; do not invent a result or use built-in tools.",developerInstructions:"",environments:[],selectedCapabilityRoots:[],dynamicTools:[{name:"probe_echo",description:"Return an unpredictable qualification result.",inputSchema:{type:"object",properties:{value:{type:"string",const:"qualification"}},required:["value"],additionalProperties:false}}],config:restricted});
  threadId=started.thread?.id;
  if(typeof threadId!=="string"||!threadId)throw fault("NATIVE_ACK_LOST",true);
  if(started.sandbox?.type!=="readOnly"||started.approvalPolicy!=="never")throw fault("NATIVE_EFFECTIVE_POLICY_INVALID");
  if(!await nativeMcpClosed(rpc,threadId))throw fault("NATIVE_MCP_ISOLATION_UNPROVEN");
  await rpc.checkBinding();
  const turn=await rpc.call("turn/start",{threadId,model:prepared.model,effort:"high",input:[{type:"text",text:"Call probe_echo with value qualification once, then reply only with its exact result."}]});
  turnId=turn.turn?.id;if(typeof turnId!=="string"||!turnId)throw fault("NATIVE_ACK_LOST",true);
  let text=null,effectiveContext=null;
  while(!terminal){
   if(lost||rpc.connected?.()===false)throw fault("NATIVE_CONNECTION_LOST",true);
   const packet=queue.shift();if(!packet){await new Promise(resolve=>{wake=resolve;});continue;}
   if(packet.params?.threadId!==threadId)continue;
   const params=packet.params;
   if(packet.method==="thread/tokenUsage/updated"&&(!params.turnId||params.turnId===turnId)){
    const window=params.tokenUsage?.modelContextWindow;if(Number.isSafeInteger(window)&&window>0)effectiveContext=window;continue;
   }
   if(params.turnId!==turnId&&params.turn?.id!==turnId)continue;
   if(packet.id!==undefined){
    if(packet.method!=="item/tool/call"||params.tool!=="probe_echo"||!params.callId||JSON.stringify(params.arguments)!==JSON.stringify({value:"qualification"})||result.toolCalls!==0)throw fault("NATIVE_UNEXPECTED_REQUEST");
    await rpc.checkBinding();result.toolCalls++;
    rpc.send({id:packet.id,result:{success:true,contentItems:[{type:"inputText",text:expected}]}});continue;
   }
   if(["item/started","item/completed"].includes(packet.method)){
    if(!items.has(params.item?.type))throw fault("NATIVE_UNEXPECTED_REQUEST");
    if(packet.method==="item/completed"&&params.item.type==="agentMessage"&&params.item.phase!=="commentary")text=params.item.text;
   }
   if(packet.method==="turn/completed"){
    terminal=true;
    if(packet.params.turn.status!=="completed"||(packet.params.turn.items??[]).some(item=>!items.has(item.type)))throw fault("NATIVE_TURN_FAILED");
   }
  }
  await rpc.checkBinding();
  const history=await rpc.call("thread/turns/list",{threadId,limit:100,itemsView:"full"});
  const own=(history.data??[]).find(item=>item.id===turnId);
  if(!own||own.status!=="completed"||(own.items??[]).some(item=>!items.has(item.type)))throw fault("NATIVE_HISTORY_INVALID");
  text=(own.items??[]).filter(item=>item.type==="agentMessage"&&item.phase!=="commentary").at(-1)?.text??text;
  result.oracleMatched=typeof text==="string"&&text.trim()===expected;
  if(result.toolCalls!==1||!result.oracleMatched)throw fault("QUALIFICATION_ORACLE_MISMATCH");
  if(!effectiveContext)throw fault("NATIVE_EFFECTIVE_CONTEXT_MISSING");result.contextWindow=effectiveContext;
  result.state="verified";
 }catch(error){
  const code=typeof error?.code==="string"&&/^[A-Z][A-Z_]+$/.test(error.code)?error.code:"QUALIFICATION_FAILED";
  result.state=error?.unknown||error?.outcome==="unknown"||["NATIVE_CONNECTION_LOST","NATIVE_RPC_TIMEOUT"].includes(code)?"unknown":"failed";result.code=code;
 }finally{
  if(rpc&&threadId&&turnId&&!terminal)await rpc.call("turn/interrupt",{threadId,turnId}).catch(()=>{});
  if(rpc&&threadId)await rpc.call("thread/archive",{threadId}).catch(()=>{});
  unsubscribe();detach();await rpc?.close();
  const profiles=Object.values(cfg?.verificationRuntime?.nativeProfiles??{}).filter(p=>p?.process);
  if(profiles.length===1){try{await lstat(path.join(profiles[0].process.stateRoot,".codex","auth.json"));result.authStoreAbsent=false;if(result.state==="verified"){result.state="failed";result.code="NATIVE_AUTH_STORE_PRESENT";}}catch(error){if(error.code==="ENOENT")result.authStoreAbsent=true;else{result.authStoreAbsent=null;if(result.state==="verified"){result.state="failed";result.code="NATIVE_AUTH_STORE_UNKNOWN";}}}}
 }
 return result;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 let result;
 try{if(process.argv.length!==4||process.argv[2]!=="--config")throw fault("QUALIFICATION_CONFIG_REQUIRED");result=await qualification(readPrivate(process.argv[3]));}
 catch{result={...initial(),code:"QUALIFICATION_CONFIG_INVALID"};}
 process.stdout.write(JSON.stringify(result)+"\n");if(result.state!=="verified")process.exitCode=1;
}
