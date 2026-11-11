// ABOUTME: Проверяет пятичасовую обработку, точный прогресс и сохранение каждой части.
// ABOUTME: Синтетические порты не вызывают модели; потерянный исход Luna запрещает повтор.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {advanceParts,audioProgress,validateAudioPlan} from '../src/domain.mjs';
function fixture(seconds=18000){
 const total=seconds*16000,parts=[];let offset=0;
 while(offset<total){const frames=Math.min(170*16000,total-offset);parts.push({index:parts.length,startFrame:offset,frames,artifactId:randomUUID(),sha256:'a'.repeat(64),sizeBytes:44+frames*2});offset+=frames;}
 const plan={version:1,sampleRate:16000,totalFrames:total,parts};
 let entry={id:randomUUID(),ownerId:'owner',profileId:'profile',state:'transcribing',processingVersion:2,rawText:null,createdAt:'2026-11-09T12:00:00Z',audioInput:{recordedAt:null,timezone:'UTC'}},asr=0,luna=0;
 const ports={async prepareAudio(){return structuredClone(plan);},async transcribePart(e,p){asr++;return {text:'Текст части '+p.index,provenance:{requestId:randomUUID(),actualModel:{kind:'local',modelId:'fixture'}}};},async correct(e){luna++;return JSON.stringify({correctedText:e.rawText+'.',eventDate:e.audioPart.index===0?'2026-11-04':null,dateStatus:e.audioPart.index===0?'identified':'needs_clarification',dateEvidence:e.audioPart.index===0?'Четвёртое ноября 2026 года':''});}};
 const tick=async()=>{entry=await advanceParts(entry,ports,async value=>{entry=structuredClone(value);});};
 return {plan,ports,tick,get entry(){return entry;},set entry(v){entry=v;},get asr(){return asr;},get luna(){return luna;}};
}
test('five hours reach ready without an all-audio model call; raw and correction checkpoint separately',async()=>{
 const f=fixture();await f.tick();
 assert.equal(f.asr,1);assert.equal(f.luna,0);assert.equal(f.entry.audioProgress.transcribedFrames,170*16000);assert.equal(f.entry.audioProgress.correctedFrames,0);
 assert.equal(f.entry.rawText,null);
 // Each following step starts from a clone of the persisted document, like a restarted worker.
 for(let n=0;f.entry.state!=='ready'&&n<400;n++){f.entry=structuredClone(f.entry);await f.tick();}
 assert.equal(f.entry.state,'ready');assert.equal(f.asr,f.plan.parts.length);assert.equal(f.luna,f.plan.parts.length);
 assert.equal(f.entry.audioProgress.transcribedFrames,18000*16000);assert.equal(f.entry.audioProgress.correctedFrames,18000*16000);
 assert.equal(f.entry.eventDate,'2026-11-04');assert.ok(f.entry.rawText.includes('Текст части 105'));
 assert.equal(f.entry.transcription.parts.length,106);assert.ok(!('rawText' in f.entry.audioProcessing.parts[0]));
});
test('pending request has no invented progress, completed raw survives restart',async()=>{
 const f=fixture(171);let pending=true;
 f.ports.transcribePart=async()=>pending?{pending:true,requestId:'00000000-0000-4000-8000-000000000001'}:{text:'Исходник',provenance:{requestId:randomUUID(),actualModel:{}}};
 await f.tick();assert.equal(f.entry.audioProgress.transcribedFrames,0);assert.ok(f.entry.audioProcessing.pendingRequestId);
 pending=false;await f.tick();assert.equal(f.entry.audioProgress.transcribedFrames,170*16000);assert.equal(f.luna,0);
 f.ports.transcribePart=async()=>{throw Error('ASR must not repeat');};
 await f.tick();assert.equal(f.luna,1);assert.equal(f.entry.audioProgress.correctedFrames,170*16000);
});
test('unknown Luna outcome is retained and never invoked again automatically',async()=>{
 const f=fixture(5);await f.tick();let calls=0;f.ports.correct=async()=>{calls++;throw Error('lost connection');};
 await assert.rejects(f.tick(),/lost connection/);assert.ok(f.entry.audioProcessing.parts[0].lunaStartedAt);
 await assert.rejects(f.tick(),/LUNA_OUTCOME_UNKNOWN/);assert.equal(calls,1);assert.equal(f.entry.audioProgress.correctedFrames,0);
});
test('gaps, duplicate originals and incomplete coverage are rejected before models',()=>{
 const f=fixture(171);assert.equal(validateAudioPlan(f.plan),f.plan);
 for(const alter of [p=>p.parts[1].startFrame++,p=>p.parts[1].artifactId=p.parts[0].artifactId,p=>p.totalFrames++]){
  const p=structuredClone(f.plan);alter(p);assert.throws(()=>validateAudioPlan(p),/AUDIO_/);
 }
 const p=structuredClone(f.plan);p.parts[0].rawText='a';const progress=audioProgress(p);assert.equal(progress.transcribedFrames,170*16000);assert.notEqual(progress.transcribedFrames/p.totalFrames,0.5);
});
test('different explicit dates remain uncertain',async()=>{
 const f=fixture(171);f.ports.correct=async e=>JSON.stringify({correctedText:e.rawText,eventDate:e.audioPart.index?'2026-11-05':'2026-11-04',dateStatus:'identified',dateEvidence:'точная цитата'});
 for(let n=0;f.entry.state!=='ready'&&n<8;n++)await f.tick();
 assert.equal(f.entry.state,'ready');assert.equal(f.entry.eventDate,null);assert.equal(f.entry.dateStatus,'needs_clarification');
});
