// ABOUTME: Проверяет свёртки и дельты компактной выдачи на синтетических данных.
// ABOUTME: Тест модели использует заглушку; настоящий PostgreSQL проверяется отдельно.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {collectCompact,countContextTokens,topicIndexChanges} from '../dist/compact-context.js';
import {chooseGrouping,summarizeTopic} from '../dist/topic-jobs.js';
import {matchesTopicReference} from '../dist/topic-references.js';
import {invoke} from '../dist/api.js';
import {DialoguesFault} from '../dist/domain.js';

test('свёртка перерабатывает превышение 50 токенов и оставляет исходный ID',async()=>{
 let calls=0;
 const card=await summarizeTopic({async structured(raw,prompt){
  calls++;
  if(calls===2){
   const previous=JSON.parse(raw);
   assert.equal(previous.previous_attempt,'лишнее '.repeat(60).trim());
   assert.ok(previous.previous_attempt_tokens>50);
   assert.deepEqual(prompt.schema.required,['text']);
   return JSON.stringify({text:'Выпуск подтверждён, остался замер.'});
  }
  return JSON.stringify({extended:'Выпуск подтверждён. Следующий шаг — замер.',compact:'лишнее '.repeat(60),source_indexes:[0]});
 }},[{dialogue_id:'dialogue',message_id:'message',text:'Исходная переписка.'}]);
 assert.equal(calls,2);
 assert.equal(card.extended,'Выпуск подтверждён. Следующий шаг — замер.');
 assert.ok(countContextTokens(card.compact)<=50);
 assert.deepEqual(card.source_refs,[{dialogue_id:'dialogue',message_id:'message'}]);
 await assert.rejects(summarizeTopic({async structured(){
  return JSON.stringify({extended:'Допустимый текст.',compact:'Допустимый текст.',source_indexes:[1]});
 }},[{dialogue_id:'dialogue',message_id:'message',text:'Исходная переписка.'}]),{code:'TOPIC_SOURCE_INVALID'});
});

test('обе формы сокращаются отдельно и не теряют принятую версию и ссылки',async()=>{
 const calls=[];
 const luna={async structured(raw,prompt){
  const input=JSON.parse(raw);calls.push({input,prompt});
  if(calls.length===1)return JSON.stringify({extended:'лишнее '.repeat(450),compact:'подробности '.repeat(60),source_indexes:[0]});
  if(input.limit===50)return JSON.stringify({text:'Короткий итог и открытый шаг.'});
  assert.equal(input.limit,400);return JSON.stringify({text:'Актуальное решение и ограничения.'});
 }};
 const card=await summarizeTopic(luna,[{dialogue_id:'d',message_id:'m',text:'Данные темы.'}]);
 assert.equal(calls.length,3);
 assert.equal(card.extended,'Актуальное решение и ограничения.');
 assert.equal(card.compact,'Короткий итог и открытый шаг.');
 assert.deepEqual(card.source_refs,[{dialogue_id:'d',message_id:'m'}]);
 assert.ok(calls.slice(1).every(call=>JSON.stringify(call.prompt.schema.required)==='["text"]'));
 assert.ok(countContextTokens(card.extended)<=400&&countContextTokens(card.compact)<=50);
});

test('успешный фрагмент темы не пересчитывается после временного сбоя',async()=>{
 let checkpoint,firstCalls=0,secondCalls=0,offline=true;
 const luna={async structured(raw){
  const data=JSON.parse(raw),first=data.sources[0].text.startsWith('X');
  if(first)firstCalls++;else secondCalls++;
  if(!first&&offline)throw new DialoguesFault('LUNA_UNAVAILABLE');
  return JSON.stringify({extended:'Суть и следующий шаг.',compact:'Суть.',source_indexes:[0]});
 }};
 const sources=[{dialogue_id:'d',message_id:'m1',text:'X'.repeat(12000)},
  {dialogue_id:'d',message_id:'m2',text:'Y'.repeat(12000)}];
 await assert.rejects(summarizeTopic(luna,sources,undefined,p=>{checkpoint=p;}),{code:'LUNA_UNAVAILABLE'});
 assert.equal(checkpoint.nextBatch,1);assert.equal(firstCalls,1);assert.equal(secondCalls,1);
 offline=false;
 const result=await summarizeTopic(luna,sources,checkpoint,p=>{checkpoint=p;});
 assert.equal(firstCalls,1);assert.equal(secondCalls,2);
 assert.deepEqual(new Set(result.source_refs.map(ref=>ref.message_id)),new Set(['m1','m2']));
});

