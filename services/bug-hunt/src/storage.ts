// ABOUTME: Хранит наблюдения, квитанции и аудит в собственной PostgreSQL БД.
// ABOUTME: Транзакционные блокировки сохраняют атомарность повторов и конкурентного разбора.
import {createHash,createHmac,randomUUID,timingSafeEqual} from "node:crypto";
import type {Pool,PoolClient} from "pg";
import {Fault,canonical,type Principal,type ReportInput,type ReviewInput,type GetInput,type ListInput} from "./contracts.js";
import {enqueueProcessing} from "./processing-store.js";
import {assertReviewTransition,type Store} from "./domain.js";

interface Options {targetGeneration?:()=>string;installationId:string;cursorKey:string;maxReports:number;reportsPerMinute:number;deadlineAt?:number;maxDatabaseBytes?:number}
interface Cursor {at:string;id:string;binding:string}
const digest=(value:unknown)=>createHash("sha256").update(canonical(value)).digest("hex");
const columns="id,owner_id,installation_id,title,component_id,source,review_state,verification_status,revision,registered_at,updated_at";
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
export function createStore(pool:Pool,options:Options):Store {
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
 async function mutation(p:Principal,operation:string,input:ReportInput|ReviewInput,work:(db:PoolClient)=>Promise<Record<string,unknown>>) {
  const hash=digest(input);
  return transaction(async db=>{
   // AIDEV-NOTE: Стабильный initiator, а не connection/token, определяет ключ повтора.
   const key=[installationId,p.ownerId,p.actorId,operation,input.request_id];
   await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[JSON.stringify(key)]);
   const previous=await db.query("SELECT input_hash,result FROM mutation WHERE installation_id=$1 AND owner_id=$2 AND actor_id=$3 AND operation=$4 AND request_id=$5",key);
   if(previous.rowCount){
    if(previous.rows[0].input_hash!==hash)throw new Fault("IDEMPOTENCY_CONFLICT");
    return {...previous.rows[0].result,replayed:true};
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
 return {
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
  async get(p,input){
   return transaction(async db=>{
    const row=await lookup(db,p,input.case_id);
    const report=await db.query("SELECT id,actor_id,observation,registered_at FROM report WHERE case_id=$1 AND owner_id=$2 AND installation_id=$3 ORDER BY registered_at,id LIMIT 1",[row.id,row.owner_id,installationId]);
    const binding=digest({owner:p.ownerId,reviewer:p.reviewer,case_id:input.case_id,kind:"review"});
    const cursor=cursors.decode(input.cursor,binding),limit=input.limit??20;
    const reviews=await db.query("SELECT id,actor_id,explanation,old_state,new_state,old_revision,new_revision,registered_at FROM review WHERE case_id=$1 AND installation_id=$2 AND ($3::timestamptz IS NULL OR (registered_at,id)<($3::timestamptz,$4::uuid)) ORDER BY registered_at DESC,id DESC LIMIT $5",[row.id,installationId,cursor?.at??null,cursor?.id??null,limit+1]);
    const items=reviews.rows.slice(0,limit).map(dates),last=items.at(-1);
    return {case:dates(row),report:dates(report.rows[0]),reviews:{items,next_cursor:reviews.rows.length>limit&&last?cursors.encode({at:last.registered_at,id:last.id,binding}):null}};
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
 };
}
