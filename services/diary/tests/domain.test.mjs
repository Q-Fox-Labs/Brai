// ABOUTME: Проверяет сохранение raw, даты и независимость обработки от браузера.
// ABOUTME: Все данные синтетические; модельные вызовы подменяются только в этих unit tests.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {advance,parseCreate,parseCorrection} from '../src/domain.mjs';
const owner='owner-a',profileId='profile-a',id='00000000-0000-4000-8000-000000000001';
const entry=()=>({id,ownerId:owner,profileId,requestId:id,state:'awaiting_upload',audioInput:{filename:'fixture.wav',mimeType:'audio/wav',recordedAt:null,timezone:'UTC'},createdAt:'2026-11-08T10:00:00Z'});
const artifact={status:'ready',ownerId:owner,source:'diary',kind:'original',artifactId:id,sha256:'a'.repeat(64),sizeBytes:100};
test('raw persists before Luna; explicit historical date never equals upload date',async()=>{
 const snapshots=[];let calls=0;
 const result=await advance(entry(),{async artifact(){return artifact;},async transcribe(){return {text:'Первого ноября 2026 года я гулял.',provenance:{actualModel:'fixture'}};},async correct(e){calls++;assert.equal(snapshots.at(-1).state,'correcting');assert.equal(e.rawText,'Первого ноября 2026 года я гулял.');return JSON.stringify({correctedText:e.rawText,eventDate:'2026-11-01',dateStatus:'identified',dateEvidence:'Первого ноября 2026 года'});}},async e=>snapshots.push(structuredClone(e)));
 assert.equal(result.eventDate,'2026-11-01');assert.equal(result.correction.model,'gpt-6-luna');assert.equal(calls,1);assert.equal(result.rawText,result.correctedText);
});
test('pending A yields with saved schedule; later ready B can progress',async()=>{
 const rows=[entry(),{...entry(),id:'00000000-0000-4000-8000-000000000002'}],saved=[];
 const ports={async artifact(e){return {...artifact,status:e.id===id?'pending':'ready'};},async transcribe(){return {text:'Событие без даты.',provenance:{}};},async correct(e){return JSON.stringify({correctedText:e.rawText,eventDate:null,dateStatus:'needs_clarification',dateEvidence:''});}};
 for(const e of rows)await advance(e,ports,async value=>saved.push(value));
 assert.equal(saved[0].state,'awaiting_upload');assert.equal(saved.at(-1).state,'ready');assert.equal(saved.at(-1).eventDate,null);
});
test('failed and deleted artifacts require attention instead of endless waiting',async()=>{for(const status of ['failed','deleted'])await assert.rejects(advance(entry(),{async artifact(){return {...artifact,status};}},async()=>{}),{code:status==='failed'?'UPLOAD_INTERRUPTED':'AUDIO_UNAVAILABLE'});});
test('unknown date and invalid calendars cannot be silently replaced',()=>{
 assert.equal(parseCorrection('{"correctedText":"Событие","eventDate":null,"dateStatus":"needs_clarification","dateEvidence":""}').eventDate,null);
 for(const date of ['2026-02-30','2026-13-01','0000-01-01'])assert.throws(()=>parseCorrection(JSON.stringify({correctedText:'Текст',eventDate:date,dateStatus:'identified',dateEvidence:'данные'})));
 assert.throws(()=>parseCorrection('{"correctedText":"Текст","eventDate":"2026-11-01","dateStatus":"identified","dateEvidence":""}'));
});
test('client cannot choose owner, model or instructions',()=>{for(const key of ['ownerId','profileId','model','instructions'])assert.throws(()=>parseCreate({requestId:id,text:'Текст',[key]:'attacker'}));});
test('foreign artifact never reaches transcription or Luna',async()=>{await assert.rejects(advance(entry(),{async artifact(){return {...artifact,ownerId:'owner-b'};}},async()=>{}),{code:'ARTIFACT_OWNER_MISMATCH'});});
