// ABOUTME: Проверяет безопасное явное продолжение ASR без вычислений и замены оригинала.
// ABOUTME: Синтетические порты покрывают повтор, неизвестный исход, отказ владельца и конкурентный worker.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {retryTranscription} from '../src/recovery.mjs';
function fixture(){
 const args={entryId:randomUUID(),previousRequestId:randomUUID(),retryId:randomUUID(),mode:'apply'};
 let e={id:args.entryId,ownerId:'owner',profileId:'profile',state:'needs_attention',errorCode:'TRANSCRIPTION_FAILED',rawText:null,audioArtifactId:randomUUID(),audioSha256:'a'.repeat(64),audioSizeBytes:57_637_658};
 const original=structuredClone(e),queries=[];
 let locked=true,state='outcome_unknown',changedHash=false,denied=false,calls=0;
 const c={async query(sql,params){
  queries.push(sql);
  if(sql.includes('pg_try_advisory'))return {rows:[{locked}]};
  if(sql.startsWith('SELECT document'))return {rows:[{document:structuredClone(e)}]};
  if(sql.startsWith('UPDATE'))e=structuredClone(params[1]);
  return {rows:[]};
 }};
 const ports={async active(){if(denied)throw Error('USER_REVOKED');},async transcriptionStatus(){calls++;return {request:{requestId:args.previousRequestId,taskState:state,errorCode:'DEPENDENCY_UNAVAILABLE'}};},async artifact(){return {status:'ready',artifactId:e.audioArtifactId,sha256:changedHash?'b'.repeat(64):e.audioSha256,sizeBytes:e.audioSizeBytes};}};
 return {args,c,ports,original,queries,get entry(){return e;},get calls(){return calls;},set lock(v){locked=v;},set state(v){state=v;},set changedHash(v){changedHash=v;},set denied(v){denied=v;}};
}
test('explicit retry preserves original and unknown outcome; replay schedules once',async()=>{
 const f=fixture();assert.equal((await retryTranscription(f.c,f.ports,f.args)).state,'scheduled');
 assert.equal(f.entry.audioArtifactId,f.original.audioArtifactId);assert.equal(f.entry.audioSha256,f.original.audioSha256);
 assert.equal(f.entry.transcriptionRetry.previousState,'outcome_unknown');
 assert.equal(f.entry.transcriptionRetry.previousRequestId,f.args.previousRequestId);
 assert.equal(f.entry.state,'transcribing');
 assert.equal((await retryTranscription(f.c,f.ports,f.args)).state,'already_scheduled');
 assert.equal(f.calls,1);assert.equal(f.queries.filter(q=>q.startsWith('UPDATE')).length,1);
});
test('owner retry uses app RLS and derives the previous request from its own entry',async()=>{
 const f=fixture();delete f.args.previousRequestId;
 const prior=randomUUID();f.ports.transcriptionStatus=async()=>({request:{requestId:prior,taskState:'failed'}});
 f.args.ownerId='owner';f.args.profileId='profile';
 assert.equal((await retryTranscription(f.c,f.ports,f.args)).state,'scheduled');
 assert.equal(f.entry.transcriptionRetry.previousRequestId,prior);
 assert.ok(f.queries.findIndex(q=>q.includes('set_config'))<f.queries.findIndex(q=>q.startsWith('SELECT document')));
});
test('foreign owner or profile cannot schedule a retry',async()=>{
 for(const scope of [{ownerId:'other',profileId:'profile'},{ownerId:'owner',profileId:'other'}]){
  const f=fixture();Object.assign(f.args,scope);
  await assert.rejects(retryTranscription(f.c,f.ports,f.args),/NOT_FOUND/);
  assert.equal(f.calls,0);assert.ok(!f.queries.some(q=>q.startsWith('UPDATE')));
 }
});
test('a different retry key cannot schedule a second computation',async()=>{
 const f=fixture();await retryTranscription(f.c,f.ports,f.args);
 f.args.retryId=randomUUID();await assert.rejects(retryTranscription(f.c,f.ports,f.args),/RETRY_NOT_ALLOWED/);
 assert.equal(f.calls,1);assert.equal(f.queries.filter(q=>q.startsWith('UPDATE')).length,1);
});
test('inspection is read-only',async()=>{
 const f=fixture();f.args.mode='inspect';assert.equal((await retryTranscription(f.c,f.ports,f.args)).state,'eligible');
 assert.deepEqual(f.entry,f.original);assert.ok(!f.queries.some(q=>q.startsWith('UPDATE')));
});
for(const [name,change,expected] of [
 ['active compute',f=>{f.state='running';},'PREVIOUS_NOT_TERMINAL'],
 ['changed original',f=>{f.changedHash=true;},'ORIGINAL_CHANGED'],
 ['revoked owner',f=>{f.denied=true;},'USER_REVOKED'],
 ['busy worker',f=>{f.lock=false;},'WORKER_BUSY'],
 ['wrong request',f=>{f.args.previousRequestId=randomUUID();f.ports.transcriptionStatus=async()=>({request:{requestId:randomUUID(),taskState:'failed'}});},'PREVIOUS_NOT_TERMINAL'],
 ['existing raw text',f=>{f.entry.rawText='already transcribed';},'RETRY_NOT_ALLOWED'],
 ['Luna already invoked',f=>{f.entry.lunaStartedAt='2026-11-09T00:00:00Z';},'RETRY_NOT_ALLOWED'],
]){
 test('refuse '+name+' without mutation',async()=>{const f=fixture();change(f);await assert.rejects(retryTranscription(f.c,f.ports,f.args),new RegExp(expected));assert.ok(f.queries.includes('ROLLBACK'));assert.ok(!f.queries.some(q=>q.startsWith('UPDATE')));});
}