test('группировка возвращает только выбранный короткий ID из списка или null',async()=>{
 const candidates=[{topic_id:'topic-real-a',title:'А',extended:'Первый проект'},
  {topic_id:'topic-real-b',title:'Б',extended:'Второй проект'}];
 let reply='C2';
 const luna={async structured(raw,prompt){
  const data=JSON.parse(raw);
  assert.deepEqual(data.candidates.map(c=>c.topic_id),['C1','C2']);
  assert.deepEqual(prompt.schema.properties.topic_id.enum,['C1','C2',null]);
  return JSON.stringify({topic_id:reply});
 }};
 assert.equal(await chooseGrouping(luna,{title:'Тема',text:'Задача'},candidates),'topic-real-b');
 reply=null;assert.equal(await chooseGrouping(luna,{title:'Тема',text:'Задача'},candidates),null);
 reply='topic-real-a';await assert.rejects(chooseGrouping(luna,{title:'Тема',text:'Задача'},candidates),{code:'TOPIC_CANDIDATE_INVALID'});
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

test('старые незакрытые ходы не вытесняют двадцать свежих сообщений',async()=>{
 const topics=Array.from({length:220},(_,i)=>({topic_id:'T'+(i+1),title:'Тема '+i,version:'1',
  extended:' international'.repeat(400),compact:' international'.repeat(50)}));
 const messages=Array.from({length:20},(_,i)=>({message_id:'M'+(i+1),revision:String(401+i),
  role:'user',text:'Свежее сообщение '+i,exact:true}));
 const work=Array.from({length:400},(_,i)=>({dialogue_id:'open-thread-'+i,turn_id:'turn-'+i,version:'1',
  status:'open',purpose:' international'.repeat(150),constraints_text:null,pending:[],revision:String(i+1)}));
 const db={async query(sql){
  if(sql.includes('FROM dialogues_live.topics'))return {rows:topics};
  if(sql.includes('FROM dialogues_live.messages m'))return {rows:[...messages].reverse()};
  return {rows:work};
 }};
 const first=await collectCompact(db,'owner',{boundary:'420',checkpoint:'0',bootstrap:true,inputIds:[],automatic:true,previous:{}});
 assert.equal(first.selected,20);
 assert.ok(Number(first.through)<400);
 assert.equal(first.items[0].text.match(/^M\d+ /gmu).length,20);
 const next=await collectCompact(db,'owner',{boundary:'420',checkpoint:first.through,bootstrap:false,inputIds:[],automatic:true,previous:first.view});
 assert.doesNotMatch(next.items[0].text,/^M\d+ /mu);
});

test('поиск, тема и чтение архива не создают выдачу контекста',async()=>{
 const store={
  topics:{async search(owner,query){return {owner,query};},async get(owner,id){return {owner,id};}},
  async logExchange(){},async message(owner,args){return {owner,...args};},
  async turnGet(owner,args){return {owner,...args};},
  async history(owner,args){return {owner,...args};},
  async pull(){assert.fail('архивное чтение не должно вызывать pull');}
 };
 const call=(action,args,context)=>invoke(store,'profile','dialogues_exchange',{action,arguments:{request_id:action,...args},...(context?{context}:{})});
 assert.equal((await call('search',{query:'номер PR'})).query,'номер PR');
 assert.equal((await call('topic_get',{topic_id:'topic'})).id,'topic');
 assert.equal((await call('read',{dialogue_id:'dialogue',message_id:'message'})).message_id,'message');
 assert.equal((await call('history',{dialogue_id:'dialogue'})).dialogue_id,'dialogue');
 assert.equal((await call('snapshot',{dialogue_id:'dialogue',turn_id:'turn'})).turn_id,'turn');
 const legacyContext={consumer_id:'legacy-reader'};
 assert.equal((await call('read',{archive_only:true,dialogue_id:'dialogue',message_id:'message'},legacyContext)).message_id,'message');
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
