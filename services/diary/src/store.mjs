// ABOUTME: Владеет PostgreSQL-записями Дневника и очередью обработки.
// ABOUTME: Публичные операции всегда ограничены owner; worker использует отдельную роль.
import {randomUUID} from 'node:crypto';
import {digest,DiaryFault,parseCreate} from './domain.mjs';
/** Создаёт порты хранения; транзакционная RLS действует также при забытом SQL-фильтре. */
export function createStore(app,worker){
 async function scoped(owner,fn){const c=await app.connect();try{await c.query('BEGIN');await c.query("SELECT set_config('diary.owner_id',$1,true)",[owner]);const result=await fn(c);await c.query('COMMIT');return result;}catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}}
 const get=async(owner,key)=>scoped(owner,async c=>{const r=await c.query('SELECT document FROM diary.entries WHERE id=$1 AND owner_id=$2',[key,owner]);if(!r.rows[0])throw new DiaryFault('NOT_FOUND',404);return r.rows[0].document;});
 async function create(owner,profileId,value,audio=false){
  const input=parseCreate(value,audio),hash=digest(input);
  return scoped(owner,async c=>{
   const prior=await c.query('SELECT input_hash,document FROM diary.entries WHERE owner_id=$1 AND request_id=$2',[owner,input.requestId]);
   if(prior.rows[0]){if(prior.rows[0].input_hash!==hash)throw new DiaryFault('IDEMPOTENCY_CONFLICT',409);return prior.rows[0].document;}
   const entry={id:randomUUID(),ownerId:owner,profileId,requestId:input.requestId,source:audio?'audio':'text',createdAt:new Date().toISOString(),state:audio?'awaiting_upload':'ready',title:audio?input.filename:input.title,eventDate:audio?null:input.eventDate,dateStatus:audio||!input.eventDate?'needs_clarification':'provided',dateEvidence:'',rawText:audio?null:input.text,correctedText:audio?null:input.text,correction:null,transcription:null,audioArtifactId:null,errorCode:null,...(audio?{audioInput:input}:{})};
   const inserted=await c.query('INSERT INTO diary.entries(id,owner_id,request_id,input_hash,state,document) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(owner_id,request_id) DO NOTHING RETURNING document',[entry.id,owner,input.requestId,hash,entry.state,entry]);
   if(inserted.rows[0])return inserted.rows[0].document;
   const raced=await c.query('SELECT input_hash,document FROM diary.entries WHERE owner_id=$1 AND request_id=$2',[owner,input.requestId]);
   if(raced.rows[0]?.input_hash!==hash)throw new DiaryFault('IDEMPOTENCY_CONFLICT',409);return raced.rows[0].document;
  });
 }
 return {create,get,async list(owner,offset=0){return scoped(owner,async c=>{const rows=await c.query("SELECT document-'rawText'-'correctedText'-'correction'-'audioInput' AS document FROM diary.entries WHERE owner_id=$1 ORDER BY COALESCE(document->>'eventDate',document->>'createdAt') DESC,id DESC LIMIT 50 OFFSET $2",[owner,offset]);return {entries:rows.rows.map(r=>r.document)};});},
 async uploaded(owner,key){return scoped(owner,async c=>{await c.query("UPDATE diary.entries SET state='awaiting_upload',document=jsonb_set(jsonb_set(document,'{state}',to_jsonb('awaiting_upload'::text)),'{errorCode}','null'::jsonb),available_at=now(),updated_at=now() WHERE owner_id=$1 AND id=$2 AND (state='awaiting_upload' OR (state='needs_attention' AND document->>'errorCode'='UPLOAD_INTERRUPTED'))",[owner,key]);});},
 async next(fn){
  const c=await worker.connect();let key;
  try{
   const rows=await c.query("SELECT id FROM diary.entries WHERE state IN ('awaiting_upload','transcribing','correcting') AND available_at<=now() ORDER BY updated_at LIMIT 20");
   for(const row of rows.rows){if(!(await c.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked',[row.id])).rows[0].locked)continue;key=row.id;break;}
   if(!key)return false;
   const e=(await c.query('SELECT document FROM diary.entries WHERE id=$1',[key])).rows[0].document;
   const save=async document=>{await c.query("UPDATE diary.entries SET document=$2,state=$3,updated_at=now(),available_at=now()+interval '2 seconds' WHERE id=$1",[key,document,document.state]);};
   try{await fn(e,save);await c.query("UPDATE diary.entries SET available_at=now()+interval '2 seconds',updated_at=now() WHERE id=$1",[key]);}catch(error){
    const code=error instanceof DiaryFault?error.code:'DEPENDENCY_UNAVAILABLE';
    const terminal=code.startsWith('LUNA_')||['UPLOAD_INTERRUPTED','AUDIO_UNAVAILABLE','TRANSCRIPT_LOST','TRANSCRIPTION_FAILED','LUNA_INVALID_JSON','LUNA_INVALID_DATE','INVALID_DATE','INVALID_ARGUMENT','USER_REVOKED','ARTIFACT_OWNER_MISMATCH'].includes(code);
    await c.query("UPDATE diary.entries SET state=CASE WHEN $2 THEN 'needs_attention' ELSE state END,document=jsonb_set(jsonb_set(document,'{errorCode}',to_jsonb($3::text)),'{state}',to_jsonb(CASE WHEN $2 THEN 'needs_attention' ELSE state END)),available_at=now()+interval '30 seconds',updated_at=now() WHERE id=$1",[key,terminal,code]);
   }
   return true;
  }finally{let discard;if(key)try{await c.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[key]);}catch(error){discard=error;}c.release(discard);}
 }};
}
