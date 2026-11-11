// ABOUTME: Реализует локальный поиск, точные группы и ручные решения в собственной БД.
// ABOUTME: Производные данные не меняют исходные наблюдения, review или квитанции v1.
import {createHash,createHmac,randomUUID,timingSafeEqual} from "node:crypto";
import type {Pool,PoolClient} from "pg";
import {canonical,type Principal,type Observation} from "./contracts.js";
import {searchProjection,exactSignature,PROJECTION_VERSION,GENERATION} from "./projection.js";
import {SystemFault,type SystemStore,type MembershipInput,type GroupRevision,type SystemFilters} from "./system-contracts.js";

interface Options {installationId:string;cursorKey:string;maxDatabaseBytes?:number;deadlineAt?:number}
interface Cursor {binding:string;generation:string;at:string;id:string}
type Row=Record<string,any>;
const hash=(value:unknown)=>createHash("sha256").update(canonical(value)).digest("hex");
const dates=(row:Row):Row=>Object.fromEntries(Object.entries(row).map(([k,v])=>[k,v instanceof Date?v.toISOString():v]));
const groupColumns="g.id,g.revision,g.created_at,g.updated_at,(SELECT count(*)::int FROM group_membership m WHERE m.installation_id=g.installation_id AND m.owner_id=g.owner_id AND m.group_id=g.id) AS member_count,(SELECT count(*)::int FROM group_membership m JOIN report r ON r.case_id=m.case_id AND r.owner_id=m.owner_id AND r.installation_id=m.installation_id WHERE m.installation_id=g.installation_id AND m.owner_id=g.owner_id AND m.group_id=g.id) AS report_count,(SELECT count(DISTINCT c.source)::int FROM group_membership m JOIN bug_case c ON c.id=m.case_id AND c.owner_id=m.owner_id AND c.installation_id=m.installation_id WHERE m.installation_id=g.installation_id AND m.owner_id=g.owner_id AND m.group_id=g.id) AS source_count";

