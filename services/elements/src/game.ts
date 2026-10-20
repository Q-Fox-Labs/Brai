// ABOUTME: Исполняет последовательные Ходы game-core и сохраняет ресурсные снимки в одной транзакции.
// ABOUTME: Использует существующий транспорт Elements; произвольные пользовательские SQL и файлы не принимаются.
import { randomUUID } from 'node:crypto';
import { assemble, baseline, digest, planningFiles, planningId } from './planning.js';
import type { Pool, PoolClient } from 'pg';
import { ElementsFault } from './domain.js';
import type { ElementsHandlers, ElementsStore } from './domain.js';
import type { OperationContext } from './contracts.js';

type Value = Record<string, any>;
const fail = (code: 'INVALID_ARGUMENT'|'INVALID_STATE'|'NOT_FOUND'|'CONFLICT'|'FORBIDDEN') => { throw new ElementsFault(code); };
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
 await c.query('INSERT INTO game_core.outbox(id,owner_id,event_type,subject,payload) VALUES($1,$2,$3,$4,$5)',[eventId,owner,type,`brai.elements.v1.events.${type}`,payload]);
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
 return availableInputs(c,owner,move.purpose==='accept'?move.target_element_id:move.element_id);
}
const ids = (value: any): string[] => {const result=list(value??[]).map(uuid);if(new Set(result).size!==result.length)return fail('INVALID_ARGUMENT');return result;};
const sameIds = (a:string[],b:string[]) => a.length===b.length&&a.every(id=>b.includes(id));
async function requiredOutputs(c:PoolClient,owner:string,move:Value):Promise<string[]> {
 const result:string[]=[];
 for(const requirement of list(move.conditions.required_outputs??[])) {
  const producer=await one(c,owner,'moves',requirement.move_id);
  if(producer.target_element_id!==move.target_element_id)return fail('FORBIDDEN');
  const row=(await c.query(`SELECT r.id FROM game_core.resources r JOIN game_core.move_attempts a ON a.id=r.created_by_attempt_id
   WHERE r.owner_id=$1 AND a.move_id=$2 AND a.status='succeeded' AND r.metadata->>'output_key'=$3 AND r.metadata->>'plan_revision_id'=$4`,[owner,producer.id,requirement.output_key,requirement.revision_id])).rows;
  if(row.length!==1)return fail('INVALID_STATE');
  result.push(row[0].id);
 }
 return result;
}
async function minimalInputs(c:PoolClient,owner:string,move:Value,available:string[]):Promise<string[]> {
 const required=[...ids(move.conditions.required_resources),...await requiredOutputs(c,owner,move)];
 const el=await one(c,owner,'elements',move.element_id);
 const decisions=[...list(move.conditions.decisions??[])];
 if((el.kind==='task'&&move.purpose==='work')||move.purpose==='start')decisions.push({element_id:el.id,stage:'planning',outcome:'approved'});
 if(['finish','accept'].includes(move.purpose))decisions.push({element_id:move.target_element_id,stage:'final',outcome:'success'});
 for(const d of decisions){const target=await one(c,owner,'elements',d.element_id);const resource=(await c.query(`SELECT id FROM game_core.resources WHERE owner_id=$1 AND id=ANY($2::uuid[]) AND metadata->>'element_id'=$3 AND metadata->>'stage'=$4 AND metadata->>'outcome'=$5 AND metadata->>'confirmed_by'=$1 AND (metadata->>'revision_id'=$6 OR ($4<>'planning' AND $7)) ORDER BY id LIMIT 1`,[owner,available,d.element_id,d.stage,d.outcome??'success',target.current_revision_id,!move.fields?.planning])).rows[0];if(!resource)return fail('INVALID_STATE');required.push(resource.id);}
 return [...new Set(required)];
}
async function ready(c: PoolClient, owner: string, move: Value, selected?: string[]): Promise<string[]> {
 if(move.status!=='planned') return fail('INVALID_STATE');
 const el=await one(c,owner,'elements',move.element_id);
 if(['completed','cancelled'].includes(el.status)) return fail('INVALID_STATE');
 const available=await inputs(c,owner,move);
 const ids=selected??available;
 if(ids.some(id=>!available.includes(id)))return fail('FORBIDDEN');
 const resources=ids.length?(await c.query('SELECT * FROM game_core.resources WHERE owner_id=$1 AND id=ANY($2::uuid[])',[owner,ids])).rows:[];
 const conditions=move.conditions;
 if((el.kind==='task'&&move.purpose==='work')||move.purpose==='start') {
  if(!resources.some(r=>r.metadata.element_id===el.id&&r.metadata.stage==='planning'&&r.metadata.revision_id===el.current_revision_id&&r.metadata.outcome==='approved'&&r.metadata.confirmed_by===owner))return fail('INVALID_STATE');
 }
 if(move.purpose==='finish') {
  const open=(await c.query("SELECT 1 FROM game_core.elements WHERE owner_id=$1 AND parent_id=$2 AND status NOT IN ('completed','cancelled') LIMIT 1",[owner,move.target_element_id])).rowCount;
  if(open)return fail('INVALID_STATE');
 }

 for(const id of [...(conditions.required_resources??[]),...await requiredOutputs(c,owner,move)]) if(!ids.includes(id)) return fail('INVALID_STATE');
 for(const requirement of conditions.decisions??[]) {
  const target=await one(c,owner,'elements',requirement.element_id);
  if(!resources.some(r=>r.metadata.element_id===target.id && r.metadata.stage===requirement.stage && r.metadata.outcome===(requirement.outcome??'success') && (!move.fields?.planning&&requirement.stage!=='planning'||r.metadata.revision_id===target.current_revision_id) && r.metadata.confirmed_by===owner)) return fail('INVALID_STATE');
 }
 if(['accept','finish'].includes(move.purpose)) {
  if(!resources.some(r=>r.metadata.element_id===move.target_element_id && r.metadata.stage==='final' && r.metadata.outcome==='success' && r.metadata.confirmed_by===owner && (!move.fields?.planning||r.metadata.revision_id===(move.fields.planning.revision_id)))) return fail('INVALID_STATE');
 }
 const busy=(await c.query("SELECT 1 FROM game_core.move_attempts a JOIN game_core.moves m ON m.id=a.move_id WHERE a.owner_id=$1 AND m.element_id=$2 AND a.status='running'",[owner,move.element_id])).rowCount;
 if(busy) return fail('CONFLICT');
 return ids;
}
async function graph(c: PoolClient, owner: string): Promise<Value> {
 const rows=async(table:string)=>(await c.query(`SELECT * FROM game_core.${table} WHERE owner_id=$1`,[owner])).rows;
 const [els,revs,mvs,ats,res,ars,ers]=await Promise.all(['elements','element_revisions','moves','move_attempts','resources','attempt_resources','element_resources'].map(rows));
 const elements=els!.map(e=>{const r=revs!.find(r=>r.id===e.current_revision_id)!; return {id:e.id,kind:e.kind,parentId:e.parent_id,status:e.status,revision:r.id,title:r.title,description:r.description,fields:r.fields,provenance:e.provenance,input:ers!.filter(x=>x.element_id===e.id&&x.role==='input').map(x=>x.resource_id),output:ers!.filter(x=>x.element_id===e.id&&x.role==='output').map(x=>x.resource_id)};});
 const moves=mvs!.map(m=>{const a=ats!.filter(a=>a.move_id===m.id).sort((a,b)=>String(b.recorded_at).localeCompare(String(a.recorded_at)))[0]; return {id:m.id,ownerId:m.element_id,targetId:m.target_element_id,previousId:m.previous_move_id,kind:m.kind,title:m.title,status:m.status,attemptId:a?.id??'',executor:a?.executor_kind??(m.kind==='action'?'human':'agent'),instructions:m.instructions,conditions:m.conditions,fields:m.fields,purpose:m.purpose,input:a?ars!.filter(x=>x.attempt_id===a.id).map(x=>x.resource_id):[],output:a?res!.filter(x=>x.created_by_attempt_id===a.id).map(x=>x.id):[]};});
 return {elements,moves,resources:res!.map(r=>({id:r.id,attemptId:r.created_by_attempt_id,title:r.title,content:r.content,metadata:r.metadata,artifactIds:r.artifact_ids})),attempts:ats!.map(a=>({id:a.id,moveId:a.move_id,status:a.status,result:a.result,errorCode:a.error_code,startedAt:a.started_at,finishedAt:a.finished_at})),revisions:revs,links:[]};
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
async function createMove(c:PoolClient,owner:string,v:Value) {
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
 if(!['work','plan','start','accept','finish','confirm','review','final'].includes(v.purpose??'work')) return fail('INVALID_ARGUMENT');
 if(['accept','finish','start','plan'].includes(v.purpose)&&v.kind!=='operation') return fail('INVALID_ARGUMENT');
 if(element.kind==='task') {
  const previousOwner=prev?(await one(c,owner,'moves',prev)).element_id:null;
  if(previousOwner!==element.id) {
   const root=(await c.query('SELECT 1 FROM game_core.moves m LEFT JOIN game_core.moves p ON p.id=m.previous_move_id WHERE m.owner_id=$1 AND m.element_id=$2 AND (p.id IS NULL OR p.element_id<>m.element_id) LIMIT 1',[owner,element.id])).rowCount;
   if(root)return fail('CONFLICT');
  }

  const sibling=(await c.query("SELECT 1 FROM game_core.moves WHERE owner_id=$1 AND element_id=$2 AND previous_move_id IS NOT DISTINCT FROM $3 AND status!='cancelled'",[owner,element.id,prev])).rowCount;
  if(sibling) return fail('CONFLICT');
 }
 await c.query('INSERT INTO game_core.moves(id,owner_id,element_id,target_element_id,previous_move_id,kind,purpose,title,instructions,fields,conditions) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[id,owner,element.id,v.target_element_id??v.targetId??element.id,prev,v.kind,v.purpose??'work',text(v.title,1000),v.instructions??'',v.fields??{},conditions]);
 return {id};
}
/** Собирает совместимые транспортные обработчики; все новые записи принадлежат game_core. */
export function createGameHandlers(pool:Pool, legacy:ElementsStore, verifyArtifact?: (owner:string,id:string)=>Promise<void>, devStatusEnabled=false):ElementsHandlers {
 async function run(operation:string,value:unknown,context?:OperationContext):Promise<any> {
  const v=object(value), owner=text(v.user_id,255);
  if(Buffer.byteLength(json(v))>262144) return fail('INVALID_ARGUMENT');
  const c=await pool.connect();
  try {
   await c.query('BEGIN');
   await c.query("SELECT set_config('statement_timeout','10000',true)");
   await c.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('game-core:maintenance',0))");
   await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`game-core:${owner}`]);
   if(context?.signal.aborted) throw new ElementsFault('DEADLINE_EXCEEDED');
   let result:any;
   if(operation==='graph') result=await graph(c,owner);
   else if(operation==='element') {const g=await graph(c,owner);result=g.elements.find((x:Value)=>x.id===v.element_id)??fail('NOT_FOUND');}
   else if(operation==='timeline') {const q=await c.query('SELECT a.* FROM game_core.move_attempts a JOIN game_core.moves m ON m.id=a.move_id WHERE a.owner_id=$1 AND ($2::uuid IS NULL OR m.element_id=$2) ORDER BY a.recorded_at DESC LIMIT $3',[owner,v.element_id??null,Math.min(100,v.limit??50)]);result={items:q.rows,next_cursor:null};}
   else if(operation==='available') {const all=(await c.query("SELECT * FROM game_core.moves WHERE owner_id=$1 AND status='planned' AND ($2::uuid IS NULL OR element_id=$2)",[owner,v.element_id??null])).rows;const items=[];for(const m of all){try{const available=await ready(c,owner,m);items.push({...m,available_resource_ids:available,required_resource_ids:await minimalInputs(c,owner,m,available)});}catch(e){if(!(e instanceof ElementsFault))throw e;}}result={items};}
   else if(['planningPacket','planningBind','planningBuild','planningApply'].includes(operation)) {
    const a=await one(c,owner,'move_attempts',v.attempt_id),m=await one(c,owner,'moves',a.move_id),el=await one(c,owner,'elements',m.target_element_id);
    if(m.kind!=='operation'||!['plan','start'].includes(m.purpose)||el.kind!=='task'||a.executor_kind==='human')return fail('INVALID_STATE');
    const revision=await one(c,owner,'element_revisions',el.current_revision_id);
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
      const finish=(await c.query("SELECT * FROM game_core.moves WHERE owner_id=$1 AND target_element_id=$2 AND purpose IN ('accept','finish')",[owner,el.id])).rows;
      if(finish.length>1)return fail('CONFLICT');
      const context=m.purpose==='start'?selected.filter(r=>assigned.includes(r.id)):selected;
      state={snapshot,assigned_digest:digest(assigned),files:planningFiles(el,revision,m,context,finish[0]??null),source_revision:revision.id};
     }
     if(operation==='planningPacket')result={baseline_id:baseline.id,files:state.files,source_revision:state.source_revision,inputs_sha256:state.snapshot};
     else if(operation==='planningBind') {
      if(state.candidate)return fail('CONFLICT');
      if(state.baseline&&digest(state.baseline)!==digest(v.baseline))return fail('CONFLICT');
      result=await assemble({files:state.files,baseline:object(v.baseline)});state.baseline=v.baseline;state.baseline_json=JSON.stringify(v.baseline);
     } else if(operation==='planningBuild') {
      if(!state.baseline)return fail('INVALID_STATE');
      result=await assemble({files:state.files,baseline:JSON.parse(state.baseline_json),candidate:object(v.candidate)});
      const stage=result.stage;
      if(stage.children.length||stage.deferred.length||stage.awaiting_clarification||stage.records.some((r:Value)=>r.executable===false))return fail('INVALID_ARGUMENT');
      state.candidate=v.candidate;state.candidate_json=JSON.stringify(v.candidate);state.candidate_sha256=result.candidate_sha256;
     } else {
      if(!state.candidate||state.candidate_sha256!==v.candidate_sha256)return fail('CONFLICT');
      const built=await assemble({files:state.files,baseline:JSON.parse(state.baseline_json),candidate:JSON.parse(state.candidate_json),review:object(v.review)}),stage=built.stage;
      if(stage.children.length||stage.deferred.length||stage.awaiting_clarification||stage.records.some((r:Value)=>r.executable===false))return fail('INVALID_ARGUMENT');
      const rid=planningId(`${a.id}:${built.candidate_sha256}:revision`);
      const contracts=stage.resources.filter((r:Value)=>r.state==='expected');
      const contract=(record:Value)=>({
       ...record,planning:{revision_id:rid,baseline_id:baseline.id,decision:record.decision,
        output_contracts:record.outputs.map((key:string)=>{const r=contracts.find((x:Value)=>x.id===key);if(!r)return fail('INVALID_ARGUMENT');return {key,name:r.name,content:r.content};})}
      });
      const conditions=(record:Value)=>({required_resources:record.inputs.filter((key:string)=>selected.some(r=>r.id===key)),
       required_outputs:record.inputs.filter((key:string)=>!selected.some(r=>r.id===key)).map((key:string)=>{
        const r=contracts.find((x:Value)=>x.id===key);if(!r?.producer)return fail('INVALID_ARGUMENT');return {move_id:r.producer,output_key:key,revision_id:rid};}),
       decisions:record.requires_confirmation?[{element_id:el.id,stage:'planning',outcome:'approved'}]:[]});
      const existingEnd=(await c.query('SELECT * FROM game_core.moves WHERE owner_id=$1 AND id=$2',[owner,stage.finish.id])).rows[0];
      if(existingEnd){if(existingEnd.target_element_id!==el.id||existingEnd.element_id!==m.element_id||existingEnd.status!=='planned')return fail('CONFLICT');await c.query('UPDATE game_core.moves SET previous_move_id=NULL WHERE id=$1',[existingEnd.id]);}
      await c.query('INSERT INTO game_core.element_revisions(id,owner_id,element_id,revision,title,description,fields,created_by_attempt_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[rid,owner,el.id,revision.revision+1,stage.element.fields.title,stage.element.fields.summary,{...stage.element.fields,planning:{baseline_id:baseline.id,source_revision:revision.id,expected_resources:contracts,chain:stage.chain,notes:v.review.notes??[],criteria:state.baseline.requirements}},a.id]);
      await c.query('UPDATE game_core.elements SET current_revision_id=$1 WHERE owner_id=$2 AND id=$3',[rid,owner,el.id]);
      const records=[...stage.records];if(!records.some((r:Value)=>r.id===stage.finish.id))records.push(stage.finish);
      for(const record of records){
       const purpose=record.id===stage.finish.id?(el.parent_id?'accept':'finish'):record.purpose;
       const draft={id:record.id,element_id:record.owner,target_element_id:record.target,previous_move_id:record.previous,kind:record.actor==='player'?'action':'operation',purpose,title:record.title,instructions:record.instruction??'',fields:contract(record),conditions:conditions(record)};
       if(existingEnd&&record.id===existingEnd.id)await c.query('UPDATE game_core.moves SET previous_move_id=$1,title=$2,instructions=$3,fields=$4,conditions=$5 WHERE id=$6',[draft.previous_move_id,draft.title,draft.instructions,draft.fields,draft.conditions,existingEnd.id]);
       else await createMove(c,owner,draft);
      }
      const planContract=contracts.find((r:Value)=>r.producer===m.id);if(!planContract)return fail('INVALID_ARGUMENT');
      const resourceId=randomUUID();
      await c.query('INSERT INTO game_core.resources(id,owner_id,created_by_attempt_id,title,content,metadata) VALUES($1,$2,$3,$4,$5,$6)',[resourceId,owner,a.id,'Постановка и план Ходов',built.markdown,{output_key:planContract.id,plan_revision_id:rid,baseline_id:baseline.id,receipt:built.receipt,review:v.review}]);
      result={element_id:el.id,revision_id:rid,operation_id:m.id,resource_id:resourceId,move_ids:records.map((r:Value)=>r.id),receipt:built.receipt};
      state.applied=result;state.apply_digest=digest({candidate_sha256:v.candidate_sha256,review:v.review});
      await c.query("UPDATE game_core.moves SET status='succeeded' WHERE id=$1",[m.id]);
      await c.query("UPDATE game_core.move_attempts SET status='succeeded',finished_at=now() WHERE id=$1",[a.id]);
      await event(c,owner,'plan.applied',m.id,{attempt_id:a.id,element_id:el.id,revision_id:rid,resource_ids:[resourceId],move_ids:result.move_ids,baseline_id:baseline.id});
     }
     await c.query('UPDATE game_core.move_attempts SET result=$1 WHERE id=$2',[{...a.result,planning:state},a.id]);
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
    if(el.status==='completed')return fail('INVALID_STATE');
    const descendants=(await c.query('WITH RECURSIVE tree AS (SELECT id FROM game_core.elements WHERE owner_id=$1 AND id=$2 UNION ALL SELECT e.id FROM game_core.elements e JOIN tree t ON e.parent_id=t.id WHERE e.owner_id=$1) SELECT id FROM tree',[owner,el.id])).rows.map(r=>r.id);
    await c.query("UPDATE game_core.elements SET status='cancelled',outcome='cancelled' WHERE owner_id=$1 AND id=ANY($2::uuid[]) AND status!='completed'",[owner,descendants]);
    await c.query("UPDATE game_core.move_attempts SET status='failed',error_code='CANCELLED',finished_at=now() WHERE owner_id=$1 AND status='running' AND move_id IN (SELECT id FROM game_core.moves WHERE owner_id=$1 AND (element_id=ANY($2::uuid[]) OR target_element_id=ANY($2::uuid[])))",[owner,descendants]);
    await c.query("UPDATE game_core.moves SET status='cancelled' WHERE owner_id=$1 AND (element_id=ANY($2::uuid[]) OR target_element_id=ANY($2::uuid[])) AND status!='succeeded'",[owner,descendants]);
    result={id:el.id,status:'cancelled'};await event(c,owner,'element.cancelled',el.id,{});
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
     if(m.purpose==='start')for(const r of transferred)await c.query("INSERT INTO game_core.element_resources VALUES($1,$2,$3,'input') ON CONFLICT DO NOTHING",[owner,m.target_element_id,r]);
     result={attempt:await one(c,owner,'move_attempts',id),input:chosen};await event(c,owner,'move.claimed',m.id,{attempt_id:id});
    }
   } else if(operation==='complete') {
    const a=await one(c,owner,'move_attempts',v.attempt_id),m=await one(c,owner,'moves',a.move_id);
    if(a.status==='succeeded') result={attempt:a};else {
     if(a.status!=='running')return fail('INVALID_STATE');
     const body:Value={...object(v.result??{}),claim:a.result?.claim};const outputs:string[]=[];
     const planning=m.fields?.planning,expected=list(planning?.output_contracts??[]),seen=new Set<string>();
     if(planning&&(await one(c,owner,'elements',m.target_element_id)).current_revision_id!==planning.revision_id)return fail('CONFLICT');
     if(m.purpose==='plan'||m.purpose==='start'&&planning)return fail('FORBIDDEN');
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
       if(isDecision&&!(decision==='confirm'?(metadata.stage==='planning'&&metadata.outcome==='approved'||metadata.stage==='review'&&metadata.outcome==='changes'):(metadata.stage==='final'&&metadata.outcome==='success'||metadata.stage==='review'&&metadata.outcome==='changes')))return fail('INVALID_ARGUMENT');
       if(metadata.stage&&!isDecision)return fail('INVALID_ARGUMENT');
      }
      if(metadata.stage) {
       if(a.executor_kind!=='human')return fail('FORBIDDEN');
       if(metadata.element_id!==m.target_element_id)return fail('INVALID_ARGUMENT');
       if(!['planning','final','review'].includes(metadata.stage))return fail('INVALID_ARGUMENT');
       if(metadata.stage==='planning'||planning) {const target=await one(c,owner,'elements',m.target_element_id);if(metadata.revision_id!==target.current_revision_id||a.result?.claim?.revision_id!==target.current_revision_id)return fail('CONFLICT');}
       if(!['approved','success','changes','cancelled'].includes(metadata.outcome))return fail('INVALID_ARGUMENT');
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
   if(context?.signal.aborted)throw new ElementsFault('DEADLINE_EXCEEDED');
   await c.query('COMMIT');return result;
  } catch(e:any) {await c.query('ROLLBACK');if(e instanceof ElementsFault)throw e;if(e.code==='23505')throw new ElementsFault('CONFLICT');if(['23503','23514','22P02'].includes(e.code))throw new ElementsFault('INVALID_ARGUMENT');throw e;}
  finally{c.release();}
 }
 const handler=(op:string)=>(v:unknown,c?:OperationContext)=>run(op,v,c);
 return {ready:async()=>{await pool.query('SELECT 1 FROM game_core.elements LIMIT 0');},graphGet:handler('graph'),elementGet:handler('element'),timelineGet:handler('timeline'),movesAvailable:handler('available'),structureCreate:handler('create'),elementCreate:handler('elementCreate'),elementRevise:handler('revise'),moveCreate:handler('moveCreate'),moveLink:handler('link'),elementActivate:handler('activate'),moveClaim:handler('claim'),moveComplete:handler('complete'),moveFail:handler('fail'),devStatus:handler('devStatus'),planningPacket:handler('planningPacket'),planningBind:handler('planningBind'),planningBuild:handler('planningBuild'),planningApply:handler('planningApply')} as ElementsHandlers;
}
