// ABOUTME: Проверяет существующий Providers chat/tools/continuation на ограниченном synthetic вводе.
// ABOUTME: Сохраняет intent и checkpoint; повтор запуска только inspect прежнего operationId.
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {readFileSync,writeFileSync,existsSync,mkdirSync} from "node:fs";
import {connect} from "nats";
import {createProvidersClient} from "@brai/providers";
import {providersExecutor} from "../dist/verification-models.js";
assert.equal(process.env.BUG_HUNT_PREFLIGHT_TARGET,"dev");
const run=process.env.BUG_HUNT_VERIFICATION_PROBE_RUN;assert.match(run??"",/^[a-f0-9-]{36}$/);
const root=new URL("../../../tmp/",import.meta.url);mkdirSync(root,{recursive:true});
const file=new URL("providers-verification-"+run+".json",root);
const nc=await connect({servers:"nats://127.0.0.1:4223",user:process.env.NATS_USER,pass:process.env.NATS_PASSWORD,inboxPrefix:process.env.NATS_INBOX_PREFIX??"_INBOX.providers_caller",timeout:3000});
const profile={connectionId:"acceptance",provider:"openrouter",model:"deepseek/deepseek-v3.2",revision:"synthetic-v3-qualified",inboxPrefix:"_INBOX.providers_client."};
const owner="bug-hunt-synthetic-"+run;
let journal=existsSync(file)?JSON.parse(readFileSync(file,"utf8")):{nonce:randomUUID(),calls:0,toolCalls:0,intent:null,checkpoint:null};
const save=()=>writeFileSync(file,JSON.stringify(journal),{mode:0o600});
try{
 const msg=await nc.request("brai.providers.v1.models.get",JSON.stringify({provider:profile.provider,model:profile.model}),{timeout:10000});
 const card=JSON.parse(msg.data);assert.ok(card.capabilities.includes("chat")&&card.capabilities.includes("tools"),JSON.stringify(card));console.log(JSON.stringify({catalog:{provider:card.provider,model:card.model,capabilities:card.capabilities}}));
 const client=createProvidersClient(nc,{ownerId:owner,connectionId:profile.connectionId,inboxPrefix:profile.inboxPrefix});
 const checked=Object.fromEntries(Object.entries(client).map(([name,fn])=>[name,async(...args)=>{try{return await fn(...args);}catch(e){console.log(JSON.stringify({public_client_error:{method:name,name:e.name,code:e.code,outcome:e.outcome}}));throw e;}}]));
 const executor=providersExecutor(nc,owner,profile,{tools:()=>[{type:"function",function:{name:"qualification_probe",description:"Returns the synthetic nonce. Call exactly once.",parameters:{type:"object",properties:{},required:[],additionalProperties:false}}}],allowed:async()=>true,reserve:async()=>{journal.calls++;assert.ok(journal.calls<=2);save();},call:async(id,name,args)=>{assert.equal(name,"qualification_probe");assert.deepEqual(args,{});journal.toolCalls++;assert.ok(journal.toolCalls<=1);save();return {nonce:journal.nonce};}},checked);
 const fresh=!journal.intent;
 if(fresh){journal.intent={id:randomUUID(),scope:{installation_id:"synthetic",owner_id:owner,investigation_id:randomUUID()},phase:"investigator",executor:"providers",config_hash:"a".repeat(64),model:{id:profile.model,effort:null,catalog_revision:profile.revision,resolver_version:"providers-profile-v1"},deadline_at:new Date(Date.now()+90000).toISOString(),input:{task:'Call qualification_probe exactly once, then return only valid JSON {"nonce":"the exact tool nonce"}. No Markdown, no code fences, no commentary. Do not invent a nonce.',output_schema:{type:"object",additionalProperties:false,properties:{nonce:{type:"string"}},required:["nonce"]}},input_hash:"b".repeat(64)};save();}
 let cp=await (fresh?executor.startStep(journal.intent,async cp=>{journal.checkpoint=cp;save();}):executor.inspectStep(journal.intent,journal.checkpoint,async cp=>{journal.checkpoint=cp;save();}));
 for(let n=0;n<8&&cp.state==="running";n++)cp=await executor.inspectStep(journal.intent,cp,async next=>{journal.checkpoint=next;save();});
 journal.checkpoint=cp;save();console.log(JSON.stringify({checkpoint:{state:cp.state,code:cp.code,round:cp.native.round,operation_id:cp.native.operationId,previous:cp.native.previous,calls:journal.calls,tool_calls:journal.toolCalls,result_shape:typeof cp.result?.text==="string"?{first:cp.result.text.slice(0,10),last:cp.result.text.slice(-10)}:null}}));assert.equal(cp.state,"completed",JSON.stringify({state:cp.state,code:cp.code}));assert.equal(cp.result.nonce,journal.nonce);assert.equal(journal.toolCalls,1);
 console.log(JSON.stringify({executor:"providers",model:profile.model,state:cp.state,model_calls:journal.calls,tool_calls:journal.toolCalls,continuation_verified:true}));
}finally{await nc.close();}
