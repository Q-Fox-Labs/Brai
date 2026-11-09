// ABOUTME: Проверяет ограниченный порт свёртки без модели и общего Codex socket.
// ABOUTME: Занятость и потеря доступа не публикуют завершённый результат.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createPersonalSummarizer} from '../dist/personal-summary.js';
test('персональная свёртка проверяет доступ и сохраняет только завершённый результат',async()=>{
 let checks=0,calls=0;const states=[];
 const summary=createPersonalSummarizer('/protected/socket',async()=>{checks++;},async(path,method,args)=>{
  assert.equal(method,'dialogues.summarize');assert.deepEqual(Object.keys(args),['input']);calls++;return {status:'completed',result:'37 рублей'};
 });
 assert.equal(await summary.run('исходник',{},async s=>states.push(s)),'37 рублей');
 assert.equal(checks,2);assert.equal(calls,1);assert.equal(states.at(-1).execution_state,'completed');
 await summary.run('исходник',states.at(-1),async()=>assert.fail('completed state must be reused'));assert.equal(calls,1);
 const busy=createPersonalSummarizer('/protected/socket',async()=>{},async()=>({status:'busy'}));
 await assert.rejects(busy.run('input',{},async()=>{}),{code:'LUNA_BUSY'});
 let permitted=true;const denied=createPersonalSummarizer('/protected/socket',async()=>{if(!permitted)throw Error('revoked');},async()=>{permitted=false;return {status:'completed',result:'private'};});
 const saved=[];await assert.rejects(denied.run('input',{},async s=>saved.push(s)),/revoked/);
 assert.equal(saved.some(s=>s.execution_state==='completed'),false);
});
