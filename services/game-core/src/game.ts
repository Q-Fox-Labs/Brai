// ABOUTME: Исполняет последовательные Ходы game-core и сохраняет ресурсные снимки в одной транзакции.
// ABOUTME: Использует существующий транспорт GameCore; произвольные пользовательские SQL и файлы не принимаются.
import { randomUUID } from 'node:crypto';
import { assemble, baseline, digest, planningFiles, planningId } from './planning.js';
import type { Pool, PoolClient } from 'pg';
import { GameCoreFault } from './domain.js';
import type { GameCoreHandlers, GameCoreStore } from './domain.js';
import type { OperationContext } from './contracts.js';

type Value = Record<string, any>;
const fail = (code: 'INVALID_ARGUMENT'|'INVALID_STATE'|'NOT_FOUND'|'CONFLICT'|'FORBIDDEN') => { throw new GameCoreFault(code); };
const uuid = (v: any): string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v) ? v : fail('INVALID_ARGUMENT');
const text = (v: any, max = 20000): string => typeof v === 'string' && v.trim().length && v.length <= max ? v : fail('INVALID_ARGUMENT');
const object = (v: any): Value => v && typeof v === 'object' && !Array.isArray(v) ? v : fail('INVALID_ARGUMENT');
const list = (v: any): any[] => Array.isArray(v) && v.length <= 500 ? v : fail('INVALID_ARGUMENT');
const json = (v: any) => JSON.stringify(v);
async function one(c: PoolClient, owner: string, table: string, id: any): Promise<Value> {
 const r = (await c.query(`SELECT * FROM game_core.${table} WHERE owner_id=$1 AND id=$2`, [owner,uuid(id)])).rows[0];
 return r ?? fail('NOT_FOUND');
}
async function event(c: PoolClient, owner: string, type: string, id: string, data: Value, audit?: {id:string;kind:"element"|"move";actor:string}) {
 const eventId=audit?.id??randomUUID();
 const payload={event_id:eventId,event_version:1,event_type:type,occurred_at:new Date().toISOString(),owner_id:owner,actor:{kind:audit?'human':'system',id:audit?.actor??null},aggregate:{kind:audit?.kind??'move',id},data:{...data,history_category_code:'execution',history_type_code:'execute'}};
 await c.query('INSERT INTO game_core.outbox(id,owner_id,event_type,subject,payload) VALUES($1,$2,$3,$4,$5)',[eventId,owner,type,`brai.game-core.v1.events.${type}`,payload]);
}
async function availableInputs(c: PoolClient, owner: string, elementId: string): Promise<string[]> {
 // AIDEV-NOTE: Владелец постановки/приёмки не расширяет границу её целевого ребёнка.
 const r=await c.query(`SELECT resource_id AS id FROM game_core.element_resources WHERE owner_id=$1 AND element_id=$2 AND role='input'
 UNION SELECT r.id FROM game_core.resources r JOIN game_core.move_attempts a ON a.id=r.created_by_attempt_id JOIN game_core.moves m ON m.id=a.move_id WHERE r.owner_id=$1 AND m.target_element_id=$2 AND m.purpose NOT IN ('accept','finish') AND a.status='succeeded'
 UNION SELECT er.resource_id AS id FROM game_core.element_resources er JOIN game_core.elements e ON e.id=er.element_id WHERE er.owner_id=$1 AND er.role='output' AND (e.id=$2 OR e.parent_id=$2)`,[owner,elementId]);
 return r.rows.map(r=>r.id);
}
async function inputs(c: PoolClient, owner: string, move: Value): Promise<string[]> {
 if(move.previous_move_id) {
  const prev=await one(c,owner,'moves',move.previous_move_id);
  if(prev.status!=='succeeded')return fail('INVALID_STATE');
  if(!(await c.query("SELECT 1 FROM game_core.move_attempts WHERE owner_id=$1 AND move_id=$2 AND status='succeeded'",[owner,prev.id])).rowCount)return fail('INVALID_STATE');
 }
 return availableInputs(c,owner,move.purpose==='accept'||move.fields?.replanning_target?move.target_element_id:move.element_id);
}
const ids = (value: any): string[] => {const result=list(value??[]).map(uuid);if(new Set(result).size!==result.length)return fail('INVALID_ARGUMENT');return result;};
const sameIds = (a:string[],b:string[]) => a.length===b.length&&a.every(id=>b.includes(id));
async function requiredOutputs(c:PoolClient,owner:string,move:Value):Promise<string[]> {
 const result:string[]=[];
 for(const requirement of list(move.conditions.required_outputs??[])) {
  const producer=await one(c,owner,'moves',requirement.move_id);
  if(producer.target_element_id!==move.target_element_id&&producer.element_id!==move.element_id&&producer.element_id!==move.target_element_id)return fail('FORBIDDEN');
  const row=(await c.query(`SELECT r.id FROM game_core.resources r JOIN game_core.move_attempts a ON a.id=r.created_by_attempt_id
   WHERE r.owner_id=$1 AND a.move_id=$2 AND a.status='succeeded' AND r.metadata->>'output_key'=$3 AND r.metadata->>'plan_revision_id'=$4`,[owner,producer.id,requirement.output_key,requirement.revision_id])).rows;
  if(row.length!==1)return fail('INVALID_STATE');
  result.push(row[0].id);
 }
 return result;
}
async function latestDecision(c:PoolClient,owner:string,move:Value):Promise<Value|null>{
 const target=await one(c,owner,'elements',move.target_element_id);
 const row=(await c.query(`SELECT r.* FROM game_core.resources r JOIN game_core.move_attempts a ON a.id=r.created_by_attempt_id
 WHERE r.owner_id=$1 AND r.metadata->>'element_id'=$2 AND r.metadata->>'confirmed_by'=$1 AND a.status='succeeded' AND a.executor_kind='human'
 AND r.metadata->>'stage' IN ('final','review') AND r.metadata->>'outcome' IN ('success','changes')
 AND ($3::boolean OR r.metadata->>'revision_id'=$4) AND COALESCE(r.metadata->>'plan_scope','')=COALESCE($5,'')
 ORDER BY a.recorded_at DESC,r.id DESC LIMIT 1`,[owner,target.id,!move.fields?.planning,target.current_revision_id,move.fields?.planning?.scope??null])).rows[0];
 return row??null;
}
// AIDEV-NOTE: Автоматическое завершение создаёт только принятый сборщик; ручные Ходы не получают этот признак.
const needsDecision = (move:Value):boolean => (['finish','accept'].includes(move.purpose)||!!move.fields?.wait_decision)&&move.fields?.auto_finish!==true;
async function minimalInputs(c:PoolClient,owner:string,move:Value,available:string[]):Promise<string[]> {
 const required=[...ids(move.conditions.required_resources),...await requiredOutputs(c,owner,move)];
 const el=await one(c,owner,'elements',move.element_id);
 const decisions=[...list(move.conditions.decisions??[])];
 if((el.kind==='task'&&move.purpose==='work')||move.purpose==='start'&&!move.fields?.replanning_target)decisions.push({element_id:el.id,stage:'planning',outcome:'approved'});
 if(needsDecision(move)){const latest=await latestDecision(c,owner,move);if(!latest||latest.metadata.outcome!=='success')return fail('INVALID_STATE');required.push(latest.id);}
 for(const d of decisions){const target=await one(c,owner,'elements',d.element_id);const resource=(await c.query(`SELECT id FROM game_core.resources WHERE owner_id=$1 AND id=ANY($2::uuid[]) AND metadata->>'element_id'=$3 AND metadata->>'stage'=$4 AND metadata->>'outcome'=$5 AND metadata->>'confirmed_by'=$1 AND COALESCE(metadata->>'plan_scope','')=COALESCE($8,'') AND (metadata->>'revision_id'=$6 OR ($4<>'planning' AND $7)) ORDER BY id LIMIT 1`,[owner,available,d.element_id,d.stage,d.outcome??'success',target.current_revision_id,!move.fields?.planning,d.scope??null])).rows[0];if(!resource)return fail('INVALID_STATE');required.push(resource.id);}
 return [...new Set(required)];
}
async function ready(c: PoolClient, owner: string, move: Value, selected?: string[]): Promise<string[]> {
 if(move.status!=='planned'||move.fields?.executable===false) return fail('INVALID_STATE');
 const el=await one(c,owner,'elements',move.element_id);
 if(['completed','cancelled'].includes(el.status)) return fail('INVALID_STATE');
 const available=await inputs(c,owner,move);
 const ids=selected??available;
 if(ids.some(id=>!available.includes(id)))return fail('FORBIDDEN');
 const resources=ids.length?(await c.query('SELECT * FROM game_core.resources WHERE owner_id=$1 AND id=ANY($2::uuid[])',[owner,ids])).rows:[];
 const conditions=move.conditions;
 if((el.kind==='task'&&move.purpose==='work')||move.purpose==='start'&&!move.fields?.replanning_target) {
  if(!resources.some(r=>r.metadata.element_id===el.id&&r.metadata.stage==='planning'&&r.metadata.revision_id===el.current_revision_id&&r.metadata.outcome==='approved'&&r.metadata.confirmed_by===owner))return fail('INVALID_STATE');
 }
 if(['finish','accept'].includes(move.purpose)||move.purpose==='review'&&el.kind!=='task') {
  const open=(await c.query("SELECT 1 FROM game_core.elements WHERE owner_id=$1 AND parent_id=$2 AND status NOT IN ('completed','cancelled') LIMIT 1",[owner,move.target_element_id])).rowCount;
  if(open)return fail('INVALID_STATE');
 }

 for(const id of [...(conditions.required_resources??[]),...await requiredOutputs(c,owner,move)]) if(!ids.includes(id)) return fail('INVALID_STATE');
 for(const requirement of conditions.decisions??[]) {
  const target=await one(c,owner,'elements',requirement.element_id);
  if(!resources.some(r=>r.metadata.element_id===target.id && r.metadata.stage===requirement.stage && r.metadata.outcome===(requirement.outcome??'success') && (!move.fields?.planning&&requirement.stage!=='planning'||r.metadata.revision_id===target.current_revision_id) && r.metadata.confirmed_by===owner && (r.metadata.plan_scope??null)===(requirement.scope??null))) return fail('INVALID_STATE');
 }
 if(needsDecision(move)) {const latest=await latestDecision(c,owner,move);if(!latest||latest.metadata.outcome!=='success'||!ids.includes(latest.id))return fail('INVALID_STATE');}
 const busy=(await c.query("SELECT 1 FROM game_core.move_attempts a JOIN game_core.moves m ON m.id=a.move_id WHERE a.owner_id=$1 AND m.element_id=$2 AND a.status='running' AND ($3::boolean OR m.target_element_id=$4)",[owner,move.element_id,el.kind==='task',move.target_element_id])).rowCount;
 if(busy) return fail('CONFLICT');
 return ids;
}
/** Machine snapshots stay in PostgreSQL; graph carries cards and real results, packet exposes scoped rules. */
function publicFields(fields:Value):Value{
 const {planning_context,...visible}=fields??{};
 if(!fields?.planning)return visible;
 const {stage,criteria,expected_resources,...planning}=fields.planning;
 return {...visible,planning:{...planning,...(criteria?{criteria:criteria.map((r:Value)=>{const {quote,...criterion}=r;return criterion;})}:{})}};
}
function publicMoveFields(fields:Value):Value{const {id,owner,target,previous,status,purpose,instruction,title,...visible}=fields;return visible;}
function publicResult(result:Value|null,resourceIds:string[]):Value|null{if(!result)return result;const {resources,...visible}=result;const p=result.planning;return {...visible,...(resources?{resource_ids:resourceIds}:{}),...(p?{planning:{source_revision:p.source_revision,candidate_sha256:p.candidate_sha256,applied:p.applied}}:{})};}
async function graph(c: PoolClient, owner: string): Promise<Value> {
 const rows=async(table:string)=>(await c.query(`SELECT * FROM game_core.${table} WHERE owner_id=$1`,[owner])).rows;
 const [els,revs,mvs,ats,res,ars,ers]=await Promise.all(['elements','element_revisions','moves','move_attempts','resources','attempt_resources','element_resources'].map(rows));
 const elements=els!.map(e=>{const r=revs!.find(r=>r.id===e.current_revision_id)!; return {id:e.id,kind:e.kind,parentId:e.parent_id,status:e.status,revision:r.id,title:r.title,description:r.description,fields:publicFields(r.fields),provenance:e.provenance,input:ers!.filter(x=>x.element_id===e.id&&x.role==='input').map(x=>x.resource_id),output:ers!.filter(x=>x.element_id===e.id&&x.role==='output').map(x=>x.resource_id)};});
 const moves=mvs!.map(m=>{const a=ats!.filter(a=>a.move_id===m.id).sort((a,b)=>String(b.recorded_at).localeCompare(String(a.recorded_at)))[0]; return {id:m.id,ownerId:m.element_id,targetId:m.target_element_id,previousId:m.previous_move_id,kind:m.kind,title:m.title,status:m.status,attemptId:a?.id??'',executor:a?.executor_kind??(m.kind==='action'?'human':'agent'),instructions:m.instructions,conditions:m.conditions,fields:publicMoveFields(m.fields),purpose:m.purpose,input:a?ars!.filter(x=>x.attempt_id===a.id).map(x=>x.resource_id):[],output:a?res!.filter(x=>x.created_by_attempt_id===a.id).map(x=>x.id):[]};});
 return {elements,moves,resources:res!.map(r=>({id:r.id,attemptId:r.created_by_attempt_id,title:r.title,content:r.content,metadata:r.metadata,artifactIds:r.artifact_ids})),attempts:ats!.map(a=>({id:a.id,moveId:a.move_id,status:a.status,result:publicResult(a.result,res!.filter(r=>r.created_by_attempt_id===a.id).map(r=>r.id)),errorCode:a.error_code,startedAt:a.started_at,finishedAt:a.finished_at})),revisions:revs!.map(r=>({...r,fields:publicFields(r.fields)})),links:[]};
}
async function createElement(c:PoolClient,owner:string,v:Value) {
 const id=v.id?uuid(v.id):randomUUID(), revision=v.revision?uuid(v.revision):randomUUID();
 if(!['level','mission','quest','goal','task'].includes(v.kind)) return fail('INVALID_ARGUMENT');
 if(v.parent_id) {const parent=await one(c,owner,'elements',v.parent_id); if(({mission:'level',quest:'mission',goal:'quest',task:'goal'} as Value)[v.kind]!==parent.kind) return fail('INVALID_ARGUMENT');}
 await c.query('INSERT INTO game_core.elements(id,owner_id,kind,parent_id,current_revision_id) VALUES($1,$2,$3,$4,$5)',[id,owner,v.kind,v.parent_id??null,revision]);
 await c.query('INSERT INTO game_core.element_revisions(id,owner_id,element_id,revision,title,description,fields) VALUES($1,$2,$3,1,$4,$5,$6)',[revision,owner,id,text(v.title,1000),v.description??'',v.fields??v.result_spec??{}]);
 for(const resource of list(v.initial_resources??[])) {
  if(v.parent_id)return fail('INVALID_ARGUMENT');
  const metadata=object(resource.metadata??{});if(metadata.stage)return fail('FORBIDDEN');
  const rid=resource.id?uuid(resource.id):randomUUID();
  await c.query('INSERT INTO game_core.resources(id,owner_id,title,content,metadata) VALUES($1,$2,$3,$4,$5)',[rid,owner,text(resource.title,1000),text(resource.content),{...metadata,origin:'external_input'}]);
  await c.query("INSERT INTO game_core.element_resources VALUES($1,$2,$3,'input')",[owner,id,rid]);
 }
 return {id,revision};
}
async function createMove(c:PoolClient,owner:string,v:Value,fromPlanner=false) {
 if(v.fields?.auto_finish===true&&!fromPlanner)return fail('FORBIDDEN');
 const id=v.id?uuid(v.id):randomUUID();
 const element=await one(c,owner,'elements',v.element_id??v.ownerId);
 const target=await one(c,owner,'elements',v.target_element_id??v.targetId??element.id);
 if(['start','accept'].includes(v.purpose)){if(target.parent_id!==element.id)return fail('INVALID_ARGUMENT');}
 else if(target.id!==element.id)return fail('INVALID_ARGUMENT');
 const prev=v.previous_move_id??v.previousId??null;
 if(prev) await one(c,owner,'moves',prev);
 if(!['action','operation'].includes(v.kind)) return fail('INVALID_ARGUMENT');
 const conditions=object(v.conditions??{});
 for(const d of list(conditions.decisions??[])) {await one(c,owner,'elements',d.element_id);if(!['planning','final','review'].includes(d.stage)) return fail('INVALID_ARGUMENT');}
 for(const r of list(conditions.required_resources??[])) await one(c,owner,'resources',r);
 for(const r of list(conditions.required_outputs??[])){await one(c,owner,'moves',r.move_id);uuid(r.output_key);uuid(r.revision_id);}
 if(!['work','plan','start','accept','finish','confirm','review','final','expand','update','expand-repeat','collect'].includes(v.purpose??'work')) return fail('INVALID_ARGUMENT');
 if(['accept','finish','start','plan'].includes(v.purpose)&&v.kind!=='operation') return fail('INVALID_ARGUMENT');
 if(element.kind==='task') {
  const previousOwner=prev?(await one(c,owner,'moves',prev)).element_id:null;
  if(previousOwner!==element.id) {
   const root=(await c.query('SELECT 1 FROM game_core.moves m LEFT JOIN game_core.moves p ON p.id=m.previous_move_id WHERE m.owner_id=$1 AND m.element_id=$2 AND (p.id IS NULL OR p.element_id<>m.element_id) LIMIT 1',[owner,element.id])).rowCount;
   if(root&&(!prev||(await one(c,owner,'moves',prev)).fields?.pending_confirmation_id!==id))return fail('CONFLICT');
  }

  const sibling=(await c.query("SELECT 1 FROM game_core.moves WHERE owner_id=$1 AND element_id=$2 AND previous_move_id IS NOT DISTINCT FROM $3 AND status!='cancelled'",[owner,element.id,prev])).rowCount;
  if(sibling) return fail('CONFLICT');
 }
 await c.query('INSERT INTO game_core.moves(id,owner_id,element_id,target_element_id,previous_move_id,kind,purpose,title,instructions,fields,conditions) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[id,owner,element.id,v.target_element_id??v.targetId??element.id,prev,v.kind,v.purpose??'work',text(v.title,1000),v.instructions??'',v.fields??{},conditions]);
 return {id};
}
/** Собирает совместимые транспортные обработчики; все новые записи принадлежат game_core. */
export function createGameHandlers(pool:Pool, legacy:GameCoreStore, verifyArtifact?: (owner:string,id:string)=>Promise<void>, devStatusEnabled=false):GameCoreHandlers {
 async function run(operation:string,value:unknown,context?:OperationContext):Promise<any> {
  const v=object(value), owner=text(v.user_id,255);
  if(Buffer.byteLength(json(v))>262144) return fail('INVALID_ARGUMENT');
  const c=await pool.connect();
  try {
   await c.query('BEGIN');
   await c.query("SELECT set_config('statement_timeout','10000',true)");
   await c.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('game-core:maintenance',0))");
   await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`game-core:${owner}`]);
   if(context?.signal.aborted) throw new GameCoreFault('DEADLINE_EXCEEDED');
   let result:any;
   if(operation==='graph') result=await graph(c,owner);
   else if(operation==='element') {const g=await graph(c,owner);result=g.elements.find((x:Value)=>x.id===v.element_id)??fail('NOT_FOUND');}
   else if(operation==='timeline') {const q=await c.query('SELECT a.* FROM game_core.move_attempts a JOIN game_core.moves m ON m.id=a.move_id WHERE a.owner_id=$1 AND ($2::uuid IS NULL OR m.element_id=$2) ORDER BY a.recorded_at DESC LIMIT $3',[owner,v.element_id??null,Math.min(100,v.limit??50)]);result={items:q.rows,next_cursor:null};}
   else if(operation==='available') {const all=(await c.query("SELECT * FROM game_core.moves WHERE owner_id=$1 AND status='planned' AND ($2::uuid IS NULL OR element_id=$2)",[owner,v.element_id??null])).rows;const items=[];for(const m of all){try{const available=await ready(c,owner,m);items.push({...m,available_resource_ids:available,required_resource_ids:await minimalInputs(c,owner,m,available)});}catch(e){if(!(e instanceof GameCoreFault))throw e;}}result={items};}
   else if(operation==='reclassify') {
    const el=await one(c,owner,'elements',v.element_id),key=text(v.idempotency_key,255),kind=text(v.target_kind,10),reason=text(v.reason,4000);
    const prior=el.provenance?.classification;
    if(prior?.key===key){if(prior.kind!==kind||prior.source_revision!==v.expected_revision_id||prior.reason!==reason)return fail('CONFLICT');result={element_id:el.id,kind:el.kind,revision_id:el.current_revision_id};}
    else {
     if(!['task','goal','quest'].includes(kind))return fail('INVALID_ARGUMENT');
     if(uuid(v.expected_revision_id)!==el.current_revision_id)return fail('CONFLICT');
     if(el.parent_id||el.status!=='draft')return fail('INVALID_STATE');
     const rev=await one(c,owner,'element_revisions',el.current_revision_id);
     if(rev.fields?.planning||(await c.query('SELECT 1 FROM game_core.elements WHERE owner_id=$1 AND parent_id=$2',[owner,el.id])).rowCount)return fail('INVALID_STATE');
     const moves=(await c.query('SELECT * FROM game_core.moves WHERE owner_id=$1 AND (element_id=$2 OR target_element_id=$2)',[owner,el.id])).rows;
     if(moves.some(m=>!['plan','finish'].includes(m.purpose)||m.status==='succeeded'))return fail('INVALID_STATE');
     const attempts=(await c.query('SELECT a.* FROM game_core.move_attempts a JOIN game_core.moves m ON m.id=a.move_id WHERE a.owner_id=$1 AND m.target_element_id=$2',[owner,el.id])).rows;
     if(attempts.some(a=>a.result?.planning?.baseline||a.result?.planning?.candidate))return fail('CONFLICT');
     for(const a of attempts)if(a.result?.planning){const value={...a.result};delete value.planning;await c.query('UPDATE game_core.move_attempts SET result=$1 WHERE id=$2',[value,a.id]);}
     await c.query('UPDATE game_core.elements SET kind=$1,provenance=$2 WHERE id=$3',[kind,{...el.provenance,classification:{key,kind,previous_kind:el.kind,source_revision:el.current_revision_id,reason}},el.id]);
     result={element_id:el.id,kind,revision_id:el.current_revision_id};await event(c,owner,'element.classified',el.id,{...result,previous_kind:el.kind,reason});
    }
   }
   else if(['planningPacket','planningBind','planningBuild','planningApply'].includes(operation)) {
    const a=await one(c,owner,'move_attempts',v.attempt_id),m=await one(c,owner,'moves',a.move_id),el=await one(c,owner,'elements',m.target_element_id);
    if(m.kind!=='operation'||!['plan','start','expand','update'].includes(m.purpose)||!['task','goal','quest'].includes(el.kind)||a.executor_kind==='human')return fail('INVALID_STATE');
    const revision=await one(c,owner,'element_revisions',el.current_revision_id),segment=m.purpose==='expand';
    const selected=(await c.query('SELECT r.* FROM game_core.resources r JOIN game_core.attempt_resources ar ON ar.resource_id=r.id WHERE ar.owner_id=$1 AND ar.attempt_id=$2 ORDER BY r.id',[owner,a.id])).rows;
    const assigned=(await c.query("SELECT resource_id FROM game_core.element_resources WHERE owner_id=$1 AND element_id=$2 AND role='input' ORDER BY resource_id",[owner,el.id])).rows.map(r=>r.resource_id);
    const snapshot=digest({revision:revision.id,assigned,selected:selected.map(r=>({id:r.id,content:r.content,metadata:r.metadata}))});
    let state=a.result?.planning;
    if(operation==='planningApply'&&state?.applied){if(el.current_revision_id!==state.applied.revision_id||digest(assigned)!==state.assigned_digest)return fail('CONFLICT');if(state.apply_digest!==digest({candidate_sha256:v.candidate_sha256,review:v.review}))return fail('CONFLICT');result=state.applied;}
    else {
     if(a.status!=='running'||m.status!=='claimed')return fail('INVALID_STATE');
     if(state&&state.snapshot!==snapshot)return fail('CONFLICT');
     if(!state){
      if(a.result?.claim?.revision_id!==revision.id)return fail('CONFLICT');
      const finish=segment?[]:(await c.query("SELECT * FROM game_core.moves WHERE owner_id=$1 AND target_element_id=$2 AND purpose IN ('accept','finish') AND status!='cancelled'",[owner,el.id])).rows;
      if(finish.length>1)return fail('CONFLICT');
      const context=m.purpose==='start'&&!m.fields?.replanning_target?selected.filter(r=>assigned.includes(r.id)):selected;
      const files=planningFiles(el,revision,m,context,finish[0]??null);
      if(segment){const packet=JSON.parse(files['packet.json']);packet.finish={id:planningId(`${m.id}:continuation-finish`),owner:el.id,target:el.id};packet.element.parent=null;packet.operation.owner=el.id;packet.draft.outputs=[];packet.resources=packet.resources.filter((r:Value)=>r.state==='given');files['packet.json']=JSON.stringify(packet,null,2)+'\n';}
      state={snapshot,assigned_digest:digest(assigned),files,source_revision:revision.id};
     }
     if(operation==='planningPacket')result={baseline_id:baseline.id,files:state.files,source_revision:state.source_revision,element_kind:el.kind,inputs_sha256:state.snapshot};
     else if(operation==='planningBind') {
      if(state.candidate)return fail('CONFLICT');
      if(state.baseline&&digest(state.baseline)!==digest(v.baseline))return fail('CONFLICT');
      result=await assemble({files:state.files,baseline:object(v.baseline)});state.baseline=v.baseline;state.baseline_json=JSON.stringify(v.baseline);
     } else if(operation==='planningBuild') {
      if(!state.baseline)return fail('INVALID_STATE');
      result=await assemble({files:state.files,baseline:JSON.parse(state.baseline_json),candidate:object(v.candidate)});
      state.candidate=v.candidate;state.candidate_json=JSON.stringify(v.candidate);state.candidate_sha256=result.candidate_sha256;
     } else {
      if(!state.candidate||state.candidate_sha256!==v.candidate_sha256)return fail('CONFLICT');
      const built=await assemble({files:state.files,baseline:JSON.parse(state.baseline_json),candidate:JSON.parse(state.candidate_json),review:object(v.review)}),stage=built.stage;
      const rid=segment?revision.id:planningId(`${a.id}:${built.candidate_sha256}:revision`);
      const contracts=stage.resources.filter((r:Value)=>r.state==='expected');
      const contexts=Object.fromEntries(JSON.parse(state.files['packet.json']).context_files.map((key:string)=>[key,state.files[key]]));
      const producerRevision=async(producer:string)=>{if(producer===m.id||stage.records.some((r:Value)=>r.id===producer)||stage.finish.id===producer)return rid;const p=await one(c,owner,'moves',producer);return p.fields?.planning?.revision_id??rid;};
      const contract=(record:Value)=>({...record,planning:{revision_id:rid,baseline_id:baseline.id,decision:record.decision,scope:segment?m.id:null,
        output_contracts:(record.outputs??[]).map((key:string)=>{const r=contracts.find((x:Value)=>x.id===key);if(!r)return fail('INVALID_ARGUMENT');return {key,name:r.name,content:r.content};})}});
      const conditions=async(record:Value)=>({required_resources:record.inputs.filter((key:string)=>selected.some(r=>r.id===key)),
       required_outputs:await Promise.all(record.inputs.filter((key:string)=>!selected.some(r=>r.id===key)).map(async(key:string)=>{
        const r=contracts.find((x:Value)=>x.id===key);if(record.wait_decision&&r?.name==='Итоговое решение Игрока')return null;if(!r?.producer){if(record.wait_decision)return null;return fail('INVALID_ARGUMENT');}return {move_id:r.producer,output_key:key,revision_id:await producerRevision(r.producer)};})).then(xs=>xs.filter(Boolean)),
       decisions:record.requires_confirmation?[{element_id:el.id,stage:'planning',outcome:'approved',scope:segment?m.id:null}]:[]});
      const segmentSuccessors=segment?(await c.query("SELECT id FROM game_core.moves WHERE owner_id=$1 AND previous_move_id=$2 AND status='planned'",[owner,m.id])).rows.map(r=>r.id):[];
      if(segmentSuccessors.length)await c.query('UPDATE game_core.moves SET previous_move_id=NULL WHERE owner_id=$1 AND id=ANY($2::uuid[])',[owner,segmentSuccessors]);
      const existingEnd=(await c.query('SELECT * FROM game_core.moves WHERE owner_id=$1 AND id=$2',[owner,stage.finish.id])).rows[0];
      if(existingEnd){if(existingEnd.target_element_id!==el.id||existingEnd.element_id!==stage.finish.owner||existingEnd.status!=='planned')return fail('CONFLICT');await c.query('UPDATE game_core.moves SET previous_move_id=NULL WHERE id=$1',[existingEnd.id]);}
      if(!segment){
       await c.query('INSERT INTO game_core.element_revisions(id,owner_id,element_id,revision,title,description,fields,created_by_attempt_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[rid,owner,el.id,revision.revision+1,stage.element.fields.title||revision.title,stage.element.fields.summary,{...stage.element.fields,planning_context:{...revision.fields.planning_context,files:contexts},planning:{baseline_id:baseline.id,source_revision:revision.id,expected_resources:contracts,chain:stage.chain,stage,notes:v.review.notes??[],criteria:state.baseline.requirements}},a.id]);
       await c.query('UPDATE game_core.elements SET current_revision_id=$1 WHERE owner_id=$2 AND id=$3',[rid,owner,el.id]);
      }
      // Parent operations remain shared UUIDs. Only selected child contracts cross the boundary.
      for(const child of stage.children){
       const id=child.element.id,childRevision=planningId(`${id}:draft`);
       await createElement(c,owner,{id,revision:childRevision,kind:({Задача:'task',Цель:'goal',Квест:'quest'} as Value)[child.element.kind],parent_id:el.id,title:child.draft.title,description:child.draft.summary,fields:{draft:child.draft,planning_context:{files:contexts,outputs:child.resources.filter((r:Value)=>child.draft.outputs.includes(r.id))}}});
       for(const input of child.draft.inputs)if(selected.some(r=>r.id===input))await c.query("INSERT INTO game_core.element_resources VALUES($1,$2,$3,'input') ON CONFLICT DO NOTHING",[owner,id,input]);
      }
      const records=[...stage.records];if(!stage.awaiting_clarification&&!records.some((r:Value)=>r.id===stage.finish.id))records.push(stage.finish);
      const confirm=records.find((r:Value)=>r.purpose==='confirm');
      for(const record of records){
       let purpose=record.id===stage.finish.id?(segment?'collect':el.parent_id?'accept':'finish'):record.purpose;
       if(purpose==='plan'&&record.target!==el.id)purpose='start';
       // Upper levels order only approval and actual dependencies; child internals have their own chain.
       let previous=record.previous;
       if(el.kind!=='task'&&purpose==='start')previous=confirm.id;
       if(el.kind!=='task'&&purpose==='accept'&&record.target!==el.id)previous=stage.children.find((x:Value)=>x.element.id===record.target)?.operation.id??previous;
       if(el.kind!=='task'&&purpose==='review')previous=confirm.id;
       const fields:Value=contract(record);if(purpose==='start')fields.planning.child_inputs=stage.children.find((x:Value)=>x.element.id===record.target).draft.inputs;
       const draft={id:record.id,element_id:record.owner,target_element_id:record.target,previous_move_id:previous,kind:record.actor==='player'?'action':'operation',purpose,title:record.title,instructions:record.instruction??'',fields,conditions:await conditions(record)};
       if(existingEnd&&record.id===existingEnd.id)await c.query('UPDATE game_core.moves SET previous_move_id=$1,title=$2,instructions=$3,fields=$4,conditions=$5 WHERE id=$6',[draft.previous_move_id,draft.title,draft.instructions,draft.fields,draft.conditions,existingEnd.id]);
       else {const pending=(await c.query('SELECT * FROM game_core.moves WHERE owner_id=$1 AND id=$2',[owner,draft.id])).rows[0];if(pending&&draft.id===m.fields?.pending_confirmation_id&&pending.status==='planned')await c.query('UPDATE game_core.moves SET previous_move_id=$1,title=$2,instructions=$3,fields=$4,conditions=$5 WHERE id=$6',[draft.previous_move_id,draft.title,draft.instructions,draft.fields,draft.conditions,draft.id]);else await createMove(c,owner,draft,true);}
      }
      // Child acceptance preserves its output UUIDs but now produces them in the child's actual revision.
      if(existingEnd){const consumers=(await c.query("SELECT * FROM game_core.moves WHERE owner_id=$1 AND status='planned'",[owner])).rows;for(const consumer of consumers){let changed=false;const outputs=(consumer.conditions.required_outputs??[]).map((r:Value)=>{if(r.move_id===existingEnd.id){changed=true;return {...r,revision_id:rid};}return r;});if(changed)await c.query('UPDATE game_core.moves SET conditions=$1 WHERE id=$2',[{...consumer.conditions,required_outputs:outputs},consumer.id]);}}
      if(segment){
       await c.query('UPDATE game_core.moves SET previous_move_id=$1 WHERE owner_id=$2 AND id=ANY($3::uuid[])',[stage.finish.id,owner,segmentSuccessors]);
       const consumers=(await c.query("SELECT * FROM game_core.moves WHERE owner_id=$1 AND target_element_id=$2 AND status='planned' AND purpose IN ('review','finish','accept') AND id<>ALL($3::uuid[])",[owner,el.id,records.map((r:Value)=>r.id)])).rows;
       for(const consumer of consumers)await c.query('UPDATE game_core.moves SET conditions=$1 WHERE id=$2',[{...consumer.conditions,required_outputs:[...(consumer.conditions.required_outputs??[]),...stage.finish.outputs.map((id:string)=>({move_id:stage.finish.id,output_key:id,revision_id:rid}))]},consumer.id]);
      }
      const planContract=contracts.find((r:Value)=>r.producer===m.id);if(!planContract)return fail('INVALID_ARGUMENT');
      const resourceId=randomUUID();
      await c.query('INSERT INTO game_core.resources(id,owner_id,created_by_attempt_id,title,content,metadata) VALUES($1,$2,$3,$4,$5,$6)',[resourceId,owner,a.id,'Постановка и план Ходов',built.markdown,{output_key:planContract.id,plan_revision_id:rid,baseline_id:baseline.id,receipt:built.receipt,review:v.review}]);
      result={element_id:el.id,revision_id:rid,operation_id:m.id,resource_id:resourceId,move_ids:records.map((r:Value)=>r.id),child_ids:stage.children.map((x:Value)=>x.element.id),awaiting_clarification:stage.awaiting_clarification??false,receipt:built.receipt};
      state.applied=result;state.stage=stage;state.apply_digest=digest({candidate_sha256:v.candidate_sha256,review:v.review});
      await c.query("UPDATE game_core.moves SET status='succeeded' WHERE id=$1",[m.id]);
      await c.query("UPDATE game_core.move_attempts SET status='succeeded',finished_at=now() WHERE id=$1",[a.id]);
      await event(c,owner,'plan.applied',m.id,{attempt_id:a.id,element_id:el.id,revision_id:rid,resource_ids:[resourceId],move_ids:result.move_ids,child_ids:result.child_ids,baseline_id:baseline.id});
     }
     await c.query('UPDATE game_core.move_attempts SET result=$1 WHERE id=$2',[{...a.result,planning:state},a.id]);
    }
   }
   else if(operation==='expandRepeat') {
    const m=await one(c,owner,'moves',v.move_id),el=await one(c,owner,'elements',m.target_element_id),key=text(v.idempotency_key,255);
    const replay=m.fields?.repeat_expansion;
    if(replay){if(replay.key!==key||replay.digest!==digest({revision_id:v.revision_id,resource_id:v.resource_id,items:v.items}))return fail('CONFLICT');result=replay.result;}
    else{
     if(uuid(v.revision_id)!==el.current_revision_id)return fail('CONFLICT');
     if(m.purpose!=='expand-repeat'||m.status!=='planned'||m.fields?.executable!==false)return fail('INVALID_STATE');
     const available=await inputs(c,owner,m),needed=await minimalInputs(c,owner,m,available);
     const resource=await one(c,owner,'resources',v.resource_id);
     if(!needed.includes(resource.id))return fail('FORBIDDEN');
     const reference=m.fields.repeat_over;
     if(reference!==resource.id&&!((m.conditions.required_outputs??[]).some((r:Value)=>r.output_key===reference)&&resource.metadata.output_key===reference))return fail('INVALID_ARGUMENT');
     let actual;try{actual=JSON.parse(resource.content);}catch{return fail('INVALID_ARGUMENT');}
     if(digest(actual.items??actual)!==digest(list(v.items)))return fail('CONFLICT');
     const source=(await c.query("SELECT result FROM game_core.move_attempts WHERE owner_id=$1 AND status='succeeded' AND result->'planning'->'stage' IS NOT NULL ORDER BY recorded_at DESC",[owner])).rows.find(r=>r.result.planning.stage.records.some((x:Value)=>x.id===m.id));
     if(!source)return fail('INVALID_STATE');
     const expanded=await assemble({expand_stage:source.result.planning.stage,move_id:m.id,binding:{resource:reference,items:v.items}}),stage=expanded.stage;
     const inserted=stage.records.filter((r:Value)=>r.item),marker=stage.records.find((r:Value)=>r.id===m.id),contracts=stage.resources.filter((r:Value)=>r.state==='expected');
     const conditions=(record:Value)=>({required_resources:record.inputs.filter((id:string)=>!contracts.some((r:Value)=>r.id===id)),required_outputs:record.inputs.filter((id:string)=>contracts.some((r:Value)=>r.id===id)).map((id:string)=>{const r=contracts.find((r:Value)=>r.id===id);return {move_id:r.producer,output_key:id,revision_id:el.current_revision_id};}),decisions:m.conditions.decisions??[]});
     await c.query('UPDATE game_core.moves SET previous_move_id=NULL WHERE id=$1',[m.id]);
     for(const record of inserted)await createMove(c,owner,{id:record.id,element_id:m.element_id,kind:record.actor==='player'?'action':'operation',purpose:'work',previous_move_id:record.previous,title:record.title,instructions:record.instruction,fields:{...record,planning:{...m.fields.planning,decision:null,output_contracts:record.outputs.map((id:string)=>{const r=contracts.find((r:Value)=>r.id===id);return {key:id,name:r.name,content:r.content};})}},conditions:conditions(record)});
     result={move_id:m.id,inserted_move_ids:inserted.map((r:Value)=>r.id),item_ids:v.items.map((r:Value)=>r.id)};
     const fields={...m.fields,...marker,planning:m.fields.planning,repeat_expansion:{key,digest:digest({revision_id:v.revision_id,resource_id:v.resource_id,items:v.items}),result}};
     await c.query("UPDATE game_core.moves SET purpose='collect',previous_move_id=$1,fields=$2,conditions=$3 WHERE id=$4",[marker.previous,fields,conditions(marker),m.id]);
     await event(c,owner,'repeat.expanded',m.id,result);
    }
   }
   else if(operation==='devStatus') {
    if(!devStatusEnabled)return fail('FORBIDDEN');
    if(!['element','move'].includes(v.kind))return fail('INVALID_ARGUMENT');
    const allowed=v.kind==='element'?['draft','active','completed','cancelled']:['planned','claimed','succeeded','cancelled'];
    if(!allowed.includes(v.status))return fail('INVALID_ARGUMENT');
    const id=uuid(v.id),requestId=uuid(v.request_id),type=v.kind+'.status_overridden';
    const row=await one(c,owner,v.kind==='element'?'elements':'moves',id);
    const prior=(await c.query('SELECT payload FROM game_core.outbox WHERE owner_id=$1 AND id=$2',[owner,requestId])).rows[0]?.payload;
    if(prior){
     if(prior.event_type!==type||prior.aggregate.kind!==v.kind||prior.aggregate.id!==id||prior.data.status!==v.status)return fail('CONFLICT');
     result={id,status:prior.data.status,event_id:requestId,changed:prior.data.previous_status!==prior.data.status};
    }else{
     // AIDEV-NOTE: Ручной DEV статус не создаёт свидетельств исполнения и не меняет ресурсы, попытки или outcome.
     await c.query(`UPDATE game_core.${v.kind==='element'?'elements':'moves'} SET status=$1 WHERE owner_id=$2 AND id=$3`,[v.status,owner,id]);
     await event(c,owner,type,id,{manual:true,environment:'dev',reason:'manual_test_status',previous_status:row.status,status:v.status,request_id:requestId},{id:requestId,kind:v.kind,actor:owner});
     result={id,status:v.status,event_id:requestId,changed:row.status!==v.status};
    }
   }
   else if(operation==='skipResultReview') {
    const review=await one(c,owner,'moves',v.move_id),target=await one(c,owner,'elements',review.target_element_id);
    if(uuid(v.revision_id)!==target.current_revision_id)return fail('CONFLICT');
    const revision=await one(c,owner,'element_revisions',target.current_revision_id);
    if(!Array.isArray(revision.fields?.result_types)||revision.fields.result_types.length!==1||revision.fields.result_types[0]!=='Артефакт')return fail('FORBIDDEN');
    const already=(await c.query("SELECT * FROM game_core.moves WHERE owner_id=$1 AND target_element_id=$2 AND fields->>'skipped_review_id'=$3",[owner,target.id,review.id])).rows;
    if(review.status==='cancelled'&&already.length===1){result={review_id:review.id,finish_id:already[0].id};}
    else {
     if(target.status!=='active'||review.status!=='planned'||review.kind!=='action'||review.purpose!=='review'||review.fields?.planning?.decision!=='final'||review.fields.planning.revision_id!==target.current_revision_id)return fail('INVALID_STATE');
     await ready(c,owner,review);
     const sourceOutputs=await requiredOutputs(c,owner,review);
     if(!sourceOutputs.length)return fail('INVALID_STATE');
     const next=(await c.query("SELECT * FROM game_core.moves WHERE owner_id=$1 AND previous_move_id=$2 AND status='planned'",[owner,review.id])).rows;
     if(next.length!==1||!['accept','finish'].includes(next[0].purpose)||next[0].target_element_id!==target.id)return fail('INVALID_STATE');
     const finish=next[0],outputs=[...(finish.conditions.required_outputs??[]).filter((item:Value)=>item.move_id!==review.id),...(review.conditions.required_outputs??[])];
     const unique=(items:Value[])=>[...new Map(items.map(item=>[json(item),item])).values()];
     const conditions={...finish.conditions,required_resources:[...new Set([...(finish.conditions.required_resources??[]),...(review.conditions.required_resources??[])])],required_outputs:unique(outputs),decisions:unique([...(finish.conditions.decisions??[]),...(review.conditions.decisions??[])])};
     const fields={...finish.fields,auto_finish:true,skipped_review_id:review.id};delete fields.wait_decision;
     await c.query("UPDATE game_core.moves SET status='cancelled' WHERE owner_id=$1 AND id=$2",[owner,review.id]);
     await c.query('UPDATE game_core.moves SET previous_move_id=$1,fields=$2,conditions=$3,title=$4,instructions=$5 WHERE owner_id=$6 AND id=$7',[review.previous_move_id,fields,conditions,'Завершить: '+revision.title,'Сохранить готовый результат и передать его пользователю штатным каналом.',owner,finish.id]);
     result={review_id:review.id,finish_id:finish.id};
     await event(c,owner,'move.result_review_skipped',review.id,{finish_id:finish.id,revision_id:target.current_revision_id});
    }
   }
   else if(operation==='create') {
    if(!Array.isArray(v.elements)||!Array.isArray(v.moves)) return fail('INVALID_ARGUMENT');
    const elements=[];for(const e of list(v.elements)) elements.push(await createElement(c,owner,e));
    const moves=[];for(const m of list(v.moves)) moves.push(await createMove(c,owner,m));
    result={elements,moves};await event(c,owner,'structure.created',elements[0]?.id??moves[0]?.id??randomUUID(),{element_ids:elements.map(e=>e.id),move_ids:moves.map(m=>m.id)});
   } else if(operation==='elementCreate') {result=await createElement(c,owner,v);await event(c,owner,'element.created',result.id,{});}
   else if(operation==='moveCreate') {result=await createMove(c,owner,v);await event(c,owner,'move.created',result.id,{});}
   else if(operation==='revise') {
    const el=await one(c,owner,'elements',v.element_id);if(el.status==='completed'||el.status==='cancelled')return fail('INVALID_STATE');
    const prev=await one(c,owner,'element_revisions',el.current_revision_id); const id=v.revision_id?uuid(v.revision_id):fail('INVALID_ARGUMENT');
    const existing=(await c.query('SELECT * FROM game_core.element_revisions WHERE owner_id=$1 AND id=$2',[owner,id])).rows[0];
    if(existing){if(existing.element_id!==el.id||existing.title!==v.title) return fail('CONFLICT');await c.query('COMMIT');return {id,element_id:el.id};}
    await c.query('INSERT INTO game_core.element_revisions(id,owner_id,element_id,revision,title,description,fields) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,owner,el.id,prev.revision+1,text(v.title,1000),v.description??'',v.fields??v.result_spec??{}]);
    await c.query('UPDATE game_core.elements SET current_revision_id=$1 WHERE id=$2',[id,el.id]);result={id,element_id:el.id};await event(c,owner,'element.revised',el.id,{revision_id:id});
   } else if(operation==='activate' && v.cancel===true) {
    const el=await one(c,owner,'elements',v.element_id);
    const feedback=v.feedback===undefined?null:object(v.feedback);
    const requestId=feedback?uuid(feedback.id):null;
    const requestDigest=feedback?digest({element_id:el.id,revision_id:v.revision_id,feedback}):null;
    const prior=requestId?(await c.query('SELECT payload FROM game_core.outbox WHERE owner_id=$1 AND id=$2',[owner,requestId])).rows[0]?.payload:null;
    if(prior){if(prior.event_type!=='element.cancelled'||prior.aggregate.id!==el.id||prior.data.request_digest!==requestDigest)return fail('CONFLICT');await c.query('COMMIT');return prior.data.result;}
    if(el.status==='completed')return fail('INVALID_STATE');
    if(v.revision_id!==undefined&&uuid(v.revision_id)!==el.current_revision_id)return fail('CONFLICT');
    if(feedback){
     if(!v.revision_id)return fail('INVALID_ARGUMENT');
     text(feedback.content,16000);object(feedback.source);
    }
    const descendants=(await c.query('WITH RECURSIVE tree AS (SELECT id FROM game_core.elements WHERE owner_id=$1 AND id=$2 UNION ALL SELECT e.id FROM game_core.elements e JOIN tree t ON e.parent_id=t.id WHERE e.owner_id=$1) SELECT id FROM tree',[owner,el.id])).rows.map(r=>r.id);
    await c.query("UPDATE game_core.elements SET status='cancelled',outcome='cancelled' WHERE owner_id=$1 AND id=ANY($2::uuid[]) AND status!='completed'",[owner,descendants]);
    await c.query("UPDATE game_core.move_attempts SET status='failed',error_code='CANCELLED',finished_at=now() WHERE owner_id=$1 AND status='running' AND move_id IN (SELECT id FROM game_core.moves WHERE owner_id=$1 AND (element_id=ANY($2::uuid[]) OR target_element_id=ANY($2::uuid[])))",[owner,descendants]);
    await c.query("UPDATE game_core.moves SET status='cancelled' WHERE owner_id=$1 AND (element_id=ANY($2::uuid[]) OR target_element_id=ANY($2::uuid[])) AND status!='succeeded'",[owner,descendants]);
    result={id:el.id,status:'cancelled',element_ids:descendants};
    if(feedback){
     await c.query('INSERT INTO game_core.resources(id,owner_id,title,content,metadata) VALUES($1,$2,$3,$4,$5)',[requestId,owner,'Отмена по сообщению Игрока',feedback.content,{origin:'human_message',element_id:el.id,revision_id:el.current_revision_id,outcome:'cancelled',source:feedback.source}]);
     await c.query("INSERT INTO game_core.element_resources VALUES($1,$2,$3,'input')",[owner,el.id,requestId]);
    }
    await event(c,owner,'element.cancelled',el.id,{request_digest:requestDigest,result},feedback?{id:requestId!,kind:'element',actor:owner}:undefined);
   } else if(operation==='activate') {const el=await one(c,owner,'elements',v.element_id);if(el.status!=='draft')return fail('INVALID_STATE');await c.query("UPDATE game_core.elements SET status='active' WHERE id=$1",[el.id]);result={id:el.id,status:'active'};await event(c,owner,'element.activated',el.id,{});}
   else if(operation==='claim') {
    const m=await one(c,owner,'moves',v.move_id),key=text(v.idempotency_key,255);
    if(v.input!==undefined||!Array.isArray(v.input_resource_ids))return fail('INVALID_ARGUMENT');
    const selected=ids(v.input_resource_ids),transferred=ids(v.target_input_resource_ids);
    if(transferred.length&&(m.purpose!=='start'||transferred.some(id=>!selected.includes(id))))return fail('INVALID_ARGUMENT');
    const prior=(await c.query('SELECT * FROM game_core.move_attempts WHERE owner_id=$1 AND move_id=$2 AND idempotency_key=$3',[owner,m.id,key])).rows[0];
    if(prior) {
     const old=(await c.query('SELECT resource_id FROM game_core.attempt_resources WHERE owner_id=$1 AND attempt_id=$2',[owner,prior.id])).rows.map(r=>r.resource_id);
     if(!sameIds(old,selected)||!sameIds(prior.result?.claim?.target_input_resource_ids??[],transferred)||prior.executor_kind!==v.executor_kind)return fail('CONFLICT');
     result={attempt:prior,input:old};
    } else {
     if(!['human','agent','system'].includes(v.executor_kind))return fail('INVALID_ARGUMENT');
     if((m.kind==='action')!==(v.executor_kind==='human'))return fail('FORBIDDEN');
     const chosen=await ready(c,owner,m,selected),id=v.attempt_id?uuid(v.attempt_id):randomUUID();
     await c.query("INSERT INTO game_core.move_attempts(id,owner_id,move_id,executor_kind,executor_id,idempotency_key,status,started_at) VALUES($1,$2,$3,$4,$5,$6,'running',now())",[id,owner,m.id,v.executor_kind,v.executor_kind==='human'?owner:(v.executor_id??null),key]);
     for(const r of chosen)await c.query('INSERT INTO game_core.attempt_resources VALUES($1,$2,$3)',[owner,id,r]);
     await c.query("UPDATE game_core.moves SET status='claimed' WHERE id=$1",[m.id]);
     await c.query('UPDATE game_core.move_attempts SET result=$1 WHERE id=$2',[{claim:{input_resource_ids:chosen,target_input_resource_ids:transferred,revision_id:(await one(c,owner,'elements',m.target_element_id)).current_revision_id}},id]);
     if(m.purpose==='start'&&m.fields?.planning?.child_inputs){const declared:string[]=[];const childInputs=ids(m.fields.planning.child_inputs);for(const key of childInputs){let actual=selected.includes(key)?key:null;if(!actual){const ref=(m.conditions.required_outputs??[]).find((r:Value)=>r.output_key===key);if(!ref)return fail('INVALID_STATE');const producer=await one(c,owner,'moves',ref.move_id);actual=(await requiredOutputs(c,owner,{...m,conditions:{required_outputs:[ref]}}))[0];}if(!selected.includes(actual!))return fail('INVALID_STATE');declared.push(actual!);await c.query("INSERT INTO game_core.element_resources VALUES($1,$2,$3,'input') ON CONFLICT DO NOTHING",[owner,m.target_element_id,actual]);}if(transferred.some(id=>!declared.includes(id)))return fail('FORBIDDEN');}
     if(m.purpose==='start')for(const r of transferred)await c.query("INSERT INTO game_core.element_resources VALUES($1,$2,$3,'input') ON CONFLICT DO NOTHING",[owner,m.target_element_id,r]);
     result={attempt:await one(c,owner,'move_attempts',id),input:chosen};await event(c,owner,'move.claimed',m.id,{attempt_id:id});
    }
   } else if(operation==='complete') {
    const a=await one(c,owner,'move_attempts',v.attempt_id),m=await one(c,owner,'moves',a.move_id);
    if(a.status==='succeeded') result={attempt:a};else {
     if(a.status!=='running'||m.status!=='claimed'||['completed','cancelled'].includes((await one(c,owner,'elements',m.target_element_id)).status))return fail('INVALID_STATE');
     const body:Value={...object(v.result??{}),claim:a.result?.claim};const outputs:string[]=[];
     const planning=m.fields?.planning,expected=list(planning?.output_contracts??[]),seen=new Set<string>();
     if(planning&&(await one(c,owner,'elements',m.target_element_id)).current_revision_id!==planning.revision_id)return fail('CONFLICT');
     if(needsDecision(m)){const latest=await latestDecision(c,owner,m);if(!latest||latest.metadata.outcome!=='success'||!(await c.query('SELECT 1 FROM game_core.attempt_resources WHERE owner_id=$1 AND attempt_id=$2 AND resource_id=$3',[owner,a.id,latest.id])).rowCount)return fail('INVALID_STATE');}
     if(['plan','start','update','expand','expand-repeat'].includes(m.purpose)&&planning||m.purpose==='plan')return fail('FORBIDDEN');
     for(const r of list(body.resources??[])) {
      // AIDEV-NOTE: Файлы принадлежат Artifacts. Этот текстовый API не выдаёт непроверенные ссылки.
      const artifactIds=list(r.artifact_ids??[]).map(uuid);
      for(const artifactId of artifactIds){if(!verifyArtifact)return fail('FORBIDDEN');await verifyArtifact(owner,artifactId);}
      const id=r.id?uuid(r.id):randomUUID(),metadata={...object(r.metadata??{})};
      if(planning){
       const key=r.output_key??(expected.length===1?expected[0].key:undefined);
       if(!expected.some((x:Value)=>x.key===key)||seen.has(key))return fail('INVALID_ARGUMENT');seen.add(key);
       metadata.output_key=key;metadata.plan_revision_id=planning.revision_id;
       const decision=planning.decision;
       const isDecision=key===expected[expected.length-1]?.key&&decision;
       if(isDecision&&!metadata.stage)return fail('INVALID_ARGUMENT');
       if(isDecision&&!(decision==='clarify'?(metadata.stage==='clarification'&&metadata.outcome==='answered'):decision==='confirm'?(metadata.stage==='planning'&&metadata.outcome==='approved'||metadata.stage==='review'&&metadata.outcome==='changes'):(metadata.stage==='final'&&metadata.outcome==='success'||metadata.stage==='review'&&metadata.outcome==='changes')))return fail('INVALID_ARGUMENT');
       if(metadata.stage&&!isDecision)return fail('INVALID_ARGUMENT');
       if(isDecision&&planning.scope)metadata.plan_scope=planning.scope;
      }
      if(metadata.stage) {
       if(a.executor_kind!=='human')return fail('FORBIDDEN');
       if(metadata.element_id!==m.target_element_id)return fail('INVALID_ARGUMENT');
       if(!['planning','final','review','clarification'].includes(metadata.stage))return fail('INVALID_ARGUMENT');
       if(metadata.stage==='planning'||planning) {const target=await one(c,owner,'elements',m.target_element_id);if(metadata.revision_id!==target.current_revision_id||a.result?.claim?.revision_id!==target.current_revision_id)return fail('CONFLICT');}
       if(!['approved','success','changes','cancelled','answered'].includes(metadata.outcome))return fail('INVALID_ARGUMENT');
       metadata.confirmed_by=owner;
       if(metadata.stage==='planning'&&metadata.outcome==='approved')await c.query("UPDATE game_core.elements SET status='active' WHERE owner_id=$1 AND id=$2 AND status='draft'",[owner,m.target_element_id]);
      }
      await c.query('INSERT INTO game_core.resources(id,owner_id,created_by_attempt_id,title,content,metadata,artifact_ids) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,owner,a.id,text(r.title,1000),text(r.content),metadata,artifactIds]);outputs.push(id);
     }
     if(expected.length!==seen.size)return fail('INVALID_ARGUMENT');
     if(['accept','finish'].includes(m.purpose)) {
      if(!outputs.length)return fail('INVALID_ARGUMENT');
      await c.query("UPDATE game_core.elements SET status='completed',outcome='success' WHERE id=$1",[m.target_element_id]);
      for(const r of outputs)await c.query("INSERT INTO game_core.element_resources VALUES($1,$2,$3,'output')",[owner,m.target_element_id,r]);
     }
     await c.query("UPDATE game_core.move_attempts SET status='succeeded',result=$1,finished_at=now() WHERE id=$2",[body,a.id]);
     await c.query("UPDATE game_core.moves SET status='succeeded' WHERE id=$1",[m.id]);
     if(planning?.decision==='confirm'&&a.executor_kind==='human'&&body.resources.some((r:Value)=>r.metadata?.stage==='review'&&r.metadata?.outcome==='changes')) {
      const ends=(await c.query("SELECT * FROM game_core.moves WHERE owner_id=$1 AND target_element_id=$2 AND purpose IN ('accept','finish') AND status='planned'",[owner,m.target_element_id])).rows;
      if(ends.length!==1)return fail('INVALID_STATE');
      const end=ends[0],fixId=planningId(`${a.id}:replan`),confirmId=planningId(`${a.id}:reconfirm`);
      // Старые невыполненные Ходы остаются в истории; финальную общую Операцию переиспользуем.
      await c.query("UPDATE game_core.moves SET status='cancelled' WHERE owner_id=$1 AND target_element_id=$2 AND status='planned' AND id<>$3",[owner,m.target_element_id,end.id]);
      const descendants=(await c.query('WITH RECURSIVE tree AS (SELECT id FROM game_core.elements WHERE owner_id=$1 AND parent_id=$2 UNION ALL SELECT e.id FROM game_core.elements e JOIN tree t ON e.parent_id=t.id WHERE e.owner_id=$1) SELECT id FROM tree',[owner,m.target_element_id])).rows.map(r=>r.id);
      if(descendants.length){await c.query("UPDATE game_core.elements SET status='cancelled',outcome='superseded_plan' WHERE owner_id=$1 AND id=ANY($2::uuid[]) AND status='draft'",[owner,descendants]);await c.query("UPDATE game_core.moves SET status='cancelled' WHERE owner_id=$1 AND status='planned' AND (element_id=ANY($2::uuid[]) OR target_element_id=ANY($2::uuid[]))",[owner,descendants]);}
      await c.query('UPDATE game_core.moves SET previous_move_id=NULL WHERE id=$1',[end.id]);
      await createMove(c,owner,{id:fixId,element_id:end.element_id,target_element_id:m.target_element_id,previous_move_id:m.id,kind:'operation',purpose:end.element_id===m.target_element_id?'plan':'start',title:'Доработать постановку по замечаниям',fields:{pending_confirmation_id:confirmId,replanning_target:true},instructions:'Прочитать исходное поручение, текущий план и замечания Игрока. Применить планировщик к новой постановке. Повторное подтверждение обязательно.',conditions:{required_resources:await availableInputs(c,owner,m.target_element_id)}});
      await createMove(c,owner,{id:confirmId,element_id:m.target_element_id,previous_move_id:fixId,kind:'action',purpose:'confirm',title:'Рассмотреть новую постановку',instructions:'Дождаться новой проверенной постановки и отдельно подтвердить её.'});
      await c.query('UPDATE game_core.moves SET previous_move_id=$1 WHERE id=$2',[confirmId,end.id]);
      await event(c,owner,'plan.changes_requested',m.id,{attempt_id:a.id,resource_ids:outputs,planning_move_id:fixId});
     }
     if(planning?.decision==='final'&&a.executor_kind==='human'&&body.resources.some((r:Value)=>r.metadata?.stage==='review'&&r.metadata?.outcome==='changes')) {
      const next=(await c.query("SELECT * FROM game_core.moves WHERE owner_id=$1 AND previous_move_id=$2 AND status='planned'",[owner,m.id])).rows;
      if(next.length!==1)return fail('INVALID_STATE');
      const continuation=next[0],fixId=planningId(`${a.id}:fix`),reviewId=planningId(`${a.id}:review`),fixKey=planningId(`${a.id}:fixed-result`),decisionKey=planningId(`${a.id}:decision`);
      await c.query('UPDATE game_core.moves SET previous_move_id=NULL WHERE id=$1',[continuation.id]);
      const required=await requiredOutputs(c,owner,m);
      await createMove(c,owner,{id:fixId,element_id:m.element_id,kind:'operation',purpose:'work',previous_move_id:m.id,title:'Доработать результат по замечаниям',instructions:'Прочитать реальные замечания и исходный результат. Подготовить полностью исправленный результат, сохранив порученный итог.',fields:{planning:{revision_id:planning.revision_id,baseline_id:planning.baseline_id,decision:null,output_contracts:[{key:fixKey,name:'Исправленный результат',content:'Результат с устранёнными замечаниями Игрока.'}]}},conditions:{required_resources:[...required,...outputs],decisions:[{element_id:m.target_element_id,stage:'planning',outcome:'approved'}]}});
      await createMove(c,owner,{id:reviewId,element_id:m.element_id,kind:'action',purpose:'review',previous_move_id:fixId,title:'Повторно рассмотреть результат',instructions:'Проверить исправленный результат и сохранить итоговое решение с основаниями.',fields:{planning:{revision_id:planning.revision_id,baseline_id:planning.baseline_id,decision:'final',output_contracts:[{key:decisionKey,name:'Итоговое решение Игрока',content:'Решение после доработки.'}]}},conditions:{required_outputs:[{move_id:fixId,output_key:fixKey,revision_id:planning.revision_id}],decisions:[{element_id:m.target_element_id,stage:'planning',outcome:'approved'}]}});
      await c.query('UPDATE game_core.moves SET previous_move_id=$1,conditions=$2 WHERE id=$3',[reviewId,{...continuation.conditions,required_resources:[],required_outputs:[{move_id:fixId,output_key:fixKey,revision_id:planning.revision_id},{move_id:reviewId,output_key:decisionKey,revision_id:planning.revision_id}]},continuation.id]);
      await event(c,owner,'move.linked',continuation.id,{previous_move_id:m.id,new_previous_move_id:reviewId,created_moves:[fixId,reviewId]});
     }
     result={attempt:await one(c,owner,'move_attempts',a.id),output:outputs};await event(c,owner,'move.completed',m.id,{attempt_id:a.id,resource_ids:outputs});
    }
   } else if(operation==='fail') {
    const a=await one(c,owner,'move_attempts',v.attempt_id);if(a.status==='failed')result=a;else {if(a.status!=='running')return fail('INVALID_STATE');await c.query("UPDATE game_core.move_attempts SET status='failed',error_code=$1,finished_at=now() WHERE id=$2",[text(v.error_code,255),a.id]);await c.query("UPDATE game_core.moves SET status='planned' WHERE id=$1",[a.move_id]);result=await one(c,owner,'move_attempts',a.id);await event(c,owner,'move.failed',a.move_id,{attempt_id:a.id});}
   } else if(operation==='link') {
    // Вставка доработки: сохраняет ID истории и меняет лишь непосредственные ссылки.
    const after=await one(c,owner,'moves',v.after_move_id),next=await one(c,owner,'moves',v.before_move_id);
    if(after.status!=='succeeded'||next.status!=='planned'||next.previous_move_id!==after.id)return fail('INVALID_STATE');
    const review=(await c.query("SELECT r.* FROM game_core.resources r JOIN game_core.move_attempts a ON a.id=r.created_by_attempt_id WHERE a.owner_id=$1 AND a.move_id=$2 AND r.metadata->>'stage'='review' AND r.metadata->>'outcome'='changes' AND r.metadata->>'confirmed_by'=$1",[owner,after.id])).rows[0];
    if(!review)return fail('INVALID_STATE');
    await c.query('UPDATE game_core.moves SET previous_move_id=NULL WHERE id=$1',[next.id]);
    let prev=after.id;const inserted=[];
    for(const draft of list(v.moves)) {if(draft.element_id!==after.element_id)return fail('INVALID_ARGUMENT');const m=await createMove(c,owner,{...draft,previous_move_id:prev});prev=m.id;inserted.push(m.id);}
    if(inserted.length!==2 || v.moves[0].kind!=='operation' || v.moves[1].kind!=='action')return fail('INVALID_ARGUMENT');
    await c.query('UPDATE game_core.moves SET previous_move_id=$1 WHERE id=$2',[prev,next.id]);result={inserted};await event(c,owner,'move.linked',next.id,{previous_move_id:after.id,new_previous_move_id:prev,created_moves:inserted});
   } else return fail('INVALID_ARGUMENT');
   if(context?.signal.aborted)throw new GameCoreFault('DEADLINE_EXCEEDED');
   await c.query('COMMIT');return result;
  } catch(e:any) {await c.query('ROLLBACK');if(e instanceof GameCoreFault)throw e;if(e.code==='23505')throw new GameCoreFault('CONFLICT');if(['23503','23514','22P02'].includes(e.code))throw new GameCoreFault('INVALID_ARGUMENT');throw e;}
  finally{c.release();}
 }
 const handler=(op:string)=>(v:unknown,c?:OperationContext)=>run(op,v,c);
 return {ready:async()=>{await pool.query('SELECT 1 FROM game_core.elements LIMIT 0');},graphGet:handler('graph'),elementGet:handler('element'),timelineGet:handler('timeline'),movesAvailable:handler('available'),structureCreate:handler('create'),elementCreate:handler('elementCreate'),elementRevise:handler('revise'),moveCreate:handler('moveCreate'),moveLink:handler('link'),elementActivate:handler('activate'),moveClaim:handler('claim'),moveComplete:handler('complete'),moveFail:handler('fail'),devStatus:handler('devStatus'),planningPacket:handler('planningPacket'),planningBind:handler('planningBind'),planningBuild:handler('planningBuild'),planningApply:handler('planningApply'),elementReclassify:handler('reclassify'),planningExpandRepeat:handler('expandRepeat'),resultReviewSkip:handler('skipResultReview')} as GameCoreHandlers;
}
