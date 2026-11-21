// ABOUTME: Хранит наблюдения, квитанции и аудит в собственной PostgreSQL БД.
// ABOUTME: Транзакционные блокировки сохраняют атомарность повторов и конкурентного разбора.
import {createHash,createHmac,randomUUID,timingSafeEqual} from "node:crypto";
import type {Pool,PoolClient} from "pg";
import {Fault,canonical,type Principal,type Observation,type ReportInput,type GetInput,type ListInput} from "./contracts.js";
import {enqueueProcessing} from "./processing-store.js";
import {assertReviewTransition,type Store} from "./domain.js";
import {exactSignature,prepareExternalProjection} from "./projection.js";
import {validateInvestigation,type Claim,type Complete,type Fail} from "./investigation-contract.js";

interface Options {targetGeneration?:()=>string;installationId:string;cursorKey:string;maxReports:number;reportsPerMinute:number;deadlineAt?:number;maxDatabaseBytes?:number}
interface Cursor {at:string;id:string;binding:string}
const digest=(value:unknown)=>createHash("sha256").update(canonical(value)).digest("hex");
const columns="id,owner_id,installation_id,title,component_id,source,review_state,verification_status,revision,registered_at,updated_at";
// AIDEV-NOTE: Отдельные операции в существующем append-only журнале сохраняют
// диагностику без DDL. Изменения сериализует тот же transaction lock, что и квитанции.
const diagnosticRows=`WITH diagnostics AS (
 SELECT job.request_id::uuid AS id, job.actor_id, job.owner_id,
        (job.result->>'case_id')::uuid AS case_id,
        (job.result->>'case_revision')::int AS case_revision,
        (job.result->>'at')::timestamptz AS created_at,
        COALESCE(done.result->>'state','running') AS state,
        done.result->'result' AS result, (done.result->>'at')::timestamptz AS finished_at,
        done.result->>'signature_hash' AS signature_hash, done.result->>'signature_canonical' AS signature_canonical
 FROM verification_mutation job LEFT JOIN verification_mutation done
   ON (done.installation_id,done.owner_id,done.actor_id,done.request_id) =
      (job.installation_id,job.owner_id,job.actor_id,job.request_id)
   AND done.operation='diagnostic-result'
 WHERE job.installation_id=$1 AND ($2::text IS NULL OR job.owner_id=$2) AND job.operation='diagnostic-job'
)`;
function dates(row:Record<string,any>):Record<string,any> {
 return Object.fromEntries(Object.entries(row).map(([k,v])=>[k,v instanceof Date?v.toISOString():v]));
}
function cursorCodec(key:string) {
 const sign=(raw:string)=>createHmac("sha256",key).update(raw).digest("base64url");
 return {
  encode(value:Cursor){const raw=Buffer.from(JSON.stringify(value)).toString("base64url");return raw+"."+sign(raw);},
  decode(raw:string|undefined,binding:string):Cursor|null {
   if(!raw)return null;
   try {const [body,mac,...extra]=raw.split(".");const a=Buffer.from(mac),b=Buffer.from(sign(body));
    if(extra.length||a.length!==b.length||!timingSafeEqual(a,b))throw 0;
    const value=JSON.parse(Buffer.from(body,"base64url").toString("utf8"));
    if(value.binding!==binding||typeof value.at!=="string"||!Number.isFinite(Date.parse(value.at))||!/^[0-9a-f-]{36}$/.test(value.id))throw 0;
    return value;
   }catch{throw new Fault("INVALID_ARGUMENT");}
  },
 };
}
/** Создаёт PostgreSQL-порт. Runtime не выполняет DDL и не удаляет исходные записи. */
export function createStore(pool:Pool,options:Options) {
 const {installationId,cursorKey}=options;
 const cursors=cursorCodec(cursorKey);
 async function transaction<T>(work:(db:PoolClient)=>Promise<T>,readOnly=false):Promise<T> {
  if(options.deadlineAt!==undefined&&Date.now()>=options.deadlineAt)throw new Fault("DEADLINE_EXCEEDED");
  let db:PoolClient;try{db=await pool.connect();}catch{throw new Fault("DATABASE_UNAVAILABLE");}
  let committing=false;
  try {
   await db.query(readOnly?"BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY":"BEGIN");
   await db.query("SET LOCAL statement_timeout = '7000ms'");
   await db.query("SET LOCAL lock_timeout = '5000ms'");
   const query=async(sql:string,values?:unknown[])=>{
    const remaining=options.deadlineAt===undefined?7000:Math.min(7000,options.deadlineAt-Date.now());
    if(remaining<=0)throw new Fault("DEADLINE_EXCEEDED");
    await db.query("SELECT set_config('statement_timeout',$1,true)",[String(remaining)]);
    return db.query(sql,values);
   };
   const value=await work({query} as PoolClient);
   if(options.deadlineAt!==undefined&&Date.now()>=options.deadlineAt)throw new Fault("DEADLINE_EXCEEDED");
   committing=true;
   await db.query("COMMIT");
   return value;
  }catch(error){
   let rolledBack=false;try{await db.query("ROLLBACK");rolledBack=true;}catch{}
   if(error instanceof Fault)throw error;
   throw new Fault("DATABASE_UNAVAILABLE",committing||!rolledBack?"unknown":"not_accepted");
  }finally{db.release();}
 }
 async function mutation<T extends Record<string,unknown>>(p:Principal,operation:string,input:{request_id:string},work:(db:PoolClient)=>Promise<T>) {
  const hash=digest(input);
  return transaction(async db=>{
   // AIDEV-NOTE: Стабильный initiator, а не connection/token, определяет ключ повтора.
   const key=[installationId,p.ownerId,p.actorId,operation,input.request_id];
   await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[JSON.stringify(key)]);
   const previous=await db.query("SELECT input_hash,result FROM mutation WHERE installation_id=$1 AND owner_id=$2 AND actor_id=$3 AND operation=$4 AND request_id=$5",key);
   if(previous.rowCount){
    if(previous.rows[0].input_hash!==hash)throw new Fault("IDEMPOTENCY_CONFLICT");
    return {...previous.rows[0].result as T,replayed:true};
   }
   await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",["bug-hunt-capacity:"+installationId]);
   const size=await db.query("SELECT pg_database_size(current_database()) AS bytes");
   if(Number(size.rows[0].bytes)>=(options.maxDatabaseBytes??1073741824))throw new Fault("BUSY");
   const result=await work(db);
   await db.query("INSERT INTO mutation(installation_id,owner_id,actor_id,operation,request_id,input_hash,result) VALUES($1,$2,$3,$4,$5,$6,$7)",[...key,hash,result]);
   return {...result,replayed:false};
  });
 }
 const lookup=async(db:PoolClient,p:Principal,id:string)=>{
  const found=await db.query("SELECT "+columns+" FROM bug_case WHERE installation_id=$1 AND id=$2 AND (owner_id=$3 OR $4::boolean)",[installationId,id,p.ownerId,p.reviewer]);
  if(!found.rowCount)throw new Fault("NOT_FOUND");
  return found.rows[0];
 };
 async function appendDiagnostic(db:PoolClient,p:Principal,operation:"diagnostic-job"|"diagnostic-result"|"diagnostic-dispatch",id:string,record:Record<string,unknown>) {
  await db.query(`INSERT INTO verification_mutation(installation_id,owner_id,actor_id,operation,request_id,input_hash,result)
    VALUES($1,$2,$3,$4,$5,$6,$7::jsonb || jsonb_build_object('at',clock_timestamp()))`,
   [installationId,p.ownerId,p.actorId,operation,id,digest(record),JSON.stringify(record)]);
 }
 async function investigation(db:PoolClient, row:Record<string,any>, observation:Observation) {
  const state = await db.query(`${diagnosticRows} SELECT id,case_id,state,result,finished_at FROM diagnostics
    WHERE case_id=$3 AND case_revision=$4
    ORDER BY created_at DESC,id DESC LIMIT 1`,[installationId,row.owner_id,row.id,row.revision]);
  const current = state.rows[0];
  if (current?.state === "completed") return {...dates(current),state:"processed",applicability:"investigated"};
  const processing = ["running","failed","outcome_unknown"].includes(current?.state) ? current.state : "pending";
  const signature = exactSignature(installationId,row.owner_id,observation);
  if (row.review_state === "archived") return {state:processing, applicability:"none"};
  const known = signature && await db.query(`${diagnosticRows} SELECT i.id,i.case_id,i.result,i.finished_at
    FROM diagnostics i JOIN bug_case c ON c.id=i.case_id AND c.revision=i.case_revision
    WHERE i.state='completed'
      AND i.signature_hash=$3 AND i.signature_canonical=$4 AND c.review_state <> 'archived'
    ORDER BY i.finished_at DESC,i.id DESC LIMIT 1`,[installationId,row.owner_id,signature.hash,signature.canonical]);
  if (known?.rowCount) return {state:processing,applicability:"exact",...dates(known.rows[0])};
  const similar = await db.query(`${diagnosticRows} SELECT i.case_id FROM group_membership own
    JOIN group_membership related ON (related.group_id,related.installation_id,related.owner_id)=(own.group_id,own.installation_id,own.owner_id)
    JOIN bug_case c ON c.id=related.case_id AND c.review_state <> 'archived'
    JOIN diagnostics i ON i.case_id=c.id AND i.case_revision=c.revision AND i.state='completed'
    WHERE own.installation_id=$1 AND own.owner_id=$2 AND own.case_id=$3 AND related.case_id<>own.case_id
    ORDER BY i.finished_at DESC,i.id DESC LIMIT 1`,[installationId,row.owner_id,row.id]);
  return similar.rowCount ? {state:processing,applicability:"similar",case_id:similar.rows[0].case_id} : {state:processing,applicability:"none"};
 }
 const store = {
  report(p,input,validateNew){
   return mutation(p,"report",input,async db=>{
    await validateNew();
    const supersedes=input.observation.supersedes_report_id;
    if(supersedes){
     const found=await db.query("SELECT 1 FROM report WHERE id=$1 AND owner_id=$2 AND installation_id=$3",[supersedes,p.ownerId,installationId]);
     if(!found.rowCount)throw new Fault("NOT_FOUND");
    }
    // Ограничение ёмкости и частоты согласовано между экземплярами под короткой блокировкой.
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",["bug-hunt-capacity:"+installationId]);
    const counts=await db.query("SELECT count(*)::int AS total,count(*) FILTER(WHERE actor_id=$2 AND registered_at>now()-interval '1 minute')::int AS recent FROM report WHERE installation_id=$1",[installationId,p.actorId]);
    if(counts.rows[0].total>=options.maxReports||counts.rows[0].recent>=options.reportsPerMinute)throw new Fault("BUSY");
    const caseId=randomUUID(),reportId=randomUUID(),registered=new Date().toISOString();
    await db.query("INSERT INTO bug_case(id,owner_id,installation_id,title,component_id,source,registered_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$7)",[caseId,p.ownerId,installationId,input.observation.title,input.observation.component_id??"unknown",p.source,registered]);
    await db.query("INSERT INTO report(id,case_id,owner_id,installation_id,actor_id,observation,registered_at) VALUES($1,$2,$3,$4,$5,$6,$7)",[reportId,caseId,p.ownerId,installationId,p.actorId,input.observation,registered]);
    await enqueueProcessing(db,{id:reportId,case_id:caseId,owner_id:p.ownerId,installation_id:installationId,observation:input.observation},"new",options.targetGeneration?.());
    return {request_id:input.request_id,report_id:reportId,case_id:caseId,registered_at:registered,review_state:"new",verification_status:"unverified"};
   });
  },
  review(p,input){
   return mutation(p,"review",input,async db=>{
    const row=await lookup(db,p,input.case_id);
    if(Number(row.revision)!==input.expected_revision)throw new Fault("REVISION_CONFLICT");
    assertReviewTransition(row.review_state,input.review_state);
    const changed=await db.query("UPDATE bug_case SET review_state=$1,revision=revision+1,updated_at=date_trunc('milliseconds',clock_timestamp()) WHERE id=$2 AND installation_id=$3 AND revision=$4 RETURNING revision,updated_at",[input.review_state,input.case_id,installationId,input.expected_revision]);
    if(!changed.rowCount)throw new Fault("REVISION_CONFLICT");
    const reviewId=randomUUID(),at=changed.rows[0].updated_at.toISOString();
    await db.query("INSERT INTO review(id,case_id,installation_id,owner_id,actor_id,explanation,old_state,new_state,old_revision,new_revision,registered_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",[reviewId,input.case_id,installationId,row.owner_id,p.actorId,input.explanation,row.review_state,input.review_state,input.expected_revision,input.expected_revision+1,at]);
    return {request_id:input.request_id,review_id:reviewId,case_id:input.case_id,revision:input.expected_revision+1,review_state:input.review_state,verification_status:"unverified",registered_at:at};
   });
  },
  async get(p,input,includeInvestigation=false){
   return transaction(async db=>{
    const row=await lookup(db,p,input.case_id);
    const report=await db.query("SELECT id,actor_id,observation,registered_at FROM report WHERE case_id=$1 AND owner_id=$2 AND installation_id=$3 ORDER BY registered_at,id LIMIT 1",[row.id,row.owner_id,installationId]);
    const binding=digest({owner:p.ownerId,reviewer:p.reviewer,case_id:input.case_id,kind:"review"});
    const cursor=cursors.decode(input.cursor,binding),limit=input.limit??20;
    const reviews=await db.query("SELECT id,actor_id,explanation,old_state,new_state,old_revision,new_revision,registered_at FROM review WHERE case_id=$1 AND installation_id=$2 AND ($3::timestamptz IS NULL OR (registered_at,id)<($3::timestamptz,$4::uuid)) ORDER BY registered_at DESC,id DESC LIMIT $5",[row.id,installationId,cursor?.at??null,cursor?.id??null,limit+1]);
    const items=reviews.rows.slice(0,limit).map(dates),last=items.at(-1);
    const result = {case:dates(row),report:dates(report.rows[0]),reviews:{items,next_cursor:reviews.rows.length>limit&&last?cursors.encode({at:last.registered_at,id:last.id,binding}):null}};
    return includeInvestigation ? {...result,investigation:await investigation(db,row,report.rows[0].observation)} : result;
   },true);
  },
  async list(p,input,operator){
   return transaction(async db=>{
    const filters=input.filters??{},limit=input.limit??20;
    const binding=digest({owner:p.ownerId,operator,filters,kind:"list"});
    const cursor=cursors.decode(input.cursor,binding);
    const values:unknown[]=[installationId,p.ownerId,operator,cursor?.at??null,cursor?.id??null];
    let where="installation_id=$1 AND (owner_id=$2 OR $3::boolean) AND ($4::timestamptz IS NULL OR (registered_at,id)<($4::timestamptz,$5::uuid))";
    const fields={review_state:"review_state",component_id:"component_id",source:"source",registered_from:"registered_at >=",registered_to:"registered_at <="};
    for(const [name,value] of Object.entries(filters)){
     values.push(value);
     const field=fields[name as keyof typeof fields];
     where+=" AND "+field+(name.startsWith("registered_")?" ":" = ")+"$"+values.length;
    }
    values.push(limit+1);
    const rows=await db.query("SELECT "+columns+" FROM bug_case WHERE "+where+" ORDER BY registered_at DESC,id DESC LIMIT $"+values.length,values);
    const items=rows.rows.slice(0,limit).map(dates),last=items.at(-1);
    return {items,next_cursor:rows.rows.length>limit&&last?cursors.encode({at:last.registered_at,id:last.id,binding}):null};
   },true);
  },
  async status(){
   try{
    const result=await pool.query("SELECT version,r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolreplication,r.rolbypassrls,current_user=(SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database()) AS is_owner  ,EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid) AS memberships FROM sys_schema JOIN pg_roles r ON r.rolname=current_user WHERE version=1");
    if(result.rowCount!==1||Object.entries(result.rows[0]).some(([k,v])=>k!=="version"&&v===true))throw 0;
    await pool.query("SELECT bug_case.id,report.observation,review.explanation,mutation.result FROM bug_case,report,review,mutation LIMIT 0");
    return {ready:true,schema_version:1};
   }catch{throw new Fault("DATABASE_UNAVAILABLE");}
  },
 } satisfies Store;
 async function finish(p:Principal,operation:"complete"|"fail",request:unknown) {
  validateInvestigation(operation,request);
  const input = request as Complete|Fail;
  return mutation(p,"diagnostic-"+operation,input,async db=>{
   const found = await db.query(`${diagnosticRows} SELECT i.*,c.revision,c.review_state,r.observation FROM diagnostics i
     JOIN bug_case c ON c.id=i.case_id AND c.owner_id=i.owner_id AND c.installation_id=$1
     JOIN LATERAL (
       SELECT observation FROM report r WHERE r.case_id=c.id AND r.owner_id=c.owner_id AND r.installation_id=c.installation_id
       ORDER BY r.registered_at,r.id LIMIT 1
     ) r ON true
     WHERE i.id=$3 AND i.actor_id=$4 FOR UPDATE OF c`,
    [installationId,p.installationInvestigator?null:p.ownerId,input.investigation_id,p.actorId]);
   if (!found.rowCount) throw new Fault("NOT_FOUND");
   const row = found.rows[0];
   if (row.state !== "running") throw new Fault("REVISION_CONFLICT");
   const result = "result" in input ? input.result : null;
   if (result && (row.case_revision !== row.revision || row.review_state === "archived")) throw new Fault("REVISION_CONFLICT");
   const claimedVersions = ["component_version","commit_sha","deployment_revision"] as const;
   const specified = claimedVersions.filter(key=>row.observation[key]?.trim() && row.observation[key].trim().toLowerCase() !== "unknown");
   const sameVersion = specified.length > 0 && specified.every(key=>row.observation[key] === result?.scope[key]);
   const state = result ? "completed" : "failed";
   const signature = sameVersion && result?.verdict !== "insufficient_evidence" ? exactSignature(installationId,row.owner_id,row.observation) : null;
   await appendDiagnostic(db,{...p,ownerId:row.owner_id},"diagnostic-result",row.id,{state,result,signature_hash:signature?.hash??null,signature_canonical:signature?.canonical??null});
   return {investigation_id:row.id,case_id:row.case_id,state};
  });
 }
 return {...store,
  async investigationForReport(p:Principal,caseId:string,input:ReportInput) {
   return transaction(async db=>investigation(db,await lookup(db,p,caseId),input.observation),true);
  },
  getWithInvestigation(p:Principal,input:GetInput) {return store.get(p,input,true);},
  /** Возвращает служебную страницу без заголовков, владельцев и исходных наблюдений. */
  async listInvestigationQueue(p:Principal,request:unknown) {
   if(!p.installationInvestigator)throw new Fault("FORBIDDEN");
   validateInvestigation("list",request);
   const {items,next_cursor}=await store.list(p,request as ListInput,true);
   return {items:items.map(({id,component_id,revision,review_state,registered_at})=>({
    id,component_id,revision,review_state,registered_at,
   })),next_cursor};
  },
  /** Читает только признаки для планирования. Проекция выдаётся после захвата карточки. */
  async readInvestigationCard(p:Principal,request:unknown) {
   if(!p.installationInvestigator)throw new Fault("FORBIDDEN");
   validateInvestigation("card",request);
   const {case_id}=request as Pick<GetInput,"case_id">;
   return transaction(async db=>{
    const row=await lookup(db,{...p,reviewer:true},case_id);
    const reports=await db.query("SELECT observation FROM report WHERE case_id=$1 AND owner_id=$2 AND installation_id=$3 ORDER BY registered_at,id LIMIT 1",
      [row.id,row.owner_id,installationId]);
    if(!reports.rowCount)throw new Fault("NOT_FOUND");
    const observation:Observation=reports.rows[0].observation;
    const {id,component_id,review_state,revision}=row;
    return {case:{id,component_id,review_state,revision},hints:{
     has_projection:!!prepareExternalProjection(observation,[row.owner_id]),
     signature:exactSignature(installationId,row.owner_id,observation)?.hash??null,
     client_occurred_at:observation.client_occurred_at??null,
     ...(/^[A-Z][A-Z0-9_:.\-]{2,95}$/.test(observation.error_code??"")?{error_code:observation.error_code}:{}),
     ...(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(observation.run_id??"")?{correlation_id:observation.run_id}:{}),
    },investigation:await investigation(db,row,observation)};
   },true);
  },
  /** Отмечает границу внешнего эффекта до запуска модели. */
  async markInvestigationDispatch(p:Principal,request:unknown) {
   if(!p.installationInvestigator)throw new Fault("FORBIDDEN");
   validateInvestigation("dispatch",request);
   const input=request as Fail;
   return mutation(p,"diagnostic-dispatch",input,async db=>{
    const job=await db.query(`${diagnosticRows} SELECT i.owner_id,i.state,c.revision,i.case_revision
      FROM diagnostics i JOIN bug_case c ON c.id=i.case_id AND c.owner_id=i.owner_id AND c.installation_id=$1
      WHERE i.id=$3 AND i.actor_id=$4 AND c.review_state<>'archived' FOR UPDATE OF c`,[installationId,null,input.investigation_id,p.actorId]);
    const row=job.rows[0];
    if(!row)throw new Fault("NOT_FOUND");
    if(row.state!=="running" || row.revision!==row.case_revision)throw new Fault("REVISION_CONFLICT");
    await appendDiagnostic(db,{...p,ownerId:row.owner_id},"diagnostic-dispatch",input.investigation_id,{state:"dispatching"});
    return {state:"dispatching"};
   });
  },
  /** Под блокировкой единственного обработчика закрывает его прерванные пакетные попытки. */
  async recoverInvestigationBatch(p:Principal,request:unknown) {
   if(!p.installationInvestigator)throw new Fault("FORBIDDEN");
   validateInvestigation("recover",request);
   const input=request as {request_id:string};
   return mutation(p,"diagnostic-recover",input,async db=>{
    // AIDEV-NOTE: Старые задания без batch_id требуют адресной проверки их владельцем.
    const recovered=await db.query(`INSERT INTO verification_mutation
      (installation_id,owner_id,actor_id,operation,request_id,input_hash,result)
      SELECT job.installation_id,job.owner_id,job.actor_id,'diagnostic-result',job.request_id,$3,
             jsonb_build_object('state',CASE WHEN dispatched.request_id IS NULL THEN 'failed' ELSE 'outcome_unknown' END,
               'result',NULL,'code',CASE WHEN dispatched.request_id IS NULL THEN 'BATCH_INTERRUPTED' ELSE 'BATCH_OUTCOME_UNKNOWN' END,
               'at',clock_timestamp())
      FROM verification_mutation job
      LEFT JOIN verification_mutation dispatched ON
        (dispatched.installation_id,dispatched.owner_id,dispatched.actor_id,dispatched.request_id)=
        (job.installation_id,job.owner_id,job.actor_id,job.request_id)
        AND dispatched.operation='diagnostic-dispatch'
      WHERE job.installation_id=$1 AND job.actor_id=$2 AND job.operation='diagnostic-job' AND job.result ? 'batch_id'
        AND NOT EXISTS (
          SELECT 1 FROM verification_mutation done WHERE
          (done.installation_id,done.owner_id,done.actor_id,done.request_id)=(job.installation_id,job.owner_id,job.actor_id,job.request_id)
          AND done.operation='diagnostic-result'
        )
      ON CONFLICT DO NOTHING RETURNING result->>'state' AS state`,[installationId,p.actorId,digest(input)]);
    return {recovered:recovered.rows.filter(row=>row.state==="failed").length,
     outcome_unknown:recovered.rows.filter(row=>row.state==="outcome_unknown").length};
   });
  },
  async claimInvestigation(p:Principal,request:unknown) {
   validateInvestigation("claim",request);
   const input = request as Claim;
   return mutation(p,"diagnostic-claim",input,async db=>{
    if (input.case_id) await lookup(db,{...p,reviewer:p.installationInvestigator===true},input.case_id);
    const selected = await db.query(`${diagnosticRows} SELECT c.id,c.owner_id,c.revision,r.observation,r.registered_at FROM bug_case c
      JOIN LATERAL (
       SELECT observation,registered_at FROM report r WHERE r.case_id=c.id AND r.owner_id=c.owner_id AND r.installation_id=c.installation_id
       ORDER BY r.registered_at,r.id LIMIT 1
      ) r ON true
      WHERE c.installation_id=$1 AND ($2::text IS NULL OR c.owner_id=$2) AND c.review_state <> 'archived'
        AND ($3::uuid IS NULL OR c.id=$3) AND ($4::text IS NULL OR c.component_id=$4)
        AND NOT EXISTS (SELECT 1 FROM diagnostics i WHERE i.case_id=c.id
          AND i.case_revision=c.revision AND i.state IN ('running','completed','outcome_unknown'))
      ORDER BY (SELECT max(i.finished_at) FROM diagnostics i WHERE i.case_id=c.id
        AND i.case_revision=c.revision AND i.state='failed') NULLS FIRST,
        c.registered_at,c.id LIMIT 1 FOR UPDATE OF c SKIP LOCKED`,[installationId,p.installationInvestigator?null:p.ownerId,input.case_id??null,input.component??null]);
    if (!selected.rowCount) return {state:"no_work"};
    const {id:caseId,owner_id:ownerId,revision,observation,registered_at} = selected.rows[0];
    const id=randomUUID();
    await appendDiagnostic(db,{...p,ownerId},"diagnostic-job",id,{
     case_id:caseId,case_revision:revision,...(input.batch_id?{batch_id:input.batch_id}:{}),
    });
    const projection = prepareExternalProjection(observation,[ownerId]);
    return {state:"running",investigation_id:id,case_id:caseId,case_revision:revision,component:observation.component_id??null,projection,registered_at};
   });
  },
  finishInvestigation:finish,
 };
}
