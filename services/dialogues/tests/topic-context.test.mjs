// ABOUTME: Проверяет свёртки и дельты компактной выдачи на синтетических данных.
// ABOUTME: Тест модели использует заглушку; настоящий PostgreSQL проверяется отдельно.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {countContextTokens,topicIndexChanges} from '../dist/compact-context.js';
import {chooseGrouping,summarizeTopic} from '../dist/topic-jobs.js';
import {matchesTopicReference} from '../dist/topic-references.js';
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
  topic_id:'T'+(i+1),title:'Тема '+i,version:'1',last_activity:new Date(i),
  extended:'Развёрнуто',compact:'Коротко',extended_tokens:3,compact_tokens:2
 }));
 const before=topicIndexChanges(topics,{});
 assert.equal(before.lines.length,220);
 assert.equal(before.lines.filter(line=>line.includes('Развёрнуто')).length,20);
 assert.equal(before.lines.filter(line=>line.includes('Коротко')).length,200);
 assert.deepEqual(topicIndexChanges(topics,before.view).lines,[]);
 const newTopic={...topics[0],topic_id:'T221'};
 const after=topicIndexChanges([newTopic,...topics.slice(0,219)],before.view);
 assert.deepEqual(after.lines,['T221 "Тема 0" "Развёрнуто"','T20 "Тема 19" "Коротко"','-T220']);
});

test('индекс сохраняет все 220 тем даже с длинным написанием одного токена',()=>{
 const word=' international';
 assert.equal(countContextTokens(word.repeat(400)),400);
 const topics=Array.from({length:220},(_,i)=>({topic_id:'T'+(i+1),title:'Тема '+i,version:'1',
  extended:word.repeat(400),compact:word.repeat(50)}));
 const {lines,view}=topicIndexChanges(topics,{});
 assert.equal(lines.length,220);
 assert.ok(JSON.stringify(lines.join('\n')).length<200_000);
 assert.ok(lines.every((line,i)=>line.startsWith('T'+(i+1)+' ')&&line.includes('international')));
 assert.deepEqual(topicIndexChanges(topics,view).lines,[]);
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

test('PR сравнивается целиком вместе с репозиторием, имя файла тоже целиком',()=>{
 const query='Дальше https://github.com/Foo/Bar/pull/12';
 assert.equal(matchesTopicReference(query,'Тема запроса','PR foo/bar#012'),true);
 assert.equal(matchesTopicReference(query,'Тема запроса','https://github.com/Foo/Bar/pull/123'),false);
 assert.equal(matchesTopicReference(query,'Тема запроса','PR foo/other#12'),false);
 assert.equal(matchesTopicReference('Напомни PR #12','Тема запроса','PR foo/bar#12'),false);
 assert.equal(matchesTopicReference('Проверь src/main.ts','Код сервиса','Файл src/main.ts'),true);
 assert.equal(matchesTopicReference('Проверь src/main.ts','Код сервиса','Файл src/main.ts.bak'),false);
 assert.equal(matchesTopicReference('Проверь src/main.ts','Код сервиса','Файл other/src/main.ts'),false);
 assert.equal(matchesTopicReference('Проверь src/main.ts.','Код сервиса','Файл src/main.ts'),true);
 assert.equal(matchesTopicReference('Открой component.json','Конфигурация','Файлы component.json, settings.toml, Dockerfile'),true);
 assert.equal(matchesTopicReference('Проверь Dockerfile','Конфигурация','Файл Dockerfile.dev'),false);
});

test('модель не вызывается, если все найденные кандидаты ссылаются на другой PR',async()=>{
 const luna={async structured(){assert.fail('сравниваемые PR уже отличаются');}};
 const input={title:'Выпуск',text:'https://github.com/team/app/pull/12'};
 const candidates=[
  {topic_id:'prefix',title:'Выпуск',extended:'https://github.com/team/app/pull/123'},
  {topic_id:'other-repo',title:'Выпуск',extended:'Проверка выпуска.',evidence:'https://github.com/team/docs/pull/12'},
 ];
 assert.equal(await chooseGrouping(luna,input,candidates),null);
});
