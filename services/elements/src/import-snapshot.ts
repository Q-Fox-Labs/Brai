// ABOUTME: Загружает операторский снимок game-core атомарно и без перезаписи существующих данных.
// ABOUTME: Исторические материалы и владелец передаются извне; публичный продукт не содержит частный seed.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
/** Импортирует целостный ограниченный снимок; повтор возвращает сохранённый набор без изменений. */
export async function importSnapshot(pool:Pool, owner:string, data:any):Promise<any> {
 if(!owner||!data.elements?.length||data.elements.length>100||data.moves.length>500||data.resources.length>1000)throw Error('INVALID_SNAPSHOT');
 const c=await pool.connect();
 try {
  await c.query('BEGIN');await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`game-core:${owner}`]);
  const ids=data.elements.map((e:any)=>e.id);
  const exists=(await c.query('SELECT id,owner_id FROM game_core.elements WHERE id=ANY($1::uuid[])',[ids])).rows;
  if(exists.length) {
   if(exists.length!==ids.length||exists.some(e=>e.owner_id!==owner))throw Error('SNAPSHOT_CONFLICT');
   for(const [table,items] of [['moves',data.moves],['move_attempts',data.attempts],['resources',data.resources],['element_revisions',data.revisions]] as const) {
    const n=Number((await c.query(`SELECT count(*) AS n FROM game_core.${table} WHERE owner_id=$1 AND id=ANY($2::uuid[])`,[owner,items.map((i:any)=>i.id)])).rows[0].n);
    if(n!==items.length)throw Error('SNAPSHOT_INCOMPLETE');
   }
   await c.query('COMMIT');return {imported:false,elements:ids.length};
  }
  const provenance={kind:'historical_reconstruction',source:'goal-01-db',historical_dates_known:false,imported_at:new Date().toISOString()};
  for(const e of data.elements)await c.query('INSERT INTO game_core.elements(id,owner_id,kind,parent_id,current_revision_id,status,outcome,provenance) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[e.id,owner,e.kind,e.parentId,e.revision,e.status,'success',provenance]);
  for(const r of data.revisions)await c.query('INSERT INTO game_core.element_revisions(id,owner_id,element_id,revision,title,description,fields,created_by_attempt_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[r.id,owner,r.element_id,r.revision,r.title,r.description??'',r.fields??{},r.created_by_attempt_id]);
  for(const m of data.moves)await c.query('INSERT INTO game_core.moves(id,owner_id,element_id,target_element_id,previous_move_id,kind,purpose,title,instructions,conditions,status,fields) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',[m.id,owner,m.ownerId,m.targetId,m.previousId,m.kind,m.purpose??'work',m.title,m.instructions??'',m.conditions??{},m.status,{source_alias:m.alias}]);
  for(const a of data.attempts)await c.query('INSERT INTO game_core.move_attempts(id,owner_id,move_id,executor_kind,executor_id,idempotency_key,status,started_at,finished_at,result) VALUES($1,$2,$3,$4,$5,$6,$7,NULL,NULL,$8)',[a.id,owner,a.move_id,a.executor_kind,a.executor_kind==='human'?owner:null,a.idempotency_key,a.status,{reconstruction:true}]);
  for(const r of data.resources)await c.query('INSERT INTO game_core.resources(id,owner_id,created_by_attempt_id,title,content,metadata) VALUES($1,$2,$3,$4,$5,$6)',[r.id,owner,r.attemptId,r.title,r.content,{...r.metadata,source_alias:r.alias,...(r.metadata?.stage?{confirmed_by:owner}:{})}]);
  for(const m of data.moves)for(const r of m.input)await c.query('INSERT INTO game_core.attempt_resources VALUES($1,$2,$3)',[owner,m.attemptId,r]);
  for(const e of data.elements)for(const role of ['input','output'])for(const r of e[role])await c.query('INSERT INTO game_core.element_resources VALUES($1,$2,$3,$4)',[owner,e.id,r,role]);
  const eventId=randomUUID();
  const payload={event_id:eventId,event_version:1,event_type:'structure.created',occurred_at:new Date().toISOString(),owner_id:owner,actor:{kind:'system',id:null},aggregate:{kind:'element',id:ids[0]},data:{history_category_code:'exchange',history_type_code:'import',reconstruction:true,element_ids:ids,source:'goal-01-db',historical_dates_known:false}};
  await c.query('INSERT INTO game_core.outbox(id,owner_id,event_type,subject,payload) VALUES($1,$2,$3,$4,$5)',[eventId,owner,'structure.created','brai.elements.v1.events.structure.created',payload]);
  await c.query('COMMIT');return {imported:true,elements:ids.length,moves:data.moves.length,attempts:data.attempts.length,resources:data.resources.length,revisions:data.revisions.length};
 }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){const pool=new Pool({connectionString:process.env.ELEMENTS_OWNER_DATABASE_URL});try{console.log(JSON.stringify(await importSnapshot(pool,process.env.ELEMENTS_MCP_OWNER_ID??'',JSON.parse(readFileSync(process.argv[2]!, 'utf8')))));}finally{await pool.end();}}