/** Создаёт scoped PostgreSQL-порт; списки owner-only; reviewer получает scope из выбранной карточки или группы. */
export function createSystemStore(pool:Pool,options:Options):SystemStore&{indexReport(reportId:string):Promise<void>;reconcileLocal(limit?:number):Promise<number>}{
 const installation=options.installationId;
 const sign=(raw:string)=>createHmac("sha256",options.cursorKey).update(raw).digest("base64url");
 const encode=(value:Cursor)=>{const body=Buffer.from(JSON.stringify(value)).toString("base64url");return body+"."+sign(body);};
 function decode(raw:string|undefined,binding:string,generation:string):Cursor|null{
  if(!raw)return null;
  let value:Cursor;
  try{
   const [body,mac,...extra]=raw.split("."),expected=Buffer.from(sign(body)),actual=Buffer.from(mac);
   if(extra.length||actual.length!==expected.length||!timingSafeEqual(actual,expected))throw 0;
   value=JSON.parse(Buffer.from(body,"base64url").toString());
   if(value.binding!==binding||typeof value.at!=="string"||!Number.isFinite(Date.parse(value.at))||!/^[0-9a-f-]{36}$/i.test(value.id))throw 0;
  }catch{throw new SystemFault("INVALID_ARGUMENT");}
  if(value.generation!==generation)throw new SystemFault("CURSOR_STALE");
  return value;
 }
 async function tx<T>(work:(db:PoolClient)=>Promise<T>,readOnly=false):Promise<T>{
  if(options.deadlineAt!==undefined&&Date.now()>=options.deadlineAt)throw new SystemFault("DEADLINE_EXCEEDED");
  let db:PoolClient;try{db=await pool.connect();}catch{throw new SystemFault("DATABASE_UNAVAILABLE");}
  let committing=false;
  try{
   await db.query(readOnly?"BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY":"BEGIN");
   await db.query("SET LOCAL statement_timeout='7000ms'");
   await db.query("SET LOCAL lock_timeout='5000ms'");
   const query=async(sql:string,values?:unknown[])=>{
    const remaining=options.deadlineAt===undefined?7000:Math.min(7000,options.deadlineAt-Date.now());
    if(remaining<=0)throw new SystemFault("DEADLINE_EXCEEDED");
    await db.query("SELECT set_config('statement_timeout',$1,true)",[String(remaining)]);
    return db.query(sql,values);
   };
   const value=await work({query} as PoolClient);
   if(options.deadlineAt!==undefined&&Date.now()>=options.deadlineAt)throw new SystemFault("DEADLINE_EXCEEDED");
   committing=true;await db.query("COMMIT");return value;
  }catch(error){
   let rolledBack=false;try{await db.query("ROLLBACK");rolledBack=true;}catch{}
   if(error instanceof SystemFault)throw error;
   throw new SystemFault("DATABASE_UNAVAILABLE",committing||!rolledBack?"unknown":"not_accepted");
  }finally{db.release();}
 }
 async function scopeLock(db:PoolClient,owner:string){
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,27))",[canonical([installation,owner,"local-systematization"])]);
 }
 async function capacity(db:PoolClient){
  if(options.maxDatabaseBytes!==undefined){
   const row=(await db.query("SELECT pg_database_size(current_database())::bigint AS bytes")).rows[0];
   if(Number(row.bytes)>=options.maxDatabaseBytes)throw new SystemFault("BUSY");
  }
 }
 async function lookupCase(db:PoolClient,p:Principal,id:string,mutation=false):Promise<Row>{
  const row=(await db.query("SELECT c.*,r.id AS report_id FROM bug_case c JOIN report r ON r.case_id=c.id AND r.owner_id=c.owner_id AND r.installation_id=c.installation_id WHERE c.id=$1 AND c.installation_id=$2 AND (c.owner_id=$3 OR $4::boolean)",[id,installation,p.ownerId,mutation&&p.reviewer])).rows[0];
  if(!row)throw new SystemFault("NOT_FOUND");return row;
 }
 async function lookupGroup(db:PoolClient,p:Principal,id:string):Promise<Row>{
  const row=(await db.query("SELECT g.owner_id AS scope_owner,"+groupColumns+" FROM observation_group g WHERE g.id=$1 AND g.installation_id=$2 AND (g.owner_id=$3 OR $4::boolean)",[id,installation,p.ownerId,p.reviewer])).rows[0];
  if(!row)throw new SystemFault("NOT_FOUND");return dates(row);
 }
 async function mutation(p:Principal,op:string,input:{request_id:string},work:(db:PoolClient)=>Promise<Row>){
  if(!p.reviewer)throw new SystemFault("FORBIDDEN");
  return tx(async db=>{
   const key=[installation,p.ownerId,p.actorId,op,input.request_id],inputHash=hash(input);
   await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,29))",[canonical(key)]);
   const prior=(await db.query("SELECT input_hash,result FROM v2_mutation WHERE installation_id=$1 AND owner_id=$2 AND actor_id=$3 AND operation=$4 AND request_id=$5",key)).rows[0];
   if(prior){if(prior.input_hash!==inputHash)throw new SystemFault("IDEMPOTENCY_CONFLICT");return {...prior.result,replayed:true};}
   await capacity(db);
   const result={...await work(db),request_id:input.request_id,replayed:false};
   await db.query("INSERT INTO v2_mutation(installation_id,owner_id,actor_id,operation,request_id,input_hash,result) VALUES($1,$2,$3,$4,$5,$6,$7)",[...key,inputHash,result]);
   return result;
  });
 }
 async function decision(db:PoolClient,owner:string,caseId:string,p:Principal,explanation:string,excluded:boolean){
  await db.query("INSERT INTO grouping_decision(id,installation_id,owner_id,case_id,revision,excluded_from_auto,actor_id,explanation) SELECT $1,$2,$3,$4,coalesce(max(revision),0)+1,$5,$6,$7 FROM grouping_decision WHERE installation_id=$2 AND owner_id=$3 AND case_id=$4",[randomUUID(),installation,owner,caseId,excluded,p.actorId,explanation]);
 }
 async function audit(db:PoolClient,owner:string,groupId:string,revision:number,p:Principal,operation:string,explanation:string,caseIds:string[]){
  await db.query("INSERT INTO group_audit(id,installation_id,owner_id,group_id,actor_id,operation,explanation,old_revision,new_revision,case_ids) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",[randomUUID(),installation,owner,groupId,p.actorId,operation,explanation,revision,revision+1,caseIds]);
 }
 async function move(db:PoolClient,p:Principal,input:MembershipInput,owner:string){
  await scopeLock(db,owner);
  const cases=await db.query("SELECT id FROM bug_case WHERE installation_id=$1 AND owner_id=$2 AND id=ANY($3::uuid[]) ORDER BY id FOR UPDATE",[installation,owner,input.case_ids]);
  if(cases.rowCount!==input.case_ids.length)throw new SystemFault("NOT_FOUND");
  const memberships=(await db.query("SELECT case_id,group_id FROM group_membership WHERE installation_id=$1 AND owner_id=$2 AND case_id=ANY($3::uuid[])",[installation,owner,input.case_ids])).rows;
  const touched=[...new Set([...memberships.map(r=>r.group_id),...(input.target_group_id?[input.target_group_id]:[])])].sort();
  const groups=(await db.query("SELECT id,revision FROM observation_group WHERE installation_id=$1 AND owner_id=$2 AND id=ANY($3::uuid[]) ORDER BY id FOR UPDATE",[installation,owner,touched])).rows;
  if(groups.length!==touched.length)throw new SystemFault("NOT_FOUND");
  const expected=new Map(input.expected_revisions.map(r=>[r.group_id,r.revision]));
  if(expected.size!==input.expected_revisions.length||expected.size!==touched.length||groups.some(g=>expected.get(g.id)!==g.revision))throw new SystemFault("REVISION_CONFLICT");
  const target=input.target_group_id??randomUUID(),at=new Date().toISOString(),revisions:GroupRevision[]=[];
  if(!input.target_group_id)await db.query("INSERT INTO observation_group(id,installation_id,owner_id) VALUES($1,$2,$3)",[target,installation,owner]);
  for(const group of groups){
   const changed=await db.query("UPDATE observation_group SET revision=revision+1,updated_at=$4 WHERE installation_id=$1 AND owner_id=$2 AND id=$3 RETURNING revision",[installation,owner,group.id,at]);
   revisions.push({group_id:group.id,revision:changed.rows[0].revision});
   await audit(db,owner,group.id,group.revision,p,"membership-update",input.explanation,input.case_ids);
  }
  if(!input.target_group_id){revisions.push({group_id:target,revision:1});await audit(db,owner,target,0,p,"membership-create",input.explanation,input.case_ids);}
  for(const caseId of input.case_ids){
   await db.query("INSERT INTO group_membership(installation_id,owner_id,case_id,group_id,method) VALUES($1,$2,$3,$4,'manual') ON CONFLICT(installation_id,owner_id,case_id) DO UPDATE SET group_id=EXCLUDED.group_id,method='manual',registered_at=$5",[installation,owner,caseId,target,at]);
   await decision(db,owner,caseId,p,input.explanation,input.exclude_from_auto??true);
  }
  return {group_id:target,groups:revisions.sort((a,b)=>a.group_id.localeCompare(b.group_id)),case_ids:input.case_ids,registered_at:at};
 }
 function filterWhere(filters:SystemFilters,values:unknown[]):string{
  let where="c.installation_id=$1 AND c.owner_id=$2";
  const fields:Record<string,string>={review_state:"c.review_state =",component_id:"c.component_id =",source:"c.source =",error_code:"r.observation->>'error_code' =",registered_from:"c.registered_at >=",registered_to:"c.registered_at <="};
  for(const [name,value] of Object.entries(filters)){values.push(value);where+=" AND "+fields[name]+" $"+values.length;}
  return where;
 }
 const resultPage=(rows:Row[],limit:number,binding:string,generation:string,time="registered_at",id="case_id")=>{
  const items=rows.slice(0,limit).map(dates),last=items.at(-1),has_more=rows.length>limit;
  return {items,has_more,next_cursor:has_more&&last?encode({binding,generation,at:last[time],id:last[id]}):null};
 };
 const store:SystemStore&{indexReport(reportId:string):Promise<void>;reconcileLocal(limit?:number):Promise<number>}={
  async search(p,input){
   return tx(async db=>{
    const values:unknown[]=[installation,p.ownerId],where=filterWhere(input.filters??{},values);
    const totals=(await db.query("SELECT count(*)::int AS total_reports,count(s.report_id)::int AS indexed_reports FROM bug_case c JOIN report r ON r.case_id=c.id AND r.owner_id=c.owner_id AND r.installation_id=c.installation_id LEFT JOIN search_document s ON s.report_id=r.id AND s.owner_id=r.owner_id AND s.installation_id=r.installation_id AND s.projection_version=$"+(values.length+1)+" WHERE "+where,[...values,PROJECTION_VERSION])).rows[0];
    const coverage={...totals,state:totals.total_reports===totals.indexed_reports?"complete":totals.indexed_reports?"partial":"pending",projection_version:PROJECTION_VERSION};
    const binding=hash({kind:"search",installation,owner:p.ownerId,query:input.query,filters:input.filters??{}}),generation="text-"+PROJECTION_VERSION;
    const cursor=decode(input.cursor,binding,generation),limit=input.limit??20;
    const literal="%"+input.query.replace(/[\\%_]/g,ch=>"\\"+ch)+"%";
    values.push(PROJECTION_VERSION,input.query,literal,cursor?.at??null,cursor?.id??null,limit+1);
    const n=values.length,q=n-4,l=n-3,at=n-2,id=n-1,version=n-5;
    const match="(s.document @@ plainto_tsquery('simple',$"+q+") OR s.document @@ plainto_tsquery('russian',$"+q+") OR s.text ILIKE $"+l+" ESCAPE E'\\\\')";
    const rows=(await db.query("SELECT c.id AS case_id,r.id AS report_id,c.title,c.component_id,c.review_state,c.registered_at,m.group_id,CASE WHEN s.text ILIKE $"+l+" ESCAPE E'\\\\' THEN 'literal' ELSE 'full_text' END AS method,greatest(ts_rank_cd(s.document,plainto_tsquery('simple',$"+q+")),ts_rank_cd(s.document,plainto_tsquery('russian',$"+q+")))::float8 AS score,substring(s.text from greatest(1,strpos(lower(s.text),lower($"+q+"))-80) for 320) AS snippet FROM bug_case c JOIN report r ON r.case_id=c.id AND r.owner_id=c.owner_id AND r.installation_id=c.installation_id JOIN search_document s ON s.report_id=r.id AND s.owner_id=r.owner_id AND s.installation_id=r.installation_id AND s.projection_version=$"+version+" LEFT JOIN group_membership m ON m.case_id=c.id AND m.owner_id=c.owner_id AND m.installation_id=c.installation_id WHERE "+where+" AND "+match+" AND ($"+at+"::timestamptz IS NULL OR (c.registered_at,c.id)<($"+at+"::timestamptz,$"+id+"::uuid)) ORDER BY c.registered_at DESC,c.id DESC LIMIT $"+n,values)).rows;
    return {...resultPage(rows,limit,binding,generation),coverage,generation};
   },true);
  },
  async similar(p,input){await tx(db=>lookupCase(db,p,input.case_id),true);throw new SystemFault("INDEX_NOT_READY");},
  async enrichment(p,input){
   return tx(async db=>{
    const c=await lookupCase(db,p,input.case_id,p.reviewer);
    const args=[installation,c.owner_id,input.case_id];
    const local=(await db.query("SELECT EXISTS(SELECT 1 FROM search_document WHERE installation_id=$1 AND owner_id=$2 AND case_id=$3 AND projection_version=$4) AS indexed,EXISTS(SELECT 1 FROM report_signature WHERE installation_id=$1 AND owner_id=$2 AND case_id=$3 AND algorithm_version=$4 AND signature_hash IS NOT NULL) AS signature_available,(SELECT group_id FROM group_membership WHERE installation_id=$1 AND owner_id=$2 AND case_id=$3) AS group_id,coalesce((SELECT excluded_from_auto FROM grouping_decision WHERE installation_id=$1 AND owner_id=$2 AND case_id=$3 ORDER BY revision DESC LIMIT 1),false) AS excluded_from_auto",[...args,PROJECTION_VERSION])).rows[0];
    const classification=(await db.query("SELECT id,generation,payload FROM classification WHERE installation_id=$1 AND owner_id=$2 AND case_id=$3 ORDER BY registered_at DESC,id DESC LIMIT 1",args)).rows[0]??null;
    const override=(await db.query("SELECT id,revision,labels,explanation,registered_at FROM classification_override WHERE installation_id=$1 AND owner_id=$2 AND case_id=$3 ORDER BY revision DESC LIMIT 1",args)).rows[0]??null;
    const proposals=(await db.query("SELECT id,candidate_case_id,generation,method,score,state FROM similarity_proposal WHERE installation_id=$1 AND owner_id=$2 AND case_id=$3 AND state='pending' ORDER BY score DESC,id LIMIT 20",args)).rows;
    return {case_id:c.id,report_id:c.report_id,local:{state:local.indexed?"ready":"pending",projection_version:PROJECTION_VERSION,signature_available:local.signature_available,group_id:local.group_id,excluded_from_auto:local.excluded_from_auto},classification,override:override?dates(override):null,proposals,model_state:classification?"ready":"pending"};
   },true);
  },
  async groupsList(p,input){
   return tx(async db=>{
    const owner=input.case_id?(await lookupCase(db,p,input.case_id,p.reviewer)).owner_id:p.ownerId;
    const generation="groups-v1",binding=hash({kind:"groups",installation,owner,viewer:p.ownerId,reviewer:p.reviewer}),cursor=decode(input.cursor,binding,generation),limit=input.limit??20;
    const rows=(await db.query("SELECT "+groupColumns+" FROM observation_group g WHERE g.installation_id=$1 AND g.owner_id=$2 AND ($3::timestamptz IS NULL OR (g.created_at,g.id)<($3::timestamptz,$4::uuid)) ORDER BY g.created_at DESC,g.id DESC LIMIT $5",[installation,owner,cursor?.at??null,cursor?.id??null,limit+1])).rows;
    return resultPage(rows,limit,binding,generation,"created_at","id");
   },true);
  },
  async groupsGet(p,input){
   return tx(async db=>{
    const group=await lookupGroup(db,p,input.group_id),generation="group-"+group.revision,binding=hash({kind:"members",installation,owner:p.ownerId,data_owner:group.scope_owner,group_id:input.group_id}),cursor=decode(input.cursor,binding,generation),limit=input.limit??20;
    const rows=(await db.query("SELECT c.id AS case_id,r.id AS report_id,c.title,m.method,c.registered_at FROM group_membership m JOIN bug_case c ON c.id=m.case_id AND c.owner_id=m.owner_id AND c.installation_id=m.installation_id JOIN report r ON r.case_id=c.id AND r.owner_id=c.owner_id AND r.installation_id=c.installation_id WHERE m.installation_id=$1 AND m.owner_id=$2 AND m.group_id=$3 AND ($4::timestamptz IS NULL OR (c.registered_at,c.id)<($4::timestamptz,$5::uuid)) ORDER BY c.registered_at DESC,c.id DESC LIMIT $6",[installation,group.scope_owner,input.group_id,cursor?.at??null,cursor?.id??null,limit+1])).rows;
    const historyBinding=hash({kind:"group-audit",installation,owner:p.ownerId,data_owner:group.scope_owner,group_id:input.group_id}),historyGeneration="audit-v1";
    const historyCursor=decode(input.history_cursor,historyBinding,historyGeneration),historyLimit=input.history_limit??20;
    const historyRows=(await db.query("SELECT id,actor_id,operation,explanation,old_revision,new_revision,case_ids,registered_at FROM group_audit WHERE installation_id=$1 AND owner_id=$2 AND group_id=$3 AND ($4::timestamptz IS NULL OR (registered_at,id)<($4::timestamptz,$5::uuid)) ORDER BY registered_at DESC,id DESC LIMIT $6",[installation,group.scope_owner,input.group_id,historyCursor?.at??null,historyCursor?.id??null,historyLimit+1])).rows;
    const history=resultPage(historyRows,historyLimit,historyBinding,historyGeneration,"registered_at","id");
    const {scope_owner,...publicGroup}=group;
    return {group:publicGroup,...resultPage(rows,limit,binding,generation),history:{items:history.items,next_cursor:history.next_cursor}};
   },true);
  },
  membershipUpdate(p,input){
   return mutation(p,"membership-update",input,async db=>{const c=await lookupCase(db,p,input.case_ids[0],true);return move(db,p,input,c.owner_id);});
  },
  classificationOverride(p,input){
   return mutation(p,"classification-override",input,async db=>{
    const c=await lookupCase(db,p,input.case_id,true);await scopeLock(db,c.owner_id);
    const revision=(await db.query("SELECT coalesce(max(revision),0)::int AS revision FROM classification_override WHERE installation_id=$1 AND owner_id=$2 AND case_id=$3",[installation,c.owner_id,c.id])).rows[0].revision;
    if(revision!==input.expected_revision)throw new SystemFault("REVISION_CONFLICT");
    const id=randomUUID(),at=new Date().toISOString();
    await db.query("INSERT INTO classification_override(id,installation_id,owner_id,case_id,revision,actor_id,labels,explanation,registered_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",[id,installation,c.owner_id,c.id,revision+1,p.actorId,input.labels,input.explanation,at]);
    return {case_id:c.id,override_id:id,revision:revision+1,labels:input.labels,registered_at:at};
   });
  },
  resolveProposal(p,input){
   return mutation(p,"proposal-resolve",input,async db=>{
    const proposal=(await db.query("SELECT * FROM similarity_proposal WHERE id=$1 AND installation_id=$2 AND (owner_id=$3 OR $4::boolean)",[input.proposal_id,installation,p.ownerId,p.reviewer])).rows[0];
    if(!proposal)throw new SystemFault("NOT_FOUND");await scopeLock(db,proposal.owner_id);
    const current=(await db.query("SELECT state FROM similarity_proposal WHERE id=$1 FOR UPDATE",[proposal.id])).rows[0];
    if(current.state!=="pending")throw new SystemFault("REVISION_CONFLICT");
    let group_id:string|null=null,groups:GroupRevision[]=[];
    if(input.decision==="accepted"){
     const target=(await db.query("SELECT group_id FROM group_membership WHERE installation_id=$1 AND owner_id=$2 AND case_id=$3",[installation,proposal.owner_id,proposal.candidate_case_id])).rows[0]?.group_id;
     const change=await move(db,p,{request_id:input.request_id,case_ids:[proposal.case_id,proposal.candidate_case_id],target_group_id:target,expected_revisions:input.expected_revisions,explanation:input.explanation},proposal.owner_id);
     group_id=change.group_id;groups=change.groups;
    }else{
     if(input.expected_revisions.length)throw new SystemFault("INVALID_ARGUMENT");
     await decision(db,proposal.owner_id,proposal.case_id,p,input.explanation,true);
    }
    await db.query("UPDATE similarity_proposal SET state=$2 WHERE id=$1",[proposal.id,input.decision]);
    return {proposal_id:proposal.id,state:input.decision,group_id,groups,registered_at:new Date().toISOString()};
   });
  },
  async status(){
   return tx(async db=>{
    const row=(await db.query("SELECT version FROM sys_capability WHERE capability='local-systematization'")).rows[0];
    if(row?.version!==2)throw new SystemFault("INDEX_NOT_READY");
    await db.query("SELECT s.text,g.revision,m.case_id FROM search_document s,observation_group g,group_membership m LIMIT 0");
    return {ready:true,schema_version:2,local_index:"ready",embedding:"not_configured",generation:GENERATION};
   },true);
  },
  async indexReport(reportId){
   await tx(async db=>{
    const report=(await db.query("SELECT * FROM report WHERE id=$1 AND installation_id=$2",[reportId,installation])).rows[0];
    if(!report)throw new SystemFault("NOT_FOUND");
    await scopeLock(db,report.owner_id);await capacity(db);
    const text=searchProjection(report.observation as Observation),signature=exactSignature(installation,report.owner_id,report.observation);
    await db.query("INSERT INTO search_document(installation_id,owner_id,report_id,case_id,projection_version,text,document,source_hash) VALUES($1,$2,$3,$4,$5,$6,to_tsvector('simple',$6)||to_tsvector('russian',$6),$7) ON CONFLICT DO NOTHING",[installation,report.owner_id,report.id,report.case_id,PROJECTION_VERSION,text,createHash("sha256").update(text).digest("hex")]);
    await db.query("INSERT INTO report_signature(installation_id,owner_id,report_id,case_id,algorithm_version,signature_hash,canonical) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING",[installation,report.owner_id,report.id,report.case_id,PROJECTION_VERSION,signature?.hash??null,signature?.canonical??null]);
    if(!signature)return;
    const assigned=(await db.query("SELECT group_id FROM group_membership WHERE installation_id=$1 AND owner_id=$2 AND case_id=$3",[installation,report.owner_id,report.case_id])).rows[0];
    const excluded=(await db.query("SELECT excluded_from_auto FROM grouping_decision WHERE installation_id=$1 AND owner_id=$2 AND case_id=$3 ORDER BY revision DESC LIMIT 1",[installation,report.owner_id,report.case_id])).rows[0]?.excluded_from_auto;
    if(assigned||excluded)return;
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,37))",[canonical([installation,report.owner_id,signature.hash])]);
    let group=(await db.query("SELECT id,revision,signature_canonical FROM observation_group WHERE installation_id=$1 AND owner_id=$2 AND signature_hash=$3 FOR UPDATE",[installation,report.owner_id,signature.hash])).rows[0];
    // AIDEV-NOTE: Hash никогда не доказывает идентичность; коллизия оставляет карточку без автогруппы.
    if(group&&group.signature_canonical!==signature.canonical)return;
    if(!group){
     group={id:randomUUID(),revision:1};
     await db.query("INSERT INTO observation_group(id,installation_id,owner_id,signature_hash,signature_canonical) VALUES($1,$2,$3,$4,$5)",[group.id,installation,report.owner_id,signature.hash,signature.canonical]);
     await audit(db,report.owner_id,group.id,0,{ownerId:report.owner_id,actorId:"system:local-index",source:"codex",reviewer:false},"exact-create","Совпадение канонического проявления; причина не проверена",[report.case_id]);
    }else{
     await db.query("UPDATE observation_group SET revision=revision+1,updated_at=date_trunc('milliseconds',clock_timestamp()) WHERE id=$1",[group.id]);
     await audit(db,report.owner_id,group.id,group.revision,{ownerId:report.owner_id,actorId:"system:local-index",source:"codex",reviewer:false},"exact","Совпадение канонического проявления; причина не проверена",[report.case_id]);
    }
    await db.query("INSERT INTO group_membership(installation_id,owner_id,case_id,group_id,method) VALUES($1,$2,$3,$4,'exact')",[installation,report.owner_id,report.case_id,group.id]);
   });
  },
  async reconcileLocal(limit=50){
   if(!Number.isInteger(limit)||limit<1||limit>50)throw new SystemFault("INVALID_ARGUMENT");
   const ids=await tx(async db=>(await db.query("SELECT r.id FROM report r WHERE r.installation_id=$1 AND (NOT EXISTS(SELECT 1 FROM search_document s WHERE s.report_id=r.id AND s.installation_id=r.installation_id AND s.owner_id=r.owner_id AND s.projection_version=$2) OR NOT EXISTS(SELECT 1 FROM report_signature s WHERE s.report_id=r.id AND s.installation_id=r.installation_id AND s.owner_id=r.owner_id AND s.algorithm_version=$2)) ORDER BY r.registered_at,r.id LIMIT $3",[installation,PROJECTION_VERSION,limit])).rows,true);
   for(const row of ids)await store.indexReport(row.id);
   return ids.length;
  }
 };
 return store;
}
