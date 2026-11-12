// ABOUTME: Хранит admission, snapshots, intents и неизменяемые выводы v3 в PostgreSQL.
// ABOUTME: Все связи ограничены установкой и владельцем; неизвестные эффекты не повторяются.
import {createHash,createHmac,randomUUID,timingSafeEqual} from "node:crypto";
import type {Pool,PoolClient} from "pg";
import {canonical,type Principal} from "./contracts.js";
import {VerificationFault as VF,type VerificationPolicy,type Snapshot,type Scope,type Evidence,type ModelCheckpoint} from "./verification.js";
export const verificationHash=(v:unknown)=>createHash("sha256").update(typeof v==="string"?v:canonical(v)).digest("hex");
type Row=Record<string,any>;
export interface Investigation extends Scope {id:string;code:string|null;revision:number;state:string;stage:string;fence:number;policy:VerificationPolicy;snapshot:Snapshot;snapshot_hash:string;config_hash:string;executor:string;model:any;cancel_requested:boolean;deadline_at:Date|null;active_ms:number;charge_active?:boolean;workflow_id:string;workflow_state:string;current_result_id:string|null;manual_revision:number}
interface Options {installationId:string;cursorKey:string;policy:()=>VerificationPolicy;maxDatabaseBytes:number}
const terminal=["completed","failed","cancelled"];
/** Создаёт порт предметной БД. Миграции и права остаются отдельной owner-программой. */
export function createVerificationStore(pool:Pool,options:Options){
 const installation=options.installationId;
 async function tx<T>(work:(db:PoolClient)=>Promise<T>):Promise<T>{
  const db=await pool.connect();let commit=false;
  try{await db.query("BEGIN");await db.query("SET LOCAL lock_timeout='2000ms'");const value=await work(db);commit=true;await db.query("COMMIT");return value;}
  catch(e){await db.query("ROLLBACK").catch(()=>{});if(e instanceof VF)throw e;throw new VF("DATABASE_UNAVAILABLE",commit?"unknown":"not_accepted");}finally{db.release();}
 }
 async function lock(db:PoolClient){await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,305))",[installation]);}
 async function capacity(db:PoolClient,p:VerificationPolicy){
  const bytes=(await db.query("SELECT pg_database_size(current_database())::float8 AS bytes")).rows[0].bytes;
  const derivative=(await db.query("SELECT coalesce(sum(pg_total_relation_size(oid)),0)::float8 AS bytes FROM pg_class WHERE relnamespace='public'::regnamespace AND relname LIKE 'verification_%' AND relkind='r'")).rows[0].bytes;
  if(bytes>options.maxDatabaseBytes-67108864||derivative>p.maxDerivativeBytes)throw new VF("BUSY");
 }
 async function mutation(p:Principal,op:string,input:Row,work:(db:PoolClient)=>Promise<Row>){
  return tx(async db=>{
   await lock(db);
   const keys=[installation,p.ownerId,p.actorId,op,input.request_id],hash=verificationHash(input);
   const old=(await db.query("SELECT input_hash,result FROM verification_mutation WHERE installation_id=$1 AND owner_id=$2 AND actor_id=$3 AND operation=$4 AND request_id=$5",keys)).rows[0];
   if(old){if(old.input_hash!==hash)throw new VF("IDEMPOTENCY_CONFLICT");return {...old.result,replayed:true};}
   await capacity(db,options.policy());
   const value={...await work(db),replayed:false};
   await db.query("INSERT INTO verification_mutation VALUES($1,$2,$3,$4,$5,$6,$7)",[...keys,hash,value]);return value;
  });
 }
 async function find(db:{query:PoolClient["query"]},p:Principal,id:string):Promise<Investigation>{
  const r=(await db.query("SELECT * FROM verification_investigation WHERE id=$1 AND installation_id=$2 AND owner_id=$3",[id,installation,p.ownerId])).rows[0];
  if(!r)throw new VF("NOT_FOUND");return r;
 }
 async function snapshot(db:PoolClient,owner:string,target:Row):Promise<Snapshot[]>{
  let group:null|{id:string;revision:number}=null,rows:Row[];
  if(target.kind==="group"){
   const g=(await db.query("SELECT id,revision FROM observation_group WHERE id=$1 AND installation_id=$2 AND owner_id=$3 FOR SHARE",[target.id,installation,owner])).rows[0];
   if(!g)throw new VF("NOT_FOUND");group=g;
   rows=(await db.query("SELECT r.id AS report_id,r.case_id,r.observation FROM report r JOIN group_membership m ON m.case_id=r.case_id AND m.installation_id=r.installation_id AND m.owner_id=r.owner_id WHERE m.group_id=$1 AND r.installation_id=$2 AND r.owner_id=$3 ORDER BY r.id LIMIT 51",[target.id,installation,owner])).rows;
   if(rows.length>50)throw new VF("SNAPSHOT_TOO_LARGE");
  }else{
   rows=(await db.query("SELECT r.id AS report_id,r.case_id,r.observation FROM report r JOIN bug_case c ON c.id=r.case_id WHERE r.installation_id=$1 AND r.owner_id=$2 AND ($3::uuid IS NULL OR r.case_id=$3) AND c.review_state<>'archived' AND ($3::uuid IS NOT NULL OR NOT EXISTS(SELECT 1 FROM verification_investigation vi WHERE vi.installation_id=r.installation_id AND vi.owner_id=r.owner_id AND vi.snapshot->'cases' @> jsonb_build_array(jsonb_build_object('case_id',r.case_id::text)))) ORDER BY r.registered_at,r.id LIMIT 50",[installation,owner,target.kind==="case"?target.id:null])).rows;
   if(target.kind==="case"&&!rows.length)throw new VF("NOT_FOUND");
  }
  const make=(rs:Row[]):Snapshot=>{
   const cases=rs.map(r=>({case_id:r.case_id,report_id:r.report_id,input_hash:verificationHash(r.observation),observation:r.observation}));
   const commits=[...new Set(rs.map(r=>r.observation.commit_sha).filter(v=>typeof v==="string"&&/^[a-f0-9]{40}$/.test(v)))];
   const components=[...new Set(rs.map(r=>r.observation.component_id))];
   if(Buffer.byteLength(JSON.stringify({cases,group}))>98304)throw new VF("SNAPSHOT_TOO_LARGE");
   return {version:3,cases,group,source:commits.length===1&&components.length===1&&typeof components[0]==="string"&&components[0].length>0&&rs.every(r=>r.observation.commit_sha===commits[0])?{id:components[0],commit:commits[0],component_id:components[0]}:null};
  };
  return group?[make(rows)]:rows.map(r=>make([r]));
 }
 async function admit(db:PoolClient,owner:string,target:Row,run:string,policy:VerificationPolicy,reason?:string){
  const result:string[]=[];let existing=false;
  const pending=Number((await db.query("SELECT count(*) FROM verification_investigation WHERE installation_id=$1 AND state NOT IN('completed','failed','cancelled')",[installation])).rows[0].count);
  if(pending>=policy.maxPending)throw new VF("BUSY");
  for(const snap of await snapshot(db,owner,target)){
   const snapHash=verificationHash(snap),fingerprint=verificationHash({snapshot:snapHash,reason:reason??null,verifier:"runner-evidence-v1"});
   const prior=(await db.query("SELECT id,state FROM verification_investigation WHERE installation_id=$1 AND owner_id=$2 AND (fingerprint=$3 OR (snapshot_hash=$4 AND state NOT IN('completed','failed','cancelled'))) ORDER BY registered_at DESC LIMIT 1",[installation,owner,fingerprint,snapHash])).rows[0];
   if(prior){existing=true;if(target.kind!=="pending")result.push(prior.id);continue;}
   if(result.length>=Math.min(policy.schedule.maxInvestigationsPerRun,policy.maxPending-pending))break;
   const id=randomUUID(),workflow="bug-hunt/verify/"+verificationHash([installation,owner]).slice(0,20)+"/"+id;
   const revision=Number((await db.query("SELECT count(*) FROM verification_investigation WHERE installation_id=$1 AND owner_id=$2 AND snapshot->'cases' @> $3::jsonb",[installation,owner,JSON.stringify([{case_id:snap.cases[0].case_id}])])).rows[0].count)+1;
   await db.query("INSERT INTO verification_investigation(id,installation_id,owner_id,run_id,revision,fingerprint,snapshot,snapshot_hash,policy,config_hash,executor,workflow_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",[id,installation,owner,run,revision,fingerprint,snap,snapHash,policy,verificationHash(policy),policy.executor,workflow]);
   result.push(id);
  }
  return {ids:result,existing};
 }
 return {
  /** Атомарно допускает ограниченную ручную порцию, закрепляя профиль даже при выключенном worker. */
  request(p:Principal,input:Row){return mutation(p,"run-request",input,async db=>{
   const policy=options.policy();if(!policy.externalAllowedOwners.includes(p.ownerId))throw new VF("POLICY_FORBIDDEN");if(!policy.schedule.manualEnabled)throw new VF("MANUAL_DISABLED");
   const schedule=(await db.query("SELECT paused FROM verification_schedule WHERE installation_id=$1",[installation])).rows[0];
   if(schedule?.paused)throw new VF("PAUSED");
   const run=randomUUID();await db.query("INSERT INTO verification_run(id,installation_id,owner_id,trigger_kind) VALUES($1,$2,$3,'manual')",[run,installation,p.ownerId]);
   const selection=await admit(db,p.ownerId,input.target,run,policy,input.reason),outcome=selection.existing&&input.target.kind!=="pending"?"already_running":selection.ids.length?"queued":"no_work";
   await db.query("UPDATE verification_run SET selected=$2,outcome=$3 WHERE id=$1",[run,selection.ids.length,outcome]);
   return {run_id:run,outcome,investigation_ids:selection.ids};
  });},
  /** Tick сохраняет следующее будущее время; один catch-up, без I/O моделей и без осушения очереди. */
  tick(now=new Date()){return tx(async db=>{
   await lock(db);const policy=options.policy(),interval=policy.schedule.intervalHours*3600000;
   if(!policy.enabled||!policy.schedule.enabled)return {outcome:"disabled",selected:0};
   await db.query("INSERT INTO verification_schedule(installation_id,revision,next_due_at) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",[installation,policy.revision,new Date(now.getTime()+interval)]);
   const s=(await db.query("SELECT * FROM verification_schedule WHERE installation_id=$1 FOR UPDATE",[installation])).rows[0];
   if(s.paused||s.next_due_at>now)return {outcome:s.paused?"paused":"not_due",selected:0};
   const active=Number((await db.query("SELECT count(*) FROM verification_investigation WHERE installation_id=$1 AND state NOT IN('completed','failed','cancelled')",[installation])).rows[0].count);
   const tick=randomUUID();let selected=0;
   if(active<policy.maxPending){await capacity(db,policy);
    for(const owner of policy.externalAllowedOwners){
     if(selected>=policy.schedule.maxInvestigationsPerRun||selected+active>=policy.maxPending)break;
     const run=randomUUID();await db.query("INSERT INTO verification_run(id,installation_id,owner_id,trigger_kind) VALUES($1,$2,$3,'timer')",[run,installation,owner]);
     const selection=await admit(db,owner,{kind:"pending"},run,{...policy,schedule:{...policy.schedule,maxInvestigationsPerRun:Math.min(policy.schedule.maxInvestigationsPerRun-selected,policy.maxPending-active-selected)}});
     selected+=selection.ids.length;await db.query("UPDATE verification_run SET selected=$2,outcome=$3 WHERE id=$1",[run,selection.ids.length,selection.ids.length?"queued":"no_work"]);
    }
   }
   const outcome=active>=policy.maxPending?"already_running":selected?"queued":"no_work";
   await db.query("UPDATE verification_schedule SET revision=$2,next_due_at=$3,last_tick_id=$4,last_outcome=$5,last_selected=$6,updated_at=$7 WHERE installation_id=$1",[installation,policy.revision,new Date(now.getTime()+interval),tick,outcome,selected,now]);
   return {outcome,selected,tick_id:tick};
  });},
  async get(p:Principal,id:string,reviewBefore?:number){return tx(async db=>{
   const r=await find(db,p,id);
   const results=(await db.query("SELECT id,revision,payload,validator_receipt,registered_at FROM verification_result WHERE investigation_id=$1 AND installation_id=$2 AND owner_id=$3 ORDER BY revision DESC LIMIT 50",[id,installation,p.ownerId])).rows;
   const reviews=(await db.query("SELECT id,revision,actor_id,verdict,explanation,registered_at FROM verification_review WHERE investigation_id=$1 AND installation_id=$2 AND owner_id=$3 AND ($4::int IS NULL OR revision<$4) ORDER BY revision DESC LIMIT 11",[id,installation,p.ownerId,reviewBefore??null])).rows;
   const moreReviews=reviews.length>10,reviewPage=reviews.slice(0,10);
   const evidence=(await db.query("SELECT id,kind,sha256 FROM verification_evidence WHERE investigation_id=$1 AND installation_id=$2 AND owner_id=$3 ORDER BY id LIMIT 50",[id,installation,p.ownerId])).rows;
   const effects=(await db.query("SELECT id,kind,step_key,checkpoint->>'state' AS state,checkpoint->>'code' AS code,checkpoint->'usage' AS usage,checkpoint->'native'->'usage_totals' AS usage_totals FROM verification_effect WHERE investigation_id=$1 AND installation_id=$2 AND owner_id=$3 ORDER BY registered_at LIMIT 50",[id,installation,p.ownerId])).rows;
   let applicability="historical";
   if(r.snapshot.group){const group=(await db.query("SELECT revision FROM observation_group WHERE id=$1 AND installation_id=$2 AND owner_id=$3",[r.snapshot.group.id,installation,p.ownerId])).rows[0];applicability=group?.revision===r.snapshot.group.revision?"current_for_snapshot":"stale";}
   else applicability="current_for_snapshot";
   return {investigation_id:r.id,state:r.state,code:r.code,executor:r.executor,config_revision:r.policy.revision,model:r.model,revision:r.revision,snapshot:{...r.snapshot,cases:r.snapshot.cases.map(({observation,...ref})=>ref)},applicability,cancel_requested:r.cancel_requested,manual_revision:r.manual_revision,current_result_id:r.current_result_id,results,reviews:reviewPage,next_review_revision:moreReviews?reviewPage.at(-1)?.revision:null,evidence,effects};
  });},
  async list(p:Principal,input:Row){
   const binding=verificationHash([installation,p.ownerId,input.case_id??null]),limit=input.limit??20;
   let id:string|null=null,at:string|null=null;
   if(input.cursor){try{const [data,mac]=input.cursor.split("."),expected=createHmac("sha256",options.cursorKey).update(data).digest("base64url");
    if(Buffer.byteLength(mac)!==Buffer.byteLength(expected)||!timingSafeEqual(Buffer.from(mac),Buffer.from(expected)))throw 0;
    const c=JSON.parse(Buffer.from(data,"base64url").toString());if(c.binding!==binding||!/^[a-f0-9-]{36}$/.test(c.id)||!Number.isFinite(Date.parse(c.at)))throw 0;id=c.id;at=c.at;
   }catch{throw new VF("INVALID_CURSOR");}}
   const rows=(await pool.query("SELECT id,state,executor,model,revision,registered_at,current_result_id FROM verification_investigation WHERE installation_id=$1 AND owner_id=$2 AND ($3::uuid IS NULL OR snapshot->'cases' @> jsonb_build_array(jsonb_build_object('case_id',$3::text))) AND ($4::timestamptz IS NULL OR (registered_at,id)<($4::timestamptz,$5::uuid)) ORDER BY registered_at DESC,id DESC LIMIT $6",[installation,p.ownerId,input.case_id??null,at,id,limit+1])).rows;
   const more=rows.length>limit,items=rows.slice(0,limit),last=items.at(-1);let cursor=null;
   if(more&&last){const data=Buffer.from(JSON.stringify({binding,id:last.id,at:last.registered_at.toISOString()})).toString("base64url");cursor=data+"."+createHmac("sha256",options.cursorKey).update(data).digest("base64url");}
   const schedule=(await pool.query("SELECT next_due_at FROM verification_schedule WHERE installation_id=$1",[installation])).rows[0];
   return {items,has_more:more,next_cursor:cursor,next_due_at:schedule?.next_due_at??null};
  },
  async evidence(p:Principal,input:Row){await find(pool,p,input.investigation_id);const row=(await pool.query("SELECT payload FROM verification_evidence WHERE id=$1 AND investigation_id=$2 AND installation_id=$3 AND owner_id=$4",[input.evidence_id,input.investigation_id,installation,p.ownerId])).rows[0];if(!row)throw new VF("NOT_FOUND");const e=row.payload as Evidence,chars=Array.from(e.text),offset=input.offset??0,end=offset+(input.limit??4096);return {...e,text:chars.slice(offset,end).join(""),offset,total_chars:chars.length,next_offset:end<chars.length?end:null};},
  cancel(p:Principal,input:Row){return mutation(p,"cancel",input,async db=>{const r=await find(db,p,input.investigation_id);if(!terminal.includes(r.state))await db.query("UPDATE verification_investigation SET cancel_requested=true,updated_at=now() WHERE id=$1",[r.id]);return {investigation_id:r.id,cancel_requested:!terminal.includes(r.state),state:r.state};});},
  review(p:Principal,input:Row){if(!p.reviewer)throw new VF("FORBIDDEN");return mutation(p,"review",input,async db=>{const r=await find(db,p,input.investigation_id);if(r.manual_revision!==input.expected_revision)throw new VF("REVISION_CONFLICT");const id=randomUUID(),revision=r.manual_revision+1;await db.query("INSERT INTO verification_review(id,investigation_id,installation_id,owner_id,actor_id,revision,verdict,explanation) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",[id,r.id,installation,p.ownerId,p.actorId,revision,input.verdict,input.explanation]);await db.query("UPDATE verification_investigation SET manual_revision=$2,updated_at=now() WHERE id=$1",[r.id,revision]);return {investigation_id:r.id,review_id:id,revision};});},
  pause(input:Row){const p:Principal={ownerId:"operator",actorId:"operator",reviewer:true,source:"codex"};return mutation(p,"pause",input,async db=>{const policy=options.policy();await db.query("INSERT INTO verification_schedule(installation_id,revision,next_due_at,paused) VALUES($1,$2,now()+interval '6 hours',$3) ON CONFLICT(installation_id) DO UPDATE SET paused=$3,updated_at=now()",[installation,policy.revision,input.paused]);return {paused:input.paused};});},
  async status(){const schedule=(await pool.query("SELECT revision,next_due_at,last_tick_id,last_outcome,last_selected,paused FROM verification_schedule WHERE installation_id=$1",[installation])).rows[0]??null;const states=(await pool.query("SELECT state,count(*)::int AS count FROM verification_investigation WHERE installation_id=$1 GROUP BY state",[installation])).rows;return {schedule,states,executor:options.policy().executor,config_revision:options.policy().revision};},
  async terminal(id:string){const row=(await pool.query("SELECT state FROM verification_investigation WHERE id=$1 AND installation_id=$2",[id,installation])).rows[0];return !!row&&terminal.includes(row.state);},
  async pending(){return (await pool.query("SELECT id,workflow_id,workflow_state FROM verification_investigation WHERE installation_id=$1 AND state NOT IN('completed','failed','cancelled') ORDER BY CASE WHEN workflow_state='pending' THEN 0 ELSE 1 END,updated_at,id LIMIT 5",[installation])).rows;},
  async workflow(id:string,state:string){await pool.query("UPDATE verification_investigation SET workflow_state=$3,updated_at=now() WHERE id=$1 AND installation_id=$2",[id,installation,state]);},
  /** Session guard удерживается до завершения своего I/O и исключает второго worker после timeout. */
  async guard<T>(id:string,work:(r:Investigation)=>Promise<T>):Promise<T|null>{
   const db=await pool.connect();const key=installation+":"+id;let started=0,charged:Investigation|undefined;
   try{if(!(await db.query("SELECT pg_try_advisory_lock(hashtextextended($1,306)) AS locked",[key])).rows[0].locked)return null;
    const row=(await db.query("UPDATE verification_investigation SET fence=fence+1,deadline_at=now()+greatest(0,(policy->'budgets'->>'attemptMs')::bigint-active_ms)*interval '1 millisecond' WHERE id=$1 AND installation_id=$2 AND state NOT IN('completed','failed','cancelled') RETURNING *",[id,installation])).rows[0];
    if(!row)return null;charged=row;started=Date.now();return await work(row);
   }finally{if(started&&charged?.charge_active!==false)await db.query("UPDATE verification_investigation SET active_ms=active_ms+$3 WHERE id=$1 AND installation_id=$2",[id,installation,Math.max(0,Date.now()-started)]).catch(()=>{});await db.query("SELECT pg_advisory_unlock(hashtextextended($1,306))",[key]).catch(()=>{});db.release();}
  },
  async set(r:Investigation,state:string,code:string|null=null,stage=r.stage,model=r.model){const result=await pool.query("UPDATE verification_investigation SET state=$4,code=$5,stage=$6,model=$7,workflow_state=CASE WHEN $4 IN('completed','failed','cancelled') THEN 'terminal' ELSE workflow_state END,updated_at=now() WHERE id=$1 AND installation_id=$2 AND fence=$3 AND state NOT IN('completed','failed','cancelled')",[r.id,installation,r.fence,state,code,stage,model]);if(!result.rowCount){const current=(await pool.query("SELECT state,fence FROM verification_investigation WHERE id=$1 AND installation_id=$2",[r.id,installation])).rows[0];if(Number(current?.fence)!==Number(r.fence)||!terminal.includes(current?.state))throw new VF("STALE_FENCE");}},
  async allowed(r:Investigation){const p=options.policy();const s=(await pool.query("SELECT i.cancel_requested,s.paused FROM verification_investigation i LEFT JOIN verification_schedule s USING(installation_id) WHERE i.id=$1 AND i.installation_id=$2 AND i.fence=$3",[r.id,installation,r.fence])).rows[0];return !!s&&!s.cancel_requested&&!s.paused&&p.enabled&&p.externalAllowedOwners.includes(r.owner_id);},
  async cancelRequested(r:Investigation){const row=(await pool.query("SELECT cancel_requested FROM verification_investigation WHERE id=$1 AND installation_id=$2 AND fence=$3",[r.id,installation,r.fence])).rows[0];return row?.cancel_requested===true;},
  async effect(r:Investigation,kind:string,key:string,intent:Row){return tx(async db=>{
   const parent=(await db.query("SELECT fence FROM verification_investigation WHERE id=$1 AND installation_id=$2 FOR UPDATE",[r.id,installation])).rows[0];if(Number(parent?.fence)!==Number(r.fence))throw new VF("STALE_FENCE");
   const old=(await db.query("SELECT * FROM verification_effect WHERE investigation_id=$1 AND kind=$2 AND step_key=$3",[r.id,kind,key])).rows[0];
   const h=verificationHash(intent);if(old){if(old.input_hash!==h)throw new VF("IDEMPOTENCY_CONFLICT");return {...old,fresh:false};}
   const id=intent.id??randomUUID(),checkpoint={state:"not_sent",native:{},result:null,code:null,usage:null};
   await capacity(db,r.policy);
   await db.query("INSERT INTO verification_effect(id,investigation_id,installation_id,owner_id,kind,step_key,input_hash,intent,checkpoint) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",[id,r.id,installation,r.owner_id,kind,key,h,intent,checkpoint]);return {id,intent,checkpoint,fresh:true};
  });},
  async checkpoint(r:Investigation,id:string,checkpoint:ModelCheckpoint|Row){return tx(async db=>{
   const old=(await db.query("SELECT e.kind,e.checkpoint FROM verification_effect e JOIN verification_investigation i ON i.id=e.investigation_id WHERE e.id=$1 AND i.id=$2 AND i.installation_id=$3 AND i.fence=$4 FOR UPDATE OF e",[id,r.id,installation,r.fence])).rows[0];
   if(!old)throw new VF("STALE_FENCE");
   if(r.executor==="codex_app_server"&&old.kind==="model"){
    const u=checkpoint.usage,total=u?.totalTokens??(typeof u?.inputTokens==="number"&&typeof u?.outputTokens==="number"?u.inputTokens+u.outputTokens:null);
    const previous=Number(old.checkpoint.native?.accounted_tokens??0),day=checkpoint.native?.budget_day??old.checkpoint.native?.budget_day;
    if(Number.isSafeInteger(total)&&total>=0&&total<=1000000000&&/^\d{4}-\d{2}-\d{2}$/.test(day??"")){
     const charged=Math.max(previous,total);checkpoint={...checkpoint,native:{...checkpoint.native,budget_day:day,accounted_tokens:charged}};
     if(charged>previous){const budget=await db.query("UPDATE verification_budget SET tokens=tokens+$4 WHERE installation_id=$1 AND owner_id=$2 AND day=$3",[installation,r.owner_id,day,charged-previous]);if(!budget.rowCount)throw new VF("BUDGET_RECEIPT_MISSING");}
    }else if(previous)checkpoint={...checkpoint,native:{...checkpoint.native,budget_day:day,accounted_tokens:previous}};
   }
   const updated=await db.query("UPDATE verification_effect e SET checkpoint=$5,updated_at=now() FROM verification_investigation i WHERE e.investigation_id=i.id AND e.id=$1 AND i.id=$2 AND i.installation_id=$3 AND i.fence=$4",[id,r.id,installation,r.fence,checkpoint]);if(!updated.rowCount)throw new VF("STALE_FENCE");
  });},
  async effects(r:Investigation){return (await pool.query("SELECT * FROM verification_effect WHERE investigation_id=$1 AND installation_id=$2 AND owner_id=$3 ORDER BY registered_at",[r.id,installation,r.owner_id])).rows;},
  async evidenceAll(r:Investigation):Promise<Evidence[]>{return (await pool.query("SELECT payload FROM verification_evidence WHERE investigation_id=$1 AND installation_id=$2 AND owner_id=$3 ORDER BY id",[r.id,installation,r.owner_id])).rows.map(x=>x.payload);},
  /** Возвращает страницу только метаданных; cursor не ограничивает последующее чтение по ID. */
  async evidencePage(r:Investigation,after:string|null=null,limit=20){
   const rows=(await pool.query("SELECT id,kind,sha256,payload->>'availability' AS availability,payload->'external_allowed' AS external_allowed FROM verification_evidence WHERE investigation_id=$1 AND installation_id=$2 AND owner_id=$3 AND ($4::uuid IS NULL OR id>$4::uuid) ORDER BY id LIMIT $5",[r.id,installation,r.owner_id,after,limit+1])).rows;
   return {items:rows.slice(0,limit),next_cursor:rows.length>limit?rows[limit-1].id:null};
  },
  /** Читает все запрошенные scoped IDs без усечения по позиции в inventory. */
  async evidenceByIds(r:Investigation,ids:string[]):Promise<Evidence[]>{if(!ids.length)return [];return (await pool.query("SELECT payload FROM verification_evidence WHERE investigation_id=$1 AND installation_id=$2 AND owner_id=$3 AND id=ANY($4::uuid[]) ORDER BY id",[r.id,installation,r.owner_id,ids])).rows.map(x=>x.payload);},
  /** Находит свидетельство принятого recipe по точному immutable происхождению. */
  async evidenceSource(r:Investigation,kind:string,sourceId:string,path:string,blobHash:string):Promise<Evidence|null>{
   return (await pool.query("SELECT payload FROM verification_evidence WHERE investigation_id=$1 AND installation_id=$2 AND owner_id=$3 AND kind=$4 AND payload#>>'{provenance,source_id}'=$5 AND payload#>>'{provenance,path}'=$6 AND payload#>>'{provenance,blob_sha256}'=$7 ORDER BY id LIMIT 1",[r.id,installation,r.owner_id,kind,sourceId,path,blobHash])).rows[0]?.payload??null;
  },
  async putEvidence(r:Investigation,e:Evidence){if(e.scope.investigation_id!==r.id||e.scope.owner_id!==r.owner_id||e.scope.installation_id!==installation||verificationHash(e.text)!==e.sha256||Buffer.byteLength(e.text)>65536)throw new VF("EVIDENCE_INTEGRITY");await tx(async db=>{await capacity(db,r.policy);const old=(await db.query("SELECT sha256,payload FROM verification_evidence WHERE id=$1",[e.id])).rows[0];if(old){if(verificationHash(old.payload)!==verificationHash(e))throw new VF("EVIDENCE_CONFLICT");return;}await db.query("INSERT INTO verification_evidence(id,investigation_id,installation_id,owner_id,kind,sha256,payload) SELECT $1,$2,$3,$4,$5,$6,$7 FROM verification_investigation WHERE id=$2 AND installation_id=$3 AND owner_id=$4 AND fence=$8",[e.id,r.id,installation,r.owner_id,e.kind,e.sha256,e,r.fence]);});},
  async reserve(r:Investigation,tokens:number){return tx(async db=>{await lock(db);await capacity(db,r.policy);const day=new Date().toISOString().slice(0,10),p=options.policy();
   const own=(await db.query("SELECT calls,tokens FROM verification_budget WHERE installation_id=$1 AND owner_id=$2 AND day=$3",[installation,r.owner_id,day])).rows[0]??{calls:0,tokens:0};
   const total=(await db.query("SELECT coalesce(sum(calls),0)::int AS calls,coalesce(sum(tokens),0)::float8 AS tokens FROM verification_budget WHERE installation_id=$1 AND day=$2",[installation,day])).rows[0];
   if(own.calls>=p.budgets.ownerDailyCalls||total.calls>=p.budgets.dailyCalls||r.executor==="providers"&&total.tokens+tokens>p.budgets.dailyTokens)throw new VF("BUDGET_EXHAUSTED");
   await db.query("INSERT INTO verification_budget(installation_id,owner_id,day,calls,tokens) VALUES($1,$2,$3,1,$4) ON CONFLICT(installation_id,owner_id,day) DO UPDATE SET calls=verification_budget.calls+1,tokens=verification_budget.tokens+$4",[installation,r.owner_id,day,tokens]);return day;});},
  async publish(r:Investigation,payload:Row,receipt:Row){return tx(async db=>{
   const parent=(await db.query("SELECT fence,manual_revision,current_result_id,cancel_requested FROM verification_investigation WHERE id=$1 AND installation_id=$2 AND owner_id=$3 FOR UPDATE",[r.id,installation,r.owner_id])).rows[0];
   if(Number(parent?.fence)!==Number(r.fence))throw new VF("STALE_FENCE");if(parent.current_result_id)return parent.current_result_id;const existing=(await db.query("SELECT id FROM verification_result WHERE investigation_id=$1 AND installation_id=$2 AND owner_id=$3 ORDER BY revision DESC LIMIT 1",[r.id,installation,r.owner_id])).rows[0];if(existing)return existing.id;if(parent.cancel_requested)throw new VF("CANCEL_REQUESTED");
   const id=randomUUID();await capacity(db,r.policy);await db.query("INSERT INTO verification_result(id,investigation_id,installation_id,owner_id,revision,payload,validator_receipt) VALUES($1,$2,$3,$4,1,$5,$6)",[id,r.id,installation,r.owner_id,payload,receipt]);
   await db.query("UPDATE verification_investigation SET current_result_id=CASE WHEN manual_revision=0 THEN $2 ELSE current_result_id END,state='completed',workflow_state='terminal',updated_at=now() WHERE id=$1",[r.id,id]);return id;
  });}
 };
}