test('another explicit retry after a new terminal failure retains parts and all prior keys',async()=>{
 const f=fixture();await retryTranscription(f.c,f.ports,f.args);
 const first=structuredClone(f.entry.transcriptionRetry),firstKey=f.args.retryId;
 const completed={index:0,rawText:'saved raw',transcription:{requestId:randomUUID()},lunaStartedAt:'2026-11-10T00:00:00Z',correction:{correctedText:'saved corrected'}};
 const incomplete={index:1,frames:16000};
 const failedRequest=randomUUID();
 f.entry.state='needs_attention';f.entry.errorCode='TRANSCRIPTION_FAILED';
 f.entry.audioProcessing={parts:[completed,incomplete],pendingRequestId:failedRequest};
 f.entry.audioProgress={transcribedFrames:16000,correctedFrames:16000};
 f.args.previousRequestId=failedRequest;f.args.retryId=randomUUID();
 assert.equal((await retryTranscription(f.c,f.ports,f.args)).state,'scheduled');
 assert.deepEqual(f.entry.audioProcessing,{parts:[completed,incomplete]});
 assert.deepEqual(f.entry.audioProgress,{transcribedFrames:16000,correctedFrames:16000});
 const {history:ignored,...flat}=first;
 assert.deepEqual(f.entry.transcriptionRetry.history,[flat]);
 assert.equal(f.entry.transcriptionRetry.previousRequestId,failedRequest);
 const scheduled=structuredClone(f.entry),writes=f.queries.filter(q=>q.startsWith('UPDATE')).length;
 f.entry.state='needs_attention';f.entry.errorCode='TRANSCRIPTION_FAILED';
 for(const key of [firstKey,scheduled.transcriptionRetry.key]){
  f.args.retryId=key;
  assert.equal((await retryTranscription(f.c,f.ports,f.args)).state,'already_scheduled');
 }
 assert.equal(f.queries.filter(q=>q.startsWith('UPDATE')).length,writes);
 assert.equal(f.entry.state,'needs_attention');
});
test('a repeated old terminal request cannot authorize another compute',async()=>{
 const f=fixture();await retryTranscription(f.c,f.ports,f.args);
 f.entry.state='needs_attention';f.entry.errorCode='TRANSCRIPTION_FAILED';f.args.retryId=randomUUID();
 await assert.rejects(retryTranscription(f.c,f.ports,f.args),/PREVIOUS_NOT_TERMINAL/);
 assert.equal(f.queries.filter(q=>q.startsWith('UPDATE')).length,1);
});
test('an unfinished per-part Luna attempt cannot be retried as ASR',async()=>{
 const f=fixture();f.entry.audioProcessing={parts:[{lunaStartedAt:'2026-11-10T00:00:00Z'}]};
 await assert.rejects(retryTranscription(f.c,f.ports,f.args),/RETRY_NOT_ALLOWED/);
 assert.equal(f.calls,0);assert.ok(!f.queries.some(q=>q.startsWith('UPDATE')));
});
