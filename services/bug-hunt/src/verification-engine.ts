// ABOUTME: Собирает ограниченное расследование, общий dispatcher и отдельную проверку результата.
// ABOUTME: При неопределённом эффекте читает прежние checkpoints и не создаёт новую попытку.
import {randomUUID} from "node:crypto";
import {readFileSync} from "node:fs";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import type {Tool} from "@brai/providers";
import {prepareExternalProjection} from "./projection.js";
import {VerificationFault as VF,resolveSol,validateResult,sameScope,type InvestigationExecutor,type ModelIntent,type ModelCheckpoint,type Scope,type Evidence,type Candidate,type Review,type ReproductionRunner,type RunSpec,type Oracle} from "./verification.js";
import {verificationHash as hash,type createVerificationStore,type Investigation} from "./verification-store.js";
import type {sourceReader} from "./verification-sources.js";
import type {Dispatch} from "./verification-models.js";
type Store=ReturnType<typeof createVerificationStore>;
type Row=Record<string,any>;
export interface PreparedRecipe {ref:string;recipe_id:string;recipe_version:string;source_id:string;source_commit:string;source_sha256:string;source_tree_sha256:string;source_path:string;requirement_path:string;requirement_sha256:string;expected:string;fixture_ref:string;refutes_claim?:string;confirms_claim?:string}
interface Options {store:Store;sources:ReturnType<typeof sourceReader>;runner:ReproductionRunner;recipes:PreparedRecipe[];activeOwner:(id:string)=>Promise<boolean>;executor:(r:Investigation,d:Dispatch)=>InvestigationExecutor}
const schema=JSON.parse(readFileSync(new URL("../schemas/verification-v3.schema.json",import.meta.url),"utf8"));
const ajv=new Ajv.default({strict:false});addFormats.default(ajv);ajv.addSchema(schema);
const checkCandidate=ajv.getSchema(schema.$id+"#/definitions/candidate")!,checkReview=ajv.getSchema(schema.$id+"#/definitions/modelReview")!;
const tool=(name:string,description:string,properties:Row,required=Object.keys(properties)):Tool=>({type:"function",function:{name,description,parameters:{type:"object",additionalProperties:false,properties,required}}});
const text={type:"string"},integer={type:"integer"};
const uuid=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const tools=[
 tool("evidence_list","Страница метаданных evidence. Передай next_cursor как after_id для следующей страницы.",{after_id:{type:"string",description:"UUID next_cursor предыдущей страницы."},limit:{type:"integer",description:"Размер страницы от 1 до 20."}},[]),
 tool("evidence_read","Ограниченный фрагмент разрешённого evidence.",{evidence_id:text,offset:integer,limit:integer}),
 tool("source_read","Фрагмент immutable исходника из разрешённого registry.",{source_id:text,path:text,first_line:integer,last_line:integer}),
 tool("case_related","Зафиксированные участники scope, без расширения прав.",{}),
 tool("reproduction_run","Допустимый recipe по предварительно проверенному spec_ref.",{spec_ref:text}),
 tool("reproduction_get","Квитанция своего сохранённого execution_id.",{execution_id:text})
];
/** Возвращает поддержанный набор tools; reviewer не получает запуск recipe. */
export const investigationTools=(phase:"investigator"|"reviewer")=>tools.filter(t=>phase!=="reviewer"||t.function.name!=="reproduction_run");
/** Идентификатор детерминированного свидетельства не зависит от повторного чтения. */
const evidenceId=(value:unknown)=>{const h=hash(value);return h.slice(0,8)+"-"+h.slice(8,12)+"-4"+h.slice(13,16)+"-8"+h.slice(17,20)+"-"+h.slice(20,32);};
/** Один Activity-проход возвращает только короткий безопасный статус для Workflow history. */
export function createVerificationEngine(options:Options){
 const {store}=options;
 return {async advance(id:string):Promise<{terminal:boolean;wait_ms:number;code:string}>{
  const result=await store.guard(id,async r=>{
   const scope:Scope={installation_id:r.installation_id,owner_id:r.owner_id,investigation_id:r.id};
   const allowed=async()=>await store.allowed(r)&&await options.activeOwner(r.owner_id);
   const effects=await store.effects(r);
   if(r.cancel_requested){
    for(const effect of effects.filter(e=>e.kind==="model"&&!["completed","failed"].includes(e.checkpoint.state)&&!(e.checkpoint.state==="blocked"&&!e.checkpoint.native.turnId&&!e.checkpoint.native.operationId))){const executor=options.executor(r,{tools:()=>[],call:async()=>{throw new VF("CANCEL_REQUESTED");},reserve:async()=>{throw new VF("CANCEL_REQUESTED");},allowed:async()=>false});let cp;try{cp=await executor.cancelStep(effect.intent,effect.checkpoint).catch(()=>({...effect.checkpoint,state:"unknown",code:"CANCEL_UNKNOWN"}));}finally{executor.close?.();}await store.checkpoint(r,effect.id,cp);if(cp.state==="unknown"||cp.state==="running"){await store.set(r,"outcome_unknown","CANCEL_UNKNOWN");return {terminal:false,wait_ms:60000,code:"CANCEL_UNKNOWN"};}}
    for(const effect of effects.filter(e=>e.kind==="runner")){const receipt=await options.runner.cancel(scope,effect.intent.execution_id).catch(()=>null);if(!receipt||!receipt.finished_at){await store.set(r,"outcome_unknown","RUNNER_CANCEL_UNKNOWN");return {terminal:false,wait_ms:60000,code:"RUNNER_CANCEL_UNKNOWN"};}}
    await store.set(r,"cancelled");return {terminal:true,wait_ms:0,code:"CANCELLED"};
   }
   if(!await allowed()){r.charge_active=false;await store.set(r,"blocked_policy","POLICY_OR_OWNER_REVOKED");return {terminal:false,wait_ms:60000,code:"POLICY_OR_OWNER_REVOKED"};}
   if(r.deadline_at&&r.deadline_at.getTime()<Date.now()&&!effects.some(e=>["dispatching","running","unknown"].includes(e.checkpoint.state))){
    await store.set(r,"failed","ATTEMPT_DEADLINE");return {terminal:true,wait_ms:0,code:"ATTEMPT_DEADLINE"};
   }
   let phase:"investigator"|"reviewer"=r.stage==="review"?"reviewer":"investigator";
   const dispatch:Dispatch={
    tools:investigationTools,allowed,remainingMs:()=>Math.max(0,r.deadline_at!.getTime()-Date.now()),
    reserve:()=>store.reserve(r,r.executor==="providers"?4096:0),
    async call(callId,name,args){
     if(!callId||callId.length>200||!tools.some(t=>t.function.name===name)||phase==="reviewer"&&name==="reproduction_run")throw new VF("TOOL_FORBIDDEN");
     const definition=investigationTools(phase).find(t=>t.function.name===name)!;
     const validate=ajv.compile(definition.function.parameters);
     if(!validate(args)||Buffer.byteLength(JSON.stringify(args))>4096)throw new VF("INVALID_TOOL_ARGUMENT");
     const a=args as Row;
     if(name==="evidence_read"&&!uuid.test(a.evidence_id)||name==="evidence_list"&&(a.after_id!==undefined&&!uuid.test(a.after_id)||a.limit!==undefined&&(!Number.isSafeInteger(a.limit)||a.limit<1||a.limit>20)))throw new VF("INVALID_TOOL_ARGUMENT");
     const input={phase,call_id:callId,name,args},effect=await store.effect(r,"tool",phase+":"+callId,input);
     if(effect.checkpoint.state==="completed")return effect.checkpoint.result;
     const all=await store.effects(r);if(r.policy.budgets.toolCalls!==null&&all.filter(e=>e.kind==="tool").length>r.policy.budgets.toolCalls)throw new VF("TOOL_LIMIT");
     if(!await allowed())throw new VF("POLICY_REVOKED");
     let value:unknown;
     const recordRun=async(run:Row,receipt:any)=>{
      const spec=run.intent as RunSpec;
      if(!receipt||!sameScope(receipt.scope,scope)||receipt.execution_id!==spec.execution_id||receipt.spec_sha256!==spec.spec_sha256||receipt.source_commit!==spec.source_commit||receipt.source_sha256!==spec.source_sha256||receipt.source_tree_sha256!==spec.source_tree_sha256||receipt.oracle_sha256!==spec.oracle_sha256||receipt.recipe_id!==spec.recipe_id||receipt.recipe_version!==spec.recipe_version)throw new VF("RUNNER_OUTCOME_UNKNOWN","unknown");
      await store.checkpoint(r,run.id,{state:receipt.finished_at?"completed":"running",result:receipt,oracle:spec.oracle,spec,native:{},usage:null,code:null});
      if(!receipt.finished_at)return {execution_id:spec.execution_id,state:"running"};
      const text=JSON.stringify(receipt),runnerEvidence:Evidence={id:evidenceId([scope,spec.execution_id,"receipt"]),scope,kind:"runner",sha256:hash(text),text,provenance:{execution_id:spec.execution_id,spec_sha256:spec.spec_sha256},availability:"available",external_allowed:true};
      await store.putEvidence(r,runnerEvidence);return {execution_id:spec.execution_id,evidence_id:runnerEvidence.id,receipt};
     };
     if(name==="evidence_list")value=await store.evidencePage(r,a.after_id??null,a.limit??20);
     else if(name==="case_related")value=r.snapshot.cases.map(c=>({case_id:c.case_id,report_id:c.report_id,input_hash:c.input_hash}));
     else if(name==="evidence_read"){
      const e=(await store.evidenceByIds(r,[a.evidence_id]))[0];if(!e||!e.external_allowed)throw new VF("EVIDENCE_FORBIDDEN");
      if(a.offset<0||a.offset>65536||a.limit<1||a.limit>4096)throw new VF("INVALID_TOOL_ARGUMENT");
      value={id:e.id,text:Array.from(e.text).slice(a.offset,a.offset+a.limit).join(""),sha256:e.sha256,provenance:e.provenance};
     }else if(name==="source_read"){
      const source=await options.sources.read(r.snapshot,a.source_id,a.path,a.first_line,a.last_line);
      if(!source.external_allowed)throw new VF("EXTERNAL_PROJECTION_FORBIDDEN");
      const kind=options.recipes.some(s=>s.requirement_path===a.path&&s.source_id===a.source_id)?"requirement":"source";
      const evidence:Evidence={id:evidenceId([scope,source.provenance]),scope,kind,...source,availability:"available"};
      await store.putEvidence(r,evidence);value=evidence;
     }else if(name==="reproduction_get"){
      const owned=all.find(e=>e.kind==="runner"&&e.intent.execution_id===a.execution_id);if(!owned)throw new VF("NOT_FOUND");
      try{const receipt=await options.runner.get(scope,a.execution_id);value=receipt?await recordRun(owned,receipt):{execution_id:a.execution_id,state:"outcome_unknown"};}catch(error){if(!(error instanceof VF)||error.outcome!=="unknown")throw error;value={execution_id:a.execution_id,state:"outcome_unknown"};}
     }else{
      const execution_id=evidenceId([scope,phase,callId,"runner"]);
      const unresolved=all.find(e=>e.kind==="runner"&&!["completed","failed"].includes(e.checkpoint.state)&&!(e.checkpoint.state==="not_sent"&&e.intent.execution_id===execution_id));
      if(unresolved)value={execution_id:unresolved.intent.execution_id,state:"outcome_unknown",code:"RUNNER_RECOVERY_REQUIRED"};
      else{
      const template=options.recipes.find(s=>s.ref===a.spec_ref&&s.source_id===r.snapshot.source?.id&&s.source_commit===r.snapshot.source?.commit);
      if(!template)throw new VF("RECIPE_NOT_ALLOWED");
      const [requirement,source]=await Promise.all([store.evidenceSource(r,"requirement",template.source_id,template.requirement_path,template.requirement_sha256),store.evidenceSource(r,"source",template.source_id,template.source_path,template.source_sha256)]);
      if(!requirement||!source)throw new VF("RECIPE_EVIDENCE_REQUIRED");
      const oracle:Oracle={requirement_id:requirement.id,requirement_sha256:requirement.sha256,expected:template.expected,version:"registry-oracle-v1",...(template.confirms_claim?{confirms_claim:template.confirms_claim}:{}),...(template.refutes_claim?{refutes_claim:template.refutes_claim}:{})};
      const body={execution_id,scope,recipe_id:template.recipe_id,recipe_version:template.recipe_version,source_id:template.source_id,source_commit:template.source_commit,source_sha256:template.source_sha256,source_tree_sha256:template.source_tree_sha256,oracle,oracle_sha256:hash(oracle),fixture_ref:template.fixture_ref};
      const old=all.find(e=>e.kind==="runner"&&e.step_key===execution_id);
      const spec:RunSpec=old?.intent??{...body,spec_sha256:hash(body),deadline_at:new Date(Math.min(r.deadline_at!.getTime(),Date.now()+120000)).toISOString()};
      const run=await store.effect(r,"runner",execution_id,spec);
      if(all.filter(e=>e.kind==="runner").length+(run.fresh?1:0)>r.policy.budgets.runnerRuns)throw new VF("RUNNER_LIMIT");
      if(run.checkpoint.state==="not_sent")await store.checkpoint(r,run.id,{state:"dispatching",native:{},result:null,code:null,usage:null});
      try{
       if(run.checkpoint.state==="not_sent")value=await options.runner.start(spec);
       else value=await options.runner.get(scope,execution_id);
       value=value?await recordRun(run,value):{execution_id,state:"outcome_unknown"};
      }catch(error){if(!(error instanceof VF)||error.outcome!=="unknown")throw error;value={execution_id,state:"outcome_unknown"};}
      }
     }
     if(Buffer.byteLength(JSON.stringify(value))>16384)throw new VF("TOOL_RESULT_TOO_LARGE");
     await store.checkpoint(r,effect.id,{state:"completed",result:value,native:{},code:null,usage:null});return value;
    }
   };
   let executor:InvestigationExecutor|undefined;
   try{
    executor=options.executor(r,dispatch);
    if(!r.model){
     const ready=await executor.preflight();if(!ready.ready){r.charge_active=false;await store.set(r,"waiting_dependency",ready.code);return {terminal:false,wait_ms:60000,code:ready.code??"DEPENDENCY_UNAVAILABLE"};}
     const model=r.executor==="codex_app_server"?resolveSol(ready.models,ready.catalog_revision):{id:r.policy.profiles.providers.model,effort:null,catalog_revision:r.policy.profiles.providers.revision,resolver_version:"providers-profile-v1"};
     await store.set(r,"running",null,r.stage,model);r.model=model;
    }
    const prior=effects.find(e=>e.kind==="model"&&e.step_key===phase);
    let intent:ModelIntent;
    if(prior)intent=prior.intent;
    else{
     const projections=r.snapshot.cases.map(c=>({case_id:c.case_id,input_hash:c.input_hash,projection:prepareExternalProjection(c.observation as any,[r.owner_id])}));
     if(projections.some(p=>!p.projection))throw new VF("EXTERNAL_PROJECTION_FORBIDDEN");
     const author=effects.find(e=>e.kind==="model"&&e.step_key==="investigator")?.checkpoint.result;
     const evidence=phase==="reviewer"?await store.evidenceByIds(r,[...new Set<string>([...(author?.evidence_ids??[]),author?.requirement_id,author?.source_id,author?.runner_id].filter((id):id is string=>typeof id==="string"))]):[];
     const input={snapshot:{version:3,cases:projections,source:r.snapshot.source,group:r.snapshot.group},evidence:evidence.map(e=>({id:e.id,kind:e.kind,sha256:e.sha256,provenance:e.provenance})),evidence_manifest:{read_via:"evidence_list",page_size:20},available_specs:options.recipes.filter(s=>s.source_commit===r.snapshot.source?.commit&&s.source_id===r.snapshot.source?.id).map(s=>({spec_ref:s.ref,source_path:s.source_path,requirement_path:s.requirement_path,oracle:{expected:s.expected,...(s.confirms_claim?{confirms_claim:s.confirms_claim}:{})},...(s.refutes_claim?{refutes_claim:s.refutes_claim}:{})})),...(phase==="reviewer"?{candidate:author,candidate_sha256:hash(author)}:{}),output_schema:schema.definitions[phase==="reviewer"?"modelReview":"candidate"]};
     if(Buffer.byteLength(JSON.stringify(input))>(r.executor==="providers"?8000:32768))throw new VF("MODEL_INPUT_TOO_LARGE");
     const body={id:evidenceId([scope,phase,"model"]),scope,phase,executor:r.executor,config_hash:r.config_hash,model:r.model,deadline_at:r.deadline_at!.toISOString(),input};
     intent={...body,input_hash:hash(input)} as ModelIntent;
    }
    const effect=await store.effect(r,"model",phase,intent),save=(cp:ModelCheckpoint)=>store.checkpoint(r,effect.id,cp);
    const cp:ModelCheckpoint=effect.fresh||effect.checkpoint.state==="not_sent"||effect.checkpoint.state==="blocked"&&Object.keys(effect.checkpoint.native).length===0?await executor.startStep(intent,save):await executor.inspectStep(intent,effect.checkpoint,save);
    await save(cp);
    if(cp.state!=="completed"){const state=cp.state==="unknown"?"outcome_unknown":cp.state==="blocked"?"waiting_dependency":cp.state==="failed"?"failed":"running";await store.set(r,state,cp.code);return {terminal:state==="failed",wait_ms:state==="running"&&!cp.native.operationId?1:60000,code:cp.code??"PENDING"};}
    if(phase==="investigator"){
     if(!checkCandidate(cp.result)||Buffer.byteLength(JSON.stringify(cp.result))>32768)throw new VF("CANDIDATE_INVALID");
     await store.set(r,"running",null,"review");return {terminal:false,wait_ms:1,code:"REVIEW_PENDING"};
    }
    if(!checkReview(cp.result))throw new VF("REVIEW_INVALID");
    const author=(await store.effects(r)).find(e=>e.kind==="model"&&e.step_key==="investigator")!.checkpoint.result as Candidate;
    const allEvidence=await store.evidenceByIds(r,[...new Set<string>([...author.evidence_ids,...(cp.result as Review).evidence_ids,author.requirement_id,author.source_id,author.runner_id].filter((id):id is string=>typeof id==="string"))]),run=(await store.effects(r)).find(e=>e.kind==="runner"&&e.checkpoint.result?.execution_id===allEvidence.find(e=>e.id===author.runner_id)?.provenance.execution_id);
    const receipt=validateResult({scope,snapshot:r.snapshot,candidate:author,candidateHash:hash(author),review:cp.result as Review,evidence:allEvidence,receipt:run?.checkpoint.result??null,oracle:run?.checkpoint.oracle??null,hash});
    const result_id=await store.publish(r,{...author,snapshot_hash:r.snapshot_hash,case_ids:r.snapshot.cases.map(c=>c.case_id),model:r.model,executor:r.executor,config_revision:r.policy.revision,origin:"automatic_evidence",evidence_availability:allEvidence.every(e=>e.availability==="available")?"available":"partial"},receipt);
    return {terminal:true,wait_ms:0,code:"PUBLISHED"};
   }catch(e){const code=e instanceof VF?e.code:"VERIFICATION_FAILED";if(code==="CANCEL_REQUESTED"){await store.set(r,"running","CANCEL_REQUESTED");return {terminal:false,wait_ms:1,code:"CANCEL_REQUESTED"};}const unknown=e instanceof VF&&e.outcome==="unknown";await store.set(r,unknown?"outcome_unknown":"failed",code);return {terminal:!unknown,wait_ms:60000,code};}finally{executor?.close?.();}
  });
  return result??(await store.terminal(id)?{terminal:true,wait_ms:0,code:"ALREADY_TERMINAL"}:{terminal:false,wait_ms:60000,code:"BUSY"});
 }};
}
