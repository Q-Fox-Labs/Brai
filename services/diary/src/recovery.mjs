// ABOUTME: Проверяет и планирует явный повтор распознавания в собственной БД Diary.
// ABOUTME: Транзакция и advisory lock сохраняют исходник, старую ошибку и идемпотентность.
import {DiaryFault,id} from './domain.mjs';
/** Явный повтор по решению владельца или оператора; inspect не меняет запись. */
export async function retryTranscription(c,ports,{entryId,previousRequestId,retryId,mode,ownerId,profileId}){
 for(const key of [entryId,retryId])id(key);
 if(!ownerId||previousRequestId!==undefined)id(previousRequestId);
 if(!['inspect','apply'].includes(mode))throw Error('MODE_REQUIRED');
 await c.query('BEGIN');
 try{
  if(ownerId)await c.query("SELECT set_config('diary.owner_id',$1,true)",[ownerId]);
  if(!(await c.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked',[entryId])).rows[0].locked)throw new DiaryFault('WORKER_BUSY',409);
  const e=(await c.query('SELECT document FROM diary.entries WHERE id=$1 FOR UPDATE',[entryId])).rows[0]?.document;
  if(!e||(ownerId&&(e.ownerId!==ownerId||e.profileId!==profileId)))throw new DiaryFault('NOT_FOUND',404);
  await ports.active(e.ownerId,e.profileId);
  let result={state:'already_scheduled',entryId};
  const {history=[],...previous}=e.transcriptionRetry??{};
  const replay=previous.key===retryId||history.some(attempt=>attempt.key===retryId);
  if(!replay){
   if(e.state!=='needs_attention'||e.errorCode!=='TRANSCRIPTION_FAILED'||e.rawText!==null||e.lunaStartedAt||e.audioProcessing?.parts.some(part=>part.lunaStartedAt&&!part.correction))throw new DiaryFault('RETRY_NOT_ALLOWED',409);
   const status=await ports.transcriptionStatus(e),r=status.request??status;
   if(!['failed','outcome_unknown','cancelled'].includes(r.taskState)||(previousRequestId!==undefined&&r.requestId!==previousRequestId)||r.requestId===previous.previousRequestId)throw new DiaryFault('PREVIOUS_NOT_TERMINAL',409);
   previousRequestId=id(r.requestId);
   const a=await ports.artifact(e);
   if(a.status!=='ready'||a.artifactId!==e.audioArtifactId||a.sha256!==e.audioSha256||a.sizeBytes!==e.audioSizeBytes)throw new DiaryFault('ORIGINAL_CHANGED',409);
   if(mode==='apply'){
    const audioProcessing=e.audioProcessing?structuredClone(e.audioProcessing):null;
    if(audioProcessing)delete audioProcessing.pendingRequestId;
    const updated={...e,...(audioProcessing?{audioProcessing}:{}),state:'transcribing',errorCode:null,transcriptionRetry:{key:retryId,previousRequestId,previousState:r.taskState,previousErrorCode:r.errorCode,authorizedAt:new Date().toISOString(),history:previous.key?[...history,previous]:history}};
    await c.query("UPDATE diary.entries SET state='transcribing',document=$2,available_at=now(),updated_at=now() WHERE id=$1",[entryId,updated]);
   }
   result={state:mode==='apply'?'scheduled':'eligible',entryId,previousState:r.taskState,previousErrorCode:r.errorCode};
  }
  await c.query('COMMIT');return result;
 }catch(error){await c.query('ROLLBACK');throw error;}
}
