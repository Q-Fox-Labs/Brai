// ABOUTME: Проверяет свёртки и дельты компактной выдачи на синтетических данных.
// ABOUTME: Тест модели использует заглушку; настоящий PostgreSQL проверяется отдельно.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {countContextTokens,topicCardChanges} from '../dist/compact-context.js';
import {summarizeTopic} from '../dist/topic-jobs.js';
import {invoke} from '../dist/api.js';

test('свёртка перерабатывает превышение 50 токенов и оставляет исходный ID',async()=>{
 let calls=0;
 const card=await summarizeTopic({async structured(){
  calls++;
  return JSON.stringify({extended:'Выпуск подтверждён. Следующий шаг — замер.',compact:calls===1?'лишнее '.repeat(60):'Выпуск подтверждён, остался замер.',source_indexes:[0]});
 }},[{dialogue_id:'dialogue',message_id:'message',text:'Исходная переписка.'}]);
 assert.equal(calls,2);
 assert.ok(countContextTokens(card.compact)<=50);
 assert.deepEqual(card.source_refs,[{dialogue_id:'dialogue',message_id:'message'}]);
 await assert.rejects(summarizeTopic({async structured(){
  return JSON.stringify({extended:'Допустимый текст.',compact:'Допустимый текст.',source_indexes:[1]});
 }},[{dialogue_id:'dialogue',message_id:'message',text:'Исходная переписка.'}]),{code:'TOPIC_SOURCE_INVALID'});
});

test('граница свёртки беседы не становится ссылкой на исходное сообщение',async()=>{
 const card=await summarizeTopic({async structured(){
  return JSON.stringify({extended:'Описание',compact:'Кратко',source_indexes:[0]});
 }},[{dialogue_id:'dialogue',message_id:'last-message',text:'Вся беседа',source_kind:'dialogue_summary'}]);
 assert.deepEqual(card.source_refs,[]);
});

test('смена уровня карточки и вытеснение темы видны после ACK',()=>{
 const topics=Array.from({length:220},(_,i)=>({
  topic_id:'topic-'+i,title:'Тема '+i,version:'1',last_activity:new Date(i),
  extended:'Развёрнуто',compact:'Коротко',extended_tokens:3,compact_tokens:2
 }));
 const before=topicCardChanges(topics,{});
 assert.equal(before.items.filter(item=>item.tier==='extended').length,20);
 assert.equal(before.items.filter(item=>item.tier==='compact').length,200);
 assert.deepEqual(topicCardChanges(topics,before.view).items,[]);
 const newTopic={...topics[0],topic_id:'new'};
 const after=topicCardChanges([newTopic,...topics.slice(0,219)],before.view);
 assert.deepEqual(after.items.map(({type,topic_id,tier})=>[type,topic_id,tier]),[
  ['topic_summary','new','extended'],['topic_summary','topic-19','compact'],['topic_removed','topic-219',undefined]
 ]);
});

test('поиск, тема и чтение архива не создают выдачу контекста',async()=>{
 const store={
  topics:{async search(owner,query){return {owner,query};},async get(owner,id){return {owner,id};}},
  async logExchange(){},async message(owner,args){return {owner,...args};},
  async pull(){assert.fail('архивное чтение не должно вызывать pull');}
 };
 const call=(action,args)=>invoke(store,'profile','dialogues_exchange',{action,arguments:{request_id:action,...args}});
 assert.equal((await call('search',{query:'номер PR'})).query,'номер PR');
 assert.equal((await call('topic_get',{topic_id:'topic'})).id,'topic');
 assert.equal((await call('read',{archive_only:true,dialogue_id:'dialogue',message_id:'message'})).message_id,'message');
});
