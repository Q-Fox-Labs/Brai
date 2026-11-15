// ABOUTME: Хранит scoped задания, intent, бюджеты и результаты обработки bug-hunt.
// ABOUTME: Сохранённый pending intent занимает модельный слот; вызовы выполняются вне SQL-транзакции.
import {createHash,createHmac,timingSafeEqual,randomUUID} from "node:crypto";
import type {Pool,PoolClient} from "pg";
import {Fault,canonical,type Observation,type Principal} from "./contracts.js";
import {SystemFault,type SimilarInput} from "./system-contracts.js";
import {EMBEDDING_MODEL,GENERATION,PROJECTION_VERSION,validateEmbedding} from "./projection.js";
import {PIPELINE_VERSION,QUESTION_VERSION,observationHash,type ProcessingJob,type Attempt,type ProcessingStore,type JobState,type Branch} from "./processing.js";

import {prepareGenerations,generationPattern,type GenerationMetadata,type GenerationState} from "./generations.js";

export interface ActivateGenerationInput {request_id:string;generation:string;expected_active_generation:string;reason:string}
export interface ProcessingStoreOptions {
 targetGeneration?:string;target?:()=>string;
 installationId:string;cursorKey:string;leaseMs?:number;maxDatabaseBytes?:number;intakeReserveBytes?:number;maxDerivativeBytes?:number;
 dailyLimits?:{embedding:{owner:number|null;global:number|null};classification:{owner:number;global:number}};
 policy?:()=>Pick<ProcessingStoreOptions,"dailyLimits"|"maxDatabaseBytes"|"intakeReserveBytes"|"maxDerivativeBytes">;
}
const NON_EMBEDDING_GENERATION="gemma2-symmetric-v1";
export interface EnqueuedReport {id:string;case_id:string;owner_id:string;installation_id:string;observation:Observation}
/** Включает три обязательства в уже открытую intake-транзакцию, не коммитит её. */
export async function enqueueProcessing(db:Pick<PoolClient,"query">,report:EnqueuedReport,priority:"new"|"backfill"="new",target=GENERATION):Promise<void>{
 await prepareGenerations(db,report.installation_id,target);
 const hash=observationHash(report.observation);
 for(const branch of ["local","embedding","classification"]){
  await db.query("INSERT INTO processing_job(id,installation_id,owner_id,report_id,case_id,branch,pipeline_version,input_hash,priority,business_attempt_id,index_generation) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(installation_id,owner_id,report_id,pipeline_version,branch,index_generation) DO NOTHING",[randomUUID(),report.installation_id,report.owner_id,report.id,report.case_id,branch,PIPELINE_VERSION,hash,priority,randomUUID(),branch==="embedding"?target:NON_EMBEDDING_GENERATION]);
 }
}
const attemptRow=(r:any):Attempt=>({...r,deadline_at:new Date(r.deadline_at).toISOString()});
const key=(j:ProcessingJob)=>[j.id,j.fence,j.input_hash,j.pipeline_version,j.installation_id,j.owner_id];
const fence="id=$1 AND fence=$2 AND input_hash=$3 AND pipeline_version=$4 AND installation_id=$5 AND owner_id=$6 AND state='running' AND lease_until>clock_timestamp()";
const safeCode=(code?:string)=>code&&/^[A-Z_]{1,64}$/.test(code)?code:null;
const columns="id AS job_id,index_generation,branch,state,code,technical_attempts AS attempt_count,coverage";
const resultColumns="id,report_id,input_hash,model_id,model_revision,profile_id,question_version,projection_version,payload,registered_at";
/** Создаёт SQL-адаптер; переданный отдельный pool обязан иметь max<=2. DDL не выполняется. */
export function createProcessingStore(pool:Pool,options:ProcessingStoreOptions):ProcessingStore&{
 enrichmentModel(p:Principal,caseId:string):Promise<unknown>;similar(p:Principal,input:SimilarInput):Promise<unknown>;
 mayIndex():Promise<boolean>;
 activateGeneration(p:Principal,input:ActivateGenerationInput):Promise<unknown>;
 processingStatus(p:Principal):Promise<unknown>;pause(p:Principal,input:{request_id:string;paused:boolean;reason:string}):Promise<unknown>;
 retryUnknown(p:Principal,input:{request_id:string;job_id:string;business_attempt_id:string;reason:string}):Promise<unknown>;
}{
 if((pool.options.max??10)>2)throw new Error("PROCESSING_POOL_LIMIT");
 const installation=options.installationId,lease=Math.max(1000,Math.min(options.leaseMs??30000,60000));
 const target=()=>{const value=options.target?.()??options.targetGeneration??GENERATION;if(!generationPattern.test(value))throw new Error("INVALID_GENERATION");return value;};
 const limits=options.dailyLimits??{embedding:{owner:100,global:1000},classification:{owner:20,global:100}};
 if(!Object.entries(limits).every(([branch,v])=>branch==="embedding"&&v.owner===null&&v.global===null||Object.values(v).every(n=>typeof n==="number"&&Number.isSafeInteger(n)&&n>=0)))throw new Error("INVALID_PROCESSING_BUDGET");
 async function tx<T>(work:(db:PoolClient)=>Promise<T>):Promise<T>{
  const db=await pool.connect();
  try{await db.query("BEGIN");await db.query("SET LOCAL statement_timeout='3000ms'");await db.query("SET LOCAL lock_timeout='2000ms'");const value=await work(db);await db.query("COMMIT");return value;}
  catch(error){try{await db.query("ROLLBACK");}catch{}throw error;}finally{db.release();}
 }
 async function control(db:PoolClient){
  await db.query("INSERT INTO processing_control(installation_id) VALUES($1) ON CONFLICT DO NOTHING",[installation]);
  return (await db.query("SELECT * FROM processing_control WHERE installation_id=$1 FOR UPDATE",[installation])).rows[0];
 }
 function currentPolicy(){
  const policy=options.policy?options.policy():options;
  const dailyLimits=policy.dailyLimits??limits;
  if(!Object.entries(dailyLimits).every(([branch,v])=>branch==="embedding"&&v.owner===null&&v.global===null||Object.values(v).every(n=>typeof n==="number"&&Number.isSafeInteger(n)&&n>=0)))throw new Error("INVALID_PROCESSING_BUDGET");
  return {dailyLimits,maxDatabaseBytes:policy.maxDatabaseBytes??1073741824,intakeReserveBytes:policy.intakeReserveBytes??67108864,maxDerivativeBytes:policy.maxDerivativeBytes??268435456};
 }
 const derivativeTables=["search_document","report_signature","observation_group","group_membership","grouping_decision","group_audit","similarity_proposal","classification","classification_override","processing_job","processing_attempt","processing_budget","processing_control","processing_operator_action","embedding_chunk","v2_mutation","embedding_generation","embedding_generation_control","embedding_generation_activation"];
 async function derivativeBytes(db:Pick<PoolClient,"query">):Promise<number>{
  const result=await db.query("SELECT coalesce(sum(pg_total_relation_size(c.oid)),0)::text AS bytes FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND c.relname=ANY($1::text[])",[derivativeTables]);
  return Number(result.rows[0].bytes);
 }
 async function capacity(db:PoolClient,bytes:number,policy=currentPolicy()):Promise<boolean>{
  const state=await control(db);
  const size=Number((await db.query("SELECT pg_database_size(current_database()) AS bytes")).rows[0].bytes);
  return Math.max(Number(state.derivative_bytes),await derivativeBytes(db))+bytes<=(policy.maxDerivativeBytes??268435456)&&size+bytes<(policy.maxDatabaseBytes??1073741824)-(policy.intakeReserveBytes??67108864);
 }
 async function locked(db:PoolClient,job:ProcessingJob):Promise<boolean>{
  return !!(await db.query("SELECT 1 FROM processing_job WHERE "+fence+" FOR UPDATE",key(job))).rowCount;
 }
 /** Новый build и ещё не выполненный retry старого job не разрешают повторить исторический possible spend. */
 async function priorGenerationResolved(db:PoolClient,job:ProcessingJob):Promise<boolean>{
  if(job.branch!=="embedding")return true;
  const unresolved=await db.query("SELECT 1 FROM processing_job old WHERE old.installation_id=$1 AND old.owner_id=$2 AND old.report_id=$3 AND old.branch='embedding' AND old.index_generation<>$4 AND old.state<>'succeeded' AND (old.state='outcome_unknown' OR EXISTS(SELECT 1 FROM processing_attempt a WHERE a.job_id=old.id AND a.phase IN('dispatching','outcome_unknown'))) AND NOT EXISTS(SELECT 1 FROM processing_operator_action explicit_retry WHERE explicit_retry.job_id=$5 AND explicit_retry.business_attempt_id=$6) LIMIT 1",[installation,job.owner_id,job.report_id,job.index_generation,job.id,job.business_attempt_id]);
  if(!unresolved.rowCount)return true;
  await db.query("UPDATE processing_job SET state='blocked_policy',code='PREVIOUS_GENERATION_UNKNOWN',lease_until=NULL,updated_at=clock_timestamp() WHERE "+fence,key(job));return false;
 }
 async function lookup(db:PoolClient,p:Principal,id:string){
  const r=await db.query("SELECT id,owner_id FROM bug_case WHERE installation_id=$1 AND id=$2 AND (owner_id=$3 OR $4::boolean)",[installation,id,p.ownerId,p.reviewer]);
  if(!r.rowCount)throw new Fault("NOT_FOUND");return r.rows[0];
 }
 async function readGeneration(db:Pick<PoolClient,"query">,generation?:string):Promise<GenerationMetadata&GenerationState&{generation:string}>{
  const row=await db.query("SELECT g.generation,g.metadata,c.active_generation,c.activation_revision FROM embedding_generation_control c JOIN embedding_generation g ON g.installation_id=c.installation_id AND g.generation=coalesce($2,c.active_generation) WHERE c.installation_id=$1",[installation,generation??null]);
  if(!row.rowCount)throw new SystemFault("INDEX_NOT_READY");
  return {...row.rows[0].metadata,generation:row.rows[0].generation,active_generation:row.rows[0].active_generation,activation_revision:row.rows[0].activation_revision};
 }
 /** Полный корпус установки/владельца, без окна и без подмешивания другого поколения/pipeline. */
 async function generationCoverage(db:Pick<PoolClient,"query">,generation:string,owner?:string){
  const meta=await readGeneration(db,generation);
  const counts=await db.query(
   "WITH coverage AS(SELECT j.state,j.coverage AS job_coverage,e.any_chunks,e.complete_chunks FROM report r "+
   "LEFT JOIN processing_job j ON j.installation_id=r.installation_id AND j.owner_id=r.owner_id AND j.report_id=r.id AND j.branch='embedding' AND j.index_generation=$2 AND j.pipeline_version=$3 "+
   "LEFT JOIN LATERAL(SELECT count(*)>0 AS any_chunks,bool_and(e.coverage='complete') AS complete_chunks FROM embedding_chunk e "+
   "WHERE e.installation_id=r.installation_id AND e.owner_id=r.owner_id AND e.report_id=r.id AND e.generation=$2 AND e.input_hash=j.input_hash AND e.projection_version=$8 AND e.model_id=$5 AND e.model_revision=$6 AND e.profile_id=$7 AND e.purpose=$9) e ON true "+
   "WHERE r.installation_id=$1 AND ($4::text IS NULL OR r.owner_id=$4)) "+
   "SELECT count(*)::int AS total_reports,count(*) FILTER(WHERE state='succeeded' AND job_coverage='complete' AND any_chunks AND complete_chunks)::int AS indexed_reports,count(*) FILTER(WHERE any_chunks)::int AS any_reports FROM coverage",
   [installation,generation,meta.pipeline_version,owner??null,meta.model_id,meta.model_revision,meta.profile_id,meta.projection_version,meta.purpose]);
  const {total_reports,indexed_reports,any_reports}=counts.rows[0];
  return {total_reports,indexed_reports,state:indexed_reports===total_reports?"complete":any_reports>0?"partial":"pending"};
 }
 async function operatorMutation(p:Principal,operation:string,input:{request_id:string},work:(db:PoolClient)=>Promise<Record<string,unknown>>){
  if(!input.request_id||input.request_id.length>128)throw new Fault("INVALID_ARGUMENT");
  return tx(async db=>{
   const key=[installation,p.ownerId,p.actorId,operation,input.request_id];
   await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[JSON.stringify(key)]);
   const hash=createHash("sha256").update(canonical(input)).digest("hex");
   const previous=await db.query("SELECT input_hash,result FROM v2_mutation WHERE installation_id=$1 AND owner_id=$2 AND actor_id=$3 AND operation=$4 AND request_id=$5",key);
   if(previous.rowCount){if(previous.rows[0].input_hash!==hash)throw new Fault("IDEMPOTENCY_CONFLICT");return {...previous.rows[0].result,replayed:true};}
   const result=await work(db);
   await db.query("INSERT INTO v2_mutation(installation_id,owner_id,actor_id,operation,request_id,input_hash,result) VALUES($1,$2,$3,$4,$5,$6,$7)",[...key,hash,result]);return {...result,replayed:false};
  });
 }
 const api:ProcessingStore&any={
  async mayIndex(){return tx(db=>capacity(db,1048576));},
  async reconcile(limit=50){
   return tx(async db=>{
    if(!await capacity(db,8192))return 0;
    const build=target();await prepareGenerations(db,installation,build);
    const rows=await db.query("SELECT r.id,r.case_id,r.owner_id,r.installation_id,r.observation FROM report r WHERE r.installation_id=$1 AND EXISTS(SELECT 1 FROM (VALUES('local'),('embedding'),('classification')) AS b(branch) WHERE NOT EXISTS(SELECT 1 FROM processing_job j WHERE j.report_id=r.id AND j.owner_id=r.owner_id AND j.installation_id=r.installation_id AND j.pipeline_version=$2 AND j.branch=b.branch AND j.index_generation=CASE WHEN b.branch='embedding' THEN $4 ELSE $5 END)) ORDER BY r.registered_at,r.id LIMIT $3",[installation,PIPELINE_VERSION,Math.min(50,Math.max(1,limit)),build,NON_EMBEDDING_GENERATION]);
    for(const row of rows.rows)await enqueueProcessing(db,row,"backfill",build);return rows.rowCount??0;
   });
  },
  async claim(limit=2,branches:Branch[]=["local","embedding","classification"]){
   return tx(async db=>{
    const state=await control(db);const build=target();await prepareGenerations(db,installation,build);
    // AIDEV-NOTE: Повышение/снятие лимита будит прежний budget job в тех же сутках, сохраняя intent, business ID и расход.
    if(!state.paused){
     const daily=currentPolicy().dailyLimits;
     await db.query(`WITH ready AS (
      SELECT j.id FROM processing_job j
      JOIN (VALUES ('embedding',$4::integer,$5::integer),('classification',$6::integer,$7::integer)) AS l(branch,owner_limit,global_limit) ON l.branch=j.branch
      LEFT JOIN processing_budget g ON g.installation_id=j.installation_id AND g.branch=j.branch AND g.budget_day=(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date AND g.scope='global' AND g.owner_key=''
      LEFT JOIN processing_budget o ON o.installation_id=j.installation_id AND o.branch=j.branch AND o.budget_day=(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date AND o.scope='owner' AND o.owner_key=j.owner_id
      WHERE j.installation_id=$1 AND j.pipeline_version=$2 AND j.state='budget_exhausted' AND j.available_at>clock_timestamp()
       AND (j.branch<>'embedding' OR j.index_generation=$3) AND j.branch=ANY($8::text[])
       AND (l.global_limit IS NULL OR coalesce(g.reserved_calls,0)<l.global_limit)
       AND (l.owner_limit IS NULL OR coalesce(o.reserved_calls,0)<l.owner_limit)
      ORDER BY j.registered_at,j.id LIMIT 50 FOR UPDATE OF j SKIP LOCKED
     ) UPDATE processing_job SET available_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id IN(SELECT id FROM ready)`,
     [installation,PIPELINE_VERSION,build,daily.embedding.owner,daily.embedding.global,daily.classification.owner,daily.classification.global,branches]);
    }
    const active=await db.query("SELECT id,branch FROM processing_job WHERE installation_id=$1 AND state='running' AND lease_until>clock_timestamp()",[installation]);
    const available=Math.min(2-active.rowCount!,2,Math.max(0,limit));
    if(available<=0)return [];
    const dispatching="EXISTS(SELECT 1 FROM processing_attempt a WHERE a.job_id=j.id AND a.business_attempt_id=j.business_attempt_id AND a.phase='dispatching')";
    // AIDEV-NOTE: PROVIDER_PENDING освобождает lease, но сохраняет модельный слот до чтения исходного intent.
    const pending=await db.query("SELECT j.id,j.branch FROM processing_job j WHERE j.installation_id=$1 AND j.branch<>'local' AND j.state IN('pending','running','waiting_dependency') AND "+dispatching,[installation]);
    const occupied=new Set([...active.rows,...pending.rows].map(j=>j.id));
    const modelBusy=new Set([...active.rows,...pending.rows].filter(j=>j.branch!=="local").map(j=>j.branch));
    const candidates=await db.query(`SELECT j.*,r.observation,${dispatching} AS recovering,COALESCE((SELECT max(x.claimed_at) FROM processing_job x WHERE x.installation_id=j.installation_id AND x.owner_id=j.owner_id),'-infinity'::timestamptz) AS owner_last FROM processing_job j JOIN report r ON r.id=j.report_id AND r.case_id=j.case_id AND r.owner_id=j.owner_id AND r.installation_id=j.installation_id WHERE j.installation_id=$1 AND j.pipeline_version=$2 AND (j.branch<>'embedding' OR j.index_generation=$7 OR ${dispatching}) AND ((j.state IN('pending','waiting_dependency','budget_exhausted') AND j.available_at<=clock_timestamp()) OR (j.state='running' AND j.lease_until<=clock_timestamp())) AND (NOT $3::boolean OR ${dispatching}) AND (j.branch=ANY($5::text[]) OR ${dispatching}) AND (j.branch='local' OR NOT(j.branch=ANY($6::text[]))) AND (${dispatching} OR ($8::boolean AND (j.branch='local' OR NOT(j.branch=ANY($9::text[]))))) ORDER BY recovering DESC,CASE WHEN $4::boolean THEN (j.priority='backfill') ELSE (j.priority='new') END DESC,owner_last,j.available_at,j.registered_at,j.id FOR UPDATE OF j SKIP LOCKED LIMIT 16`,[installation,PIPELINE_VERSION,state.paused,Number(state.claim_counter)%4===3,branches,active.rows.filter(x=>x.branch!=="local").map(x=>x.branch),build,occupied.size<2,[...modelBusy]]);
    const busy=new Set(active.rows.filter(x=>x.branch!=="local").map(x=>x.branch)),selected:ProcessingJob[]=[];
    for(const row of candidates.rows){
     if(selected.length>=available)break;if(row.branch!=="local"&&busy.has(row.branch))continue;
     if(!row.recovering&&(occupied.size>=2||row.branch!=="local"&&modelBusy.has(row.branch)))continue;
     const claimed=await db.query("UPDATE processing_job SET state='running',fence=fence+1,lease_until=clock_timestamp()+($2::int*interval '1 millisecond'),claimed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1 RETURNING fence",[row.id,lease]);
     const {recovering,...job}=row;
     selected.push({...job,fence:claimed.rows[0].fence});
     if(!recovering){occupied.add(row.id);if(row.branch!=="local")modelBusy.add(row.branch);}
     if(row.branch!=="local")busy.add(row.branch);
    }
    await db.query("UPDATE processing_control SET claim_counter=claim_counter+1 WHERE installation_id=$1",[installation]);return selected;
   });
  },
  async heartbeat(job:ProcessingJob){return !!(await pool.query("UPDATE processing_job SET lease_until=clock_timestamp()+($7::int*interval '1 millisecond') WHERE "+fence,[...key(job),lease])).rowCount;},
  async mayDispatch(job:ProcessingJob){
   if(job.branch==="embedding"&&job.index_generation!==target())return false;
   return tx(async db=>{
    if(!await locked(db,job))return false;
    if(!await priorGenerationResolved(db,job))return false;
    return !(await db.query("SELECT 1 FROM processing_control WHERE installation_id=$1 AND paused",[installation])).rowCount;
   });
  },
  async latestAttempt(job:ProcessingJob,unit:number){
   const rows=await pool.query("SELECT * FROM processing_attempt WHERE job_id=$1 AND owner_id=$2 AND installation_id=$3 AND business_attempt_id=$4 AND unit=$5 ORDER BY registered_at DESC,id DESC LIMIT 1",[job.id,job.owner_id,installation,job.business_attempt_id,unit]);
   return rows.rowCount?attemptRow(rows.rows[0]):null;
  },
  async beginAttempt(job:ProcessingJob,body:Record<string,any>,unit:number,metadata:Record<string,any>){
   return tx(async db=>{
    const state=await control(db);if(state.paused||job.branch==="embedding"&&job.index_generation!==target()||!await locked(db,job))return null;
    if(!await priorGenerationResolved(db,job))return null;
    const policy=currentPolicy(),callLimits=policy.dailyLimits;
    const previous=await db.query("SELECT phase FROM processing_attempt WHERE job_id=$1 AND business_attempt_id=$2 AND unit=$3 ORDER BY registered_at DESC,id DESC LIMIT 1",[job.id,job.business_attempt_id,unit]);
    if(previous.rowCount&&previous.rows[0].phase!=="not_sent")return null;
    const bytes=Buffer.byteLength(JSON.stringify(body))*2+32768;
    const branch=job.branch as "embedding"|"classification";
    if(branch==="embedding"&&metadata.model_id!==EMBEDDING_MODEL.modelId||branch==="classification"&&metadata.model_id!=="jev-1.13.0")throw new Error("MODEL_NOT_ALLOWED");
    if(!await capacity(db,bytes,policy)){
     await db.query("UPDATE processing_job SET state='waiting_dependency',code='DERIVATIVE_CAPACITY',lease_until=NULL,available_at=clock_timestamp()+interval '1 minute' WHERE "+fence,key(job));return null;
    }
    for(const [scope,owner,max] of [["global","",callLimits[branch].global],["owner",job.owner_id,callLimits[branch].owner]] as const){
     await db.query("INSERT INTO processing_budget(installation_id,branch,budget_day,scope,owner_key) VALUES($1,$2,(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date,$3,$4) ON CONFLICT DO NOTHING",[installation,branch,scope,owner]);
     const used=await db.query("SELECT reserved_calls FROM processing_budget WHERE installation_id=$1 AND branch=$2 AND budget_day=(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date AND scope=$3 AND owner_key=$4 FOR UPDATE",[installation,branch,scope,owner]);
     if(max!==null&&used.rows[0].reserved_calls>=max){await db.query("UPDATE processing_job SET state='budget_exhausted',code='DAILY_CALL_LIMIT',lease_until=NULL,available_at=(date_trunc('day',clock_timestamp() AT TIME ZONE 'UTC')+interval '1 day') AT TIME ZONE 'UTC' WHERE "+fence,key(job));return null;}
    }
    for(const [scope,owner] of [["global",""],["owner",job.owner_id]])await db.query("UPDATE processing_budget SET reserved_calls=reserved_calls+1 WHERE installation_id=$1 AND branch=$2 AND budget_day=(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date AND scope=$3 AND owner_key=$4",[installation,branch,scope,owner]);
    await db.query("UPDATE processing_control SET derivative_bytes=derivative_bytes+$2 WHERE installation_id=$1",[installation,bytes]);
    const id=randomUUID(),bodyHash=createHash("sha256").update(canonical(body)).digest("hex");
    const r=await db.query("INSERT INTO processing_attempt(id,job_id,installation_id,owner_id,business_attempt_id,unit,operation_id,body,body_hash,input_hash,deadline_at,model_id,model_revision,profile_id,question_version,projection_version,metadata,phase) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'dispatching') RETURNING *",[id,job.id,installation,job.owner_id,job.business_attempt_id,unit,body.operationId,body,bodyHash,job.input_hash,body.deadlineAt,metadata.model_id,metadata.model_revision,metadata.profile_id,metadata.question_version,PROJECTION_VERSION,metadata]);
    await db.query("UPDATE processing_job SET technical_attempts=technical_attempts+1 WHERE "+fence,key(job));
    job.technical_attempts++;return attemptRow(r.rows[0]);
   });
  },
  async finishAttempt(job:ProcessingJob,attempt:Attempt,phase:Attempt["phase"],result?:unknown){
   return tx(async db=>{
    if(!await locked(db,job))return false;
    return !!(await db.query("UPDATE processing_attempt SET phase=$2,result=$3,finished_at=clock_timestamp() WHERE id=$1 AND job_id=$4 AND business_attempt_id=$5 AND phase='dispatching'",[attempt.id,phase,result??null,job.id,job.business_attempt_id])).rowCount;
   });
  },
  async finishJob(job:ProcessingJob,state:JobState,code?:string,delay=0){
   return !!(await pool.query("UPDATE processing_job SET state=$7,code=$8,lease_until=NULL,available_at=clock_timestamp()+($9::int*interval '1 millisecond'),updated_at=clock_timestamp() WHERE "+fence,[...key(job),state,safeCode(code),Math.min(60000,Math.max(0,delay))])).rowCount;
  },
  async chunkExists(job:ProcessingJob,index:number,hash:string){
   return !!(await pool.query("SELECT 1 FROM embedding_chunk WHERE installation_id=$1 AND owner_id=$2 AND report_id=$3 AND generation=$4 AND chunk_index=$5 AND chunk_hash=$6 AND input_hash=$7 AND model_id=$8 AND model_revision=$9 AND profile_id=$10 AND purpose='symmetric'",[installation,job.owner_id,job.report_id,job.index_generation,index,hash,job.input_hash,EMBEDDING_MODEL.modelId,EMBEDDING_MODEL.revision,EMBEDDING_MODEL.profileId])).rowCount;
  },
  async saveChunk(job:ProcessingJob,attempt:Attempt,chunk:{index:number;start:number;end:number;hash:string},vector:number[],coverage:string){
   validateEmbedding(vector);
   return tx(async db=>{
    if(!await locked(db,job))return false;
    const intent=await db.query("SELECT 1 FROM processing_attempt WHERE id=$1 AND job_id=$2 AND business_attempt_id=$3 AND phase='dispatching' FOR UPDATE",[attempt.id,job.id,job.business_attempt_id]);if(!intent.rowCount)return false;
    await db.query("INSERT INTO embedding_chunk(installation_id,owner_id,report_id,case_id,generation,projection_version,input_hash,chunk_index,start_offset,end_offset,chunk_hash,model_id,model_revision,profile_id,purpose,embedding,norm,coverage,attempt_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'symmetric',$15::vector,$16,$17,$18) ON CONFLICT DO NOTHING",[installation,job.owner_id,job.report_id,job.case_id,job.index_generation,PROJECTION_VERSION,job.input_hash,chunk.index,chunk.start,chunk.end,chunk.hash,EMBEDDING_MODEL.modelId,EMBEDDING_MODEL.revision,EMBEDDING_MODEL.profileId,JSON.stringify(vector),Math.hypot(...vector),coverage,attempt.id]);
    await db.query("UPDATE processing_attempt SET phase='succeeded',result=$2,finished_at=clock_timestamp() WHERE id=$1",[attempt.id,{chunk_index:chunk.index,chunk_hash:chunk.hash}]);
    await db.query("UPDATE processing_job SET coverage=$7 WHERE "+fence,[...key(job),coverage]);return true;
   });
  },
  async saveClassification(job:ProcessingJob,attempt:Attempt,payload:Record<string,unknown>,policyVersion:string){
   if(Buffer.byteLength(JSON.stringify(payload))>16384)throw new Error("CLASSIFICATION_RESULT_LIMIT");
   return tx(async db=>{
    if(!await locked(db,job))return false;
    const intent=await db.query("SELECT 1 FROM processing_attempt WHERE id=$1 AND job_id=$2 AND business_attempt_id=$3 AND phase='dispatching' FOR UPDATE",[attempt.id,job.id,job.business_attempt_id]);if(!intent.rowCount)return false;
    await db.query("INSERT INTO classification(id,installation_id,owner_id,report_id,case_id,generation,input_hash,model_id,model_revision,profile_id,question_version,projection_version,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8,'typesafe',$9,$10,$11) ON CONFLICT DO NOTHING",[randomUUID(),installation,job.owner_id,job.report_id,job.case_id,QUESTION_VERSION+':'+job.business_attempt_id,job.input_hash,"jev-1.13.0",QUESTION_VERSION,PROJECTION_VERSION,payload]);
    await db.query("UPDATE processing_attempt SET phase='succeeded',result=$2,usage=$3,finished_at=clock_timestamp() WHERE id=$1",[attempt.id,payload,payload.usage??null]);
    await db.query("UPDATE processing_job SET coverage='partial' WHERE "+fence,key(job));return true;
   });
  },
  async propose(job:ProcessingJob,coverage:string){
   return tx(async db=>{
    if(!await locked(db,job))return false;
    if(!(await db.query("SELECT 1 FROM report_signature WHERE installation_id=$1 AND owner_id=$2 AND report_id=$3 AND algorithm_version=$4",[installation,job.owner_id,job.report_id,PROJECTION_VERSION])).rowCount)return false;
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,31))",[installation+":"+job.owner_id+":"+job.case_id+":"+job.index_generation]);
    const pairs=await db.query("WITH scoped AS MATERIALIZED(SELECT e.case_id,e.report_id,e.embedding,e.coverage,rs.canonical FROM embedding_chunk e JOIN report_signature rs ON rs.report_id=e.report_id AND rs.owner_id=e.owner_id AND rs.installation_id=e.installation_id AND rs.algorithm_version=$8 WHERE e.installation_id=$1 AND e.owner_id=$2 AND e.generation=$3 AND e.model_id=$4 AND e.model_revision=$5 AND e.profile_id=$6 AND e.purpose='symmetric'),scores AS(SELECT b.case_id,max(1-(a.embedding <=> b.embedding)) AS score,bool_and(a.coverage='complete' AND b.coverage='complete') AS complete FROM scoped a JOIN scoped b ON a.case_id<>b.case_id WHERE a.case_id=$7 AND (a.canonical IS NULL OR b.canonical IS NULL OR a.canonical<>b.canonical) AND NOT EXISTS(SELECT 1 FROM group_membership am JOIN group_membership bm ON bm.group_id=am.group_id AND bm.installation_id=am.installation_id AND bm.owner_id=am.owner_id WHERE am.installation_id=$1 AND am.owner_id=$2 AND am.case_id=a.case_id AND bm.case_id=b.case_id) GROUP BY b.case_id) SELECT * FROM scores WHERE score>=0.90 ORDER BY score DESC,case_id LIMIT 20",[installation,job.owner_id,job.index_generation,EMBEDDING_MODEL.modelId,EMBEDDING_MODEL.revision,EMBEDDING_MODEL.profileId,job.case_id,PROJECTION_VERSION]);
    const count=Number((await db.query("SELECT count(*)::int AS n FROM similarity_proposal WHERE installation_id=$1 AND owner_id=$2 AND case_id=$3 AND generation=$4 AND state='pending'",[installation,job.owner_id,job.case_id,job.index_generation])).rows[0].n);
    let remaining=20-count;
    for(const row of pairs.rows){
     if(remaining<=0)break;
     const exists=await db.query("SELECT 1 FROM similarity_proposal WHERE installation_id=$1 AND owner_id=$2 AND case_id=$3 AND candidate_case_id=$4 AND generation=$5",[installation,job.owner_id,job.case_id,row.case_id,job.index_generation]);if(exists.rowCount)continue;
     await db.query("INSERT INTO similarity_proposal(id,installation_id,owner_id,case_id,candidate_case_id,generation,method,score,coverage) VALUES($1,$2,$3,$4,$5,$6,'embedding_max_chunk',$7,$8) ON CONFLICT DO NOTHING",[randomUUID(),installation,job.owner_id,job.case_id,row.case_id,job.index_generation,row.score,row.complete&&coverage==="complete"?"complete":"partial"]);remaining--;
    }
    return true;
   });
  },
  async enrichmentModel(p:Principal,caseId:string){
   return tx(async db=>{const row=await lookup(db,p,caseId);
    const branches=await db.query("SELECT "+columns+" FROM processing_job WHERE installation_id=$1 AND owner_id=$2 AND case_id=$3 AND pipeline_version=$4 AND (branch<>\'embedding\' OR index_generation=$5) ORDER BY branch",[installation,row.owner_id,caseId,PIPELINE_VERSION,target()]);
    const classifications=await db.query("SELECT "+resultColumns+" FROM classification WHERE installation_id=$1 AND owner_id=$2 AND case_id=$3 ORDER BY registered_at DESC,id DESC LIMIT 20",[installation,row.owner_id,caseId]);
    return {branches:branches.rows,classifications:classifications.rows.map(row=>({...row,registered_at:new Date(row.registered_at).toISOString()}))};
   });
  },
  async similar(p:Principal,input:SimilarInput){
   return tx(async db=>{
    await db.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    const row=await lookup(db,p,input.case_id);
    const meta=await readGeneration(db);const generation=meta.generation;
    const source=await db.query("SELECT bool_and(j.state='succeeded' AND j.coverage='complete' AND EXISTS(SELECT 1 FROM embedding_chunk e WHERE e.installation_id=r.installation_id AND e.owner_id=r.owner_id AND e.report_id=r.id AND e.generation=$4 AND e.model_id=$5 AND e.model_revision=$6 AND e.profile_id=$8 AND e.projection_version=$9 AND e.purpose=$10 AND e.input_hash=j.input_hash AND e.coverage='complete')) AS complete,bool_or(EXISTS(SELECT 1 FROM embedding_chunk e WHERE e.installation_id=r.installation_id AND e.owner_id=r.owner_id AND e.report_id=r.id AND e.generation=$4 AND e.model_id=$5 AND e.model_revision=$6 AND e.profile_id=$8 AND e.projection_version=$9 AND e.purpose=$10)) AS any_chunks FROM report r LEFT JOIN processing_job j ON j.report_id=r.id AND j.installation_id=r.installation_id AND j.owner_id=r.owner_id AND j.branch='embedding' AND j.pipeline_version=$7 AND j.index_generation=$4 WHERE r.installation_id=$1 AND r.owner_id=$2 AND r.case_id=$3",[installation,row.owner_id,input.case_id,generation,meta.model_id,meta.model_revision,meta.pipeline_version,meta.profile_id,meta.projection_version,meta.purpose]);
    if(!source.rows[0].any_chunks)throw new SystemFault("INDEX_NOT_READY");
    const sourceComplete=source.rows[0].complete===true;
    const binding=createHash("sha256").update(canonical({installation,owner:row.owner_id,viewer:p.ownerId,reviewer:p.reviewer,case:input.case_id,filters:input.filters??{}})).digest("hex");
    // AIDEV-NOTE: Новая часть может изменить score уже существующего кандидата; такой курсор нужно перезапустить.
    const epoch=(await db.query("SELECT count(*)::text||':'||coalesce(max(registered_at)::text,'') AS value FROM embedding_chunk WHERE installation_id=$1 AND owner_id=$2 AND generation=$3 AND model_id=$4 AND model_revision=$5 AND profile_id=$6 AND purpose='symmetric'",[installation,row.owner_id,generation,meta.model_id,meta.model_revision,meta.profile_id])).rows[0].value;
    let cursor:{score:number;id:string}|null=null;
    if(input.cursor){
     try{
      if(input.cursor.length>4096)throw 0;
      const parts=input.cursor.split(".");if(parts.length!==2)throw 0;
      const signature=createHmac("sha256",options.cursorKey).update(parts[0]).digest();
      const supplied=Buffer.from(parts[1],"base64url");
      if(supplied.length!==signature.length||!timingSafeEqual(signature,supplied))throw 0;
      const decoded=JSON.parse(Buffer.from(parts[0],"base64url").toString("utf8"));
      if(decoded.binding!==binding)throw 0;
      if(decoded.generation!==generation||decoded.activation_revision!==meta.activation_revision||decoded.epoch!==epoch)throw new SystemFault("CURSOR_STALE");
      if(typeof decoded.score!=="number"||!Number.isFinite(decoded.score)||decoded.score < -1||decoded.score>1||typeof decoded.id!=="string"||!/^[0-9a-f-]{36}$/i.test(decoded.id))throw 0;
      cursor=decoded;
     }catch(error){if(error instanceof SystemFault)throw error;throw new Fault("INVALID_ARGUMENT");}
    }
    const values:unknown[]=[installation,row.owner_id,generation,meta.model_id,meta.model_revision,meta.profile_id,input.case_id];
    let filter="";
    for(const [name,value] of Object.entries(input.filters??{})){
     values.push(value);const n="$"+values.length;
     const fields:Record<string,string>={review_state:"c.review_state=",component_id:"c.component_id=",source:"c.source=",error_code:"r.observation->>'error_code'=",registered_from:"c.registered_at>=",registered_to:"c.registered_at<="};
     if(!fields[name])throw new Fault("INVALID_ARGUMENT");filter+=" AND "+fields[name]+n;
    }
    const scopedReports="SELECT c.id AS case_id,r.id AS report_id,g.group_id FROM bug_case c JOIN report r ON r.case_id=c.id AND r.owner_id=c.owner_id AND r.installation_id=c.installation_id LEFT JOIN group_membership g ON g.case_id=c.id AND g.owner_id=c.owner_id AND g.installation_id=c.installation_id WHERE c.installation_id=$1 AND c.owner_id=$2"+filter;
    const coverage=await db.query("WITH ignored AS(SELECT $4::text,$5::text,$6::text,$7::uuid),reports AS("+scopedReports+") SELECT count(*)::int AS total_reports,count(*) FILTER(WHERE j.state='succeeded' AND j.coverage='complete' AND EXISTS(SELECT 1 FROM embedding_chunk e WHERE e.report_id=reports.report_id AND e.owner_id=$2 AND e.installation_id=$1 AND e.generation=$3 AND e.model_id=$4 AND e.model_revision=$5 AND e.profile_id=$6 AND e.purpose=(SELECT metadata->>'purpose' FROM embedding_generation WHERE installation_id=$1 AND generation=$3) AND e.projection_version=(SELECT metadata->>'projection_version' FROM embedding_generation WHERE installation_id=$1 AND generation=$3) AND e.input_hash=j.input_hash AND e.coverage='complete'))::int AS indexed_reports,count(*) FILTER(WHERE EXISTS(SELECT 1 FROM embedding_chunk e WHERE e.report_id=reports.report_id AND e.owner_id=$2 AND e.installation_id=$1 AND e.generation=$3 AND e.model_id=$4 AND e.model_revision=$5 AND e.profile_id=$6 AND e.purpose=(SELECT metadata->>'purpose' FROM embedding_generation WHERE installation_id=$1 AND generation=$3)))::int AS any_reports FROM reports LEFT JOIN processing_job j ON j.report_id=reports.report_id AND j.installation_id=$1 AND j.owner_id=$2 AND j.branch='embedding' AND j.index_generation=$3 AND j.pipeline_version=(SELECT metadata->>'pipeline_version' FROM embedding_generation WHERE installation_id=$1 AND generation=$3)",values);
    const total=coverage.rows[0];
    const limit=Math.min(50,Math.max(1,input.limit??20)),sqlValues=[...values,cursor?.score??null,cursor?.id??null,limit+1];
    const scoreParam="$"+(values.length+1),idParam="$"+(values.length+2),limitParam="$"+(values.length+3);
    const pairs=await db.query("WITH scoped AS MATERIALIZED(SELECT case_id,embedding FROM embedding_chunk WHERE installation_id=$1 AND owner_id=$2 AND generation=$3 AND model_id=$4 AND model_revision=$5 AND profile_id=$6 AND purpose='symmetric'),scores AS(SELECT b.case_id,max(1-(a.embedding <=> b.embedding)) AS score FROM scoped a JOIN scoped b ON a.case_id<>b.case_id WHERE a.case_id=$7 GROUP BY b.case_id),reports AS("+scopedReports+") SELECT s.case_id,r.report_id,r.group_id,s.score,'cosine'::text AS method FROM scores s JOIN reports r ON r.case_id=s.case_id WHERE ("+scoreParam+"::float8 IS NULL OR s.score<"+scoreParam+" OR (s.score="+scoreParam+" AND s.case_id>"+idParam+"::uuid)) ORDER BY s.score DESC,s.case_id LIMIT "+limitParam,sqlValues);
    const items=pairs.rows.slice(0,limit),last=items.at(-1),has_more=pairs.rows.length>limit;
    let next_cursor=null;
    if(has_more&&last){const body=Buffer.from(JSON.stringify({generation,activation_revision:meta.activation_revision,epoch,binding,score:last.score,id:last.case_id})).toString("base64url");next_cursor=body+"."+createHmac("sha256",options.cursorKey).update(body).digest("base64url");}
    return {items,has_more,next_cursor,generation:generation,coverage:{total_reports:total.total_reports,indexed_reports:total.indexed_reports,state:sourceComplete&&total.indexed_reports===total.total_reports?"complete":total.any_reports>0||!sourceComplete?"partial":"pending",projection_version:meta.projection_version}};
   });
  },
  async processingStatus(p:Principal){
   return tx(async db=>{
    const build=target();const ctlGeneration=await prepareGenerations(db,installation,build);
    const rows=await db.query("SELECT state,branch,count(*)::int AS count FROM processing_job WHERE installation_id=$1 AND (owner_id=$2 OR $3::boolean) GROUP BY state,branch ORDER BY branch,state",[installation,p.ownerId,p.reviewer]);
    const ctl=await db.query("SELECT paused,derivative_bytes FROM processing_control WHERE installation_id=$1",[installation]);
    const budgets=await db.query("SELECT branch,scope,reserved_calls FROM processing_budget WHERE installation_id=$1 AND budget_day=(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date AND ((scope='owner' AND owner_key=$2) OR ($3::boolean AND scope='global'))",[installation,p.ownerId,p.reviewer]);
    const owner=p.reviewer?undefined:p.ownerId;
    const activeCoverage=await generationCoverage(db,ctlGeneration.active_generation,owner);
    const buildCoverage=build===ctlGeneration.active_generation?activeCoverage:await generationCoverage(db,build,owner);
    return {paused:ctl.rows[0]?.paused??false,jobs:rows.rows,budgets:budgets.rows,generations:{active:ctlGeneration.active_generation,build,activation_revision:ctlGeneration.activation_revision,active_coverage:activeCoverage,build_coverage:buildCoverage},...(p.reviewer?{derivative_bytes:await derivativeBytes(db),limits:currentPolicy()}:{})};
   });
  },
  async activateGeneration(p:Principal,input:ActivateGenerationInput){
   if(!p.reviewer)throw new Fault("FORBIDDEN");
   if(Object.keys(input).sort().join(",")!=="expected_active_generation,generation,reason,request_id"||!generationPattern.test(input.generation)||!generationPattern.test(input.expected_active_generation)||typeof input.reason!=="string"||!input.reason.trim()||input.reason.length>2048)throw new Fault("INVALID_ARGUMENT");
   return operatorMutation(p,"processing-activate-generation",input,async db=>{
    const state=await prepareGenerations(db,installation,target());
    if(state.active_generation!==input.expected_active_generation)throw new Fault("REVISION_CONFLICT");
    const coverage=await generationCoverage(db,input.generation);
    if(coverage.indexed_reports!==coverage.total_reports)throw new SystemFault("INDEX_NOT_READY");
    const revision=state.activation_revision+1;
    await db.query("UPDATE embedding_generation_control SET active_generation=$2,activation_revision=$3,updated_at=clock_timestamp() WHERE installation_id=$1",[installation,input.generation,revision]);
    await db.query("INSERT INTO embedding_generation_activation(id,installation_id,generation,previous_generation,activation_revision,actor_id,reason,total_reports,indexed_reports) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",[randomUUID(),installation,input.generation,state.active_generation,revision,p.actorId,input.reason,coverage.total_reports,coverage.indexed_reports]);
    return {generation:input.generation,previous_generation:state.active_generation,activation_revision:revision,total_reports:coverage.total_reports,indexed_reports:coverage.indexed_reports};
   });
  },
  async pause(p:Principal,input:{request_id:string;paused:boolean;reason:string}){
   if(!p.reviewer)throw new Fault("FORBIDDEN");
   if(typeof input.paused!=="boolean"||!input.reason.trim()||input.reason.length>2048)throw new Fault("INVALID_ARGUMENT");
   return operatorMutation(p,"processing-pause",input,async db=>{await control(db);await db.query("UPDATE processing_control SET paused=$2,actor_id=$3,reason=$4,updated_at=clock_timestamp() WHERE installation_id=$1",[installation,input.paused,p.actorId,input.reason]);return {paused:input.paused};});
  },
  async retryUnknown(p:Principal,input:{request_id:string;job_id:string;business_attempt_id:string;reason:string}){
   if(!p.reviewer)throw new Fault("FORBIDDEN");
   if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.business_attempt_id)||!input.reason.trim()||input.reason.length>2048)throw new Fault("INVALID_ARGUMENT");
   return operatorMutation(p,"processing-retry",input,async db=>{
    const rows=await db.query("SELECT * FROM processing_job WHERE id=$1 AND installation_id=$2 FOR UPDATE",[input.job_id,installation]);if(!rows.rowCount)throw new Fault("NOT_FOUND");const j=rows.rows[0];
    if(j.business_attempt_id===input.business_attempt_id||!["outcome_unknown","failed","blocked_policy","input_too_large","budget_exhausted"].includes(j.state))throw new Fault("REVISION_CONFLICT");
    const old=await db.query("SELECT 1 FROM processing_operator_action WHERE job_id=$1 AND business_attempt_id=$2",[j.id,input.business_attempt_id]);if(old.rowCount)throw new Fault("IDEMPOTENCY_CONFLICT");
    await db.query("INSERT INTO processing_operator_action(id,installation_id,owner_id,job_id,business_attempt_id,actor_id,reason) VALUES($1,$2,$3,$4,$5,$6,$7)",[randomUUID(),installation,j.owner_id,j.id,input.business_attempt_id,p.actorId,input.reason]);
    await db.query("UPDATE processing_job SET state='pending',fence=fence+1,lease_until=NULL,available_at=clock_timestamp(),technical_attempts=0,business_attempt_id=$2,retry_reason=$3,code=NULL,updated_at=clock_timestamp() WHERE id=$1",[j.id,input.business_attempt_id,input.reason]);return {job_id:j.id,business_attempt_id:input.business_attempt_id,state:"pending"};
   });
  },
 };
 return api;
}
