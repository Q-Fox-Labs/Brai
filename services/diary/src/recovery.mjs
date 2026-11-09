// ABOUTME: Проверяет и планирует явный повтор распознавания в собственной БД Diary.
// ABOUTME: Транзакция и advisory lock сохраняют исходник, старую ошибку и идемпотентность.
import {id} from './domain.mjs';
/** Оператор заранее проверяет неизвестный исход; inspect не меняет запись. */
export async function retryTranscription(c,ports,{entryId,previousRequestId,retryId,mode}){
 for(const key of [entryId,previousRequestId,retryId])id(key);
 if(!['inspect','apply'].includes(mode))throw Error('MODE_REQUIRED');
 await c.query('BEGIN');
 try{
  if(!(await c.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked',[entryId])).rows[0].locked)throw Error('WORKER_BUSY');
  const e=(await c.query('SELECT document FROM diary.entries WHERE id=$1 FOR UPDATE',[entryId])).rows[0]?.document;
  if(!e)throw Error('NOT_FOUND');
  await ports.active(e.ownerId,e.profileId);
  let result={state:'already_scheduled',entryId};
  if(e.transcriptionRetry?.key!==retryId){
   if(e.state!=='needs_attention'||e.errorCode!=='TRANSCRIPTION_FAILED'||e.rawText!==null||e.lunaStartedAt||e.transcriptionRetry)throw Error('RETRY_NOT_ALLOWED');
   const status=await ports.transcriptionStatus(e),r=status.request??status;
   if(!['failed','outcome_unknown','cancelled'].includes(r.taskState)||r.requestId!==previousRequestId)throw Error('PREVIOUS_NOT_TERMINAL');
   const a=await ports.artifact(e);
   if(a.status!=='ready'||a.artifactId!==e.audioArtifactId||a.sha256!==e.audioSha256||a.sizeBytes!==e.audioSizeBytes)throw Error('ORIGINAL_CHANGED');
   if(mode==='apply'){
    const updated={...e,state:'transcribing',errorCode:null,transcriptionRetry:{key:retryId,previousRequestId,previousState:r.taskState,previousErrorCode:r.errorCode,authorizedAt:new Date().toISOString()}};
    await c.query("UPDATE diary.entries SET state='transcribing',document=$2,available_at=now(),updated_at=now() WHERE id=$1",[entryId,updated]);
   }
   result={state:mode==='apply'?'scheduled':'eligible',entryId,previousState:r.taskState,previousErrorCode:r.errorCode};
  }
  await c.query('COMMIT');return result;
 }catch(error){await c.query('ROLLBACK');throw error;}
}
