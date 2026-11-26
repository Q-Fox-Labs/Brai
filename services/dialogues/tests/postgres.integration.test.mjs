// ABOUTME: Проверяет новый обмен и миграцию на настоящем изолированном PostgreSQL.
// ABOUTME: Использует только явно переданный одноразовый fixture с синтетическими данными.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHmac} from 'node:crypto';
import {Pool} from 'pg';
import {migrate} from '../dist/migrate.js';
import {createStore} from '../dist/store.js';
import {exchange} from '../dist/exchange.js';
import {createTopicJobs,seedTopicIndex} from '../dist/topic-jobs.js';
import {countContextTokens} from '../dist/compact-context.js';
import {backfill,ensureBackfilled} from '../dist/backfill.js';
import {createJobs} from '../dist/jobs.js';
import {DialoguesFault} from '../dist/domain.js';

const ownerUrl=process.env.DIALOGUES_TEST_OWNER_DATABASE_URL,appUrl=process.env.DIALOGUES_TEST_DATABASE_URL;
test('PostgreSQL: обмен, контекст, история и перенос саммари',{skip:!ownerUrl||!appUrl},async t=>{
 const owner=new Pool({connectionString:ownerUrl}),app=new Pool({connectionString:appUrl,max:8}),who='test-owner';
 const api=createStore(app,'synthetic-key'),ctx={consumer_id:'reader',context_instance_id:'instance'};
 let counter=0;const req=()=>`new-test-${++counter}`;
 const execute=(action,args,context=ctx)=>exchange(api,who,{action,arguments:args,context:{format:'legacy',...context}});
 async function consume(result){
  let page=result.context;
  if(result.context_error){assert.equal(result.context_error.code,'CONTEXT_DEFERRED');page=await api.pull(who,result.context_error.arguments);}
  if(!page||!page.delivery_id)return page?.items??[];
  const delivery=page.delivery_id,items=[...page.items];
  while(page.continuation_cursor){page=await api.pull(who,{request_id:result.context_request_id,...ctx,continuation_cursor:page.continuation_cursor});items.push(...page.items);}
  await api.ack(who,{request_id:req(),...ctx,delivery_id:delivery});
  return items;
 }
 try{
  if(process.env.DIALOGUES_TEST_RESTART==='true'){
   assert.equal((await api.message(who,{dialogue_id:'seed',message_id:'msg-0'})).text,'текст 0');
   await migrate(owner,'dialogues_test_owner','dialogues_test_app');return;
  }
  const legacy=readFileSync(new URL('../migrations/001.sql',import.meta.url),'utf8').replace(":'dialogues_app_role'","'dialogues_test_app'").replaceAll(':"dialogues_app_role"','"dialogues_test_app"');
  await owner.query(legacy);await migrate(owner,'dialogues_test_owner','dialogues_test_app');await migrate(owner,'dialogues_test_owner','dialogues_test_app');
  await assert.rejects(app.query("UPDATE dialogues_live.messages SET text='forbidden'"),{code:'42501'});

  await t.test('один input получает только невиденные тредом изменения и сохраняет стир',async()=>{
   const profile='one-input-fixture';
   const input=(dialogue,id,text,request_id=req(),owner=profile)=>exchange(api,owner,{action:'input',
    arguments:{request_id,dialogue:{id:dialogue,channel:'synthetic',title:dialogue},messages:[{id,text}]}});
   const first=await input('thread-a','start','Первая задача');
   assert.equal(first.context,null);
   const other=await input('thread-b','start','Параллельная задача');
   assert.match(other.context,/Первая задача/);
   assert.doesNotMatch(other.context,/Параллельная задача/);

   const request=req();
   const steer=await input('thread-a','steer-1','Дополнение к первой задаче',request);
   assert.equal(steer.turn_id,first.turn_id);
   assert.equal(steer.created,false);
   assert.match(steer.context,/Параллельная задача/);
   assert.doesNotMatch(steer.context,/Дополнение к первой задаче/);
   assert.deepEqual(await input('thread-a','steer-1','Дополнение к первой задаче',request),steer);
   const noUpdates=await input('thread-a','steer-2','Ещё одно уточнение');
   assert.equal(noUpdates.context,null);

   await input('foreign','start','Чужой профиль',req(),'another-profile');
   assert.equal((await input('thread-a','steer-3','Локальное уточнение')).context,null);
   await input('thread-b','steer-1','В параллельном треде новая деталь');
   const update=await input('thread-a','steer-4','Ещё локальное уточнение');
   assert.match(update.context,/В параллельном треде новая деталь/);
   assert.doesNotMatch(update.context,/Параллельная задача|Чужой профиль|Локальное уточнение/);
   assert.equal((await input('thread-a','steer-5','Продолжаем')).context,null);

   const emptyProfile='empty-thread-fixture',emptyRequest=req();
   assert.equal((await input('empty','first','Пустой снимок',emptyRequest,emptyProfile)).context,null);
   await api.append(emptyProfile,{request_id:req(),dialogue:{id:'new-other-thread',channel:'synthetic'},
    messages:Array.from({length:25},(_,i)=>({id:'new-'+i,turn_id:'turn',role:'user',kind:'input',text:'Событие архива '+i}))});
   assert.equal((await input('empty','first','Пустой снимок',emptyRequest,emptyProfile)).context,null);
   const afterEmpty=await input('empty','new','Обновления',req(),emptyProfile);
   assert.equal(afterEmpty.context.split('Событие архива ').length-1,25);
  });

  await t.test('общая тема выдаёт только сведения других тредов',async()=>{
   const profile='shared-topic-delta-fixture';
   const input=(dialogue,id,text)=>exchange(api,profile,{action:'input',
    arguments:{request_id:req(),dialogue:{id:dialogue,channel:'synthetic',title:dialogue},messages:[{id,text}]}});
   const poll=(afterResponse)=>exchange(api,profile,{action:'poll',arguments:{request_id:req(),dialogue_id:'shared-a'}},afterResponse);
   await input('shared-a','a1','Собственный факт A1');
   await input('shared-b','b1','Другой факт B1');
   const row=(await app.query("SELECT 'T'||short_id AS ref FROM dialogues_live.topics WHERE owner_id=$1 AND home_dialogue_id='shared-b'",[profile])).rows[0];
   await exchange(api,profile,{action:'topic_move',arguments:{request_id:req(),dialogue_id:'shared-a',topic_id:row.ref}});
   await app.query(`INSERT INTO dialogues_live.topic_summaries
    (owner_id,topic_id,version,source_digest,membership_version,extended,compact,extended_tokens,compact_tokens,source_refs,change_seq)
    SELECT owner_id,id,1,'synthetic',membership_version,'Собственный факт A1 и другой факт B1','A1 и B1',10,5,'[]',nextval('dialogues_live.change_seq')
    FROM dialogues_live.topics WHERE owner_id=$1 AND home_dialogue_id='shared-b'`,[profile]);
   const initial=await poll();
   assert.match(initial.context,/Другой факт B1/);
   assert.doesNotMatch(initial.context,/Собственный факт A1/);
   assert.equal((await input('shared-a','a2','Собственный факт A2')).context,null);
   await input('shared-b','b2','Другой факт B2');
   const pending=await poll(()=>{});
   assert.match(pending.context,/Другой факт B2/);
   assert.doesNotMatch(pending.context,/Собственный факт A2/);
   const repeated=await poll();
   assert.equal(repeated.context,pending.context);
   assert.equal((await poll()).context,null);
   await input('shared-b','b3','Другой факт B3');
   const mixed=await input('shared-a','a3','Собственный факт A3');
   assert.match(mixed.context,/Другой факт B3/);
   assert.doesNotMatch(mixed.context,/Собственный факт A3/);
  });

  await t.test('старт после миграции показывает старую свёртку до вызова модели',async()=>{
   const profile='upgrade-index-fixture';
   const old={id:'old-task',channel:'synthetic',title:'Архивный проект'};
   const fact='Стенд перенесён в отдельный контур.';
   await api.append(profile,{request_id:req(),dialogue:old,messages:[
    {id:'first',turn_id:'old',role:'user',kind:'input',text:'Старое сообщение',occurred_at:'2025-01-01T00:00:00Z'}
   ]});
   await api.summary(profile,{request_id:req(),dialogue_id:old.id,through_message_id:'first',target:'dialogue',
    expected_version:null,text:fact+' '+('Детали '.repeat(2500))});
   await api.append(profile,{request_id:req(),dialogue:{...old,id:'message-summary-only',title:'Отдельный стенд'},messages:[
    {id:'only',turn_id:'old',role:'user',kind:'input',text:'Исходный длинный текст. '.repeat(10),
     summary:'Репозиторий уже перенесён.',occurred_at:'2025-01-01T00:00:00Z'}
   ]});
   await owner.query('DELETE FROM dialogues_live.topic_members WHERE owner_id=$1',[profile]);
   await owner.query('DELETE FROM dialogues_live.topics WHERE owner_id=$1',[profile]);
   await api.append(profile,{request_id:req(),dialogue:{id:'newer',channel:'synthetic'},
    messages:Array.from({length:25},(_,i)=>({id:'recent-'+i,turn_id:'recent',role:'user',kind:'input',
     text:'Свежий текст '+i,occurred_at:'2025-01-02T00:00:00Z'}))});
   assert.equal(await seedTopicIndex(app,profile),2);
   assert.equal(await seedTopicIndex(app,profile),0);
   const input=(owner,id)=>exchange(api,owner,{action:'input',arguments:{request_id:req(),
    dialogue:{id:'new',channel:'synthetic'},messages:[{id,text:'Начало работы'}]}});
   const first=await input(profile,'input-1');
   const line=first.context.split('\n').find(line=>line.includes(fact));
   assert.match(line,/^T[1-9]\d* "Архивный проект" .*\[из архива\]$/u);
   assert.ok(countContextTokens(JSON.parse(line.split('"Архивный проект" ')[1].split(' [из архива]')[0]))<=400);
   assert.match(first.context,/^T[1-9]\d* "Отдельный стенд" "Репозиторий уже перенесён." \[из архива\]$/mu);
   assert.doesNotMatch(first.context,/Старое сообщение|Исходный длинный текст/u);
   assert.equal((await input(profile,'input-2')).context,null);
   assert.equal((await input('another-owner','input-1')).context,null);
  });

  await t.test('темы дают свёртки бесед, история — короткие оригиналы и пакетное чтение M',async()=>{
   const profile='archive-fixture';
   const long='А🙂Б'.repeat(5600);
   const rareOriginal=String.fromCodePoint(0x10ffff).repeat(100);
   const run=(action,arguments_,owner=profile)=>exchange(api,owner,{action,arguments:{request_id:req(),...arguments_}});
   const create=(dialogue,messages)=>api.append(profile,{request_id:req(),dialogue:{id:dialogue,channel:'synthetic',title:dialogue},
    messages:messages.map(message=>({turn_id:'turn',role:'user',kind:'input',...message}))});
   await create('thread-first',[{id:'m-first',text:'Короткий оригинал.',source:{kind:'telegram',attachments:[{artifactId:'synthetic-file'}]}},{id:'m-long',text:long,summary:'Краткая свёртка длинного.'}]);
   await create('thread-second',[{id:'m-other',text:'Родственная задача.'},{id:'m-rare',text:rareOriginal}]);
   const page=await api.pull(profile,{request_id:req(),consumer_id:'index',context_instance_id:'default',format:'index'});
   const lines=page.items[0].text.split('\n');
   assert(lines.some(line=>line.includes(JSON.stringify(rareOriginal))));
   assert.match(lines[0],/topic_get.*dialogue_get.*read_many/u);
   const topicFor=title=>lines.find(line=>line.includes('"'+title+'"')).split(' ')[0];
   const firstTopic=topicFor('thread-first'),secondTopic=topicFor('thread-second');
   const oldClient = await api.pull(profile,{request_id:req(),consumer_id:'old-compact',context_instance_id:'default',format:'compact'});
   const oldCard = oldClient.items.find(i=>i.type==='topic_summary'&&i.title==='thread-first');
   assert.match(oldCard.topic_id,/^topic-[0-9a-f]{64}$/);
   const oldTopic = await run('topic_get',{topic_id:oldCard.topic_id,after:'thread-firs'});
   assert.deepEqual(oldTopic.dialogues,[{dialogue_id:'thread-first',title:'thread-first',channel:'synthetic'}]);

   assert.match(firstTopic,/^T[1-9]\d*$/);
   assert.match(secondTopic,/^T[1-9]\d*$/);
   await run('topic_move',{dialogue_id:'thread-second',topic_id:firstTopic});
   const detail=await run('topic_get',{topic_id:firstTopic});
   assert.equal(detail.dialogues.length,2);
   assert.ok(detail.dialogues.every(d=>/^D[1-9]\d*$/.test(d.dialogue_id)&&d.summary));
   await api.summary(profile,{request_id:req(),dialogue_id:'thread-first',through_message_id:'m-first',
    target:'dialogue',expected_version:null,text:'Сводка первой части.'});
   const incomplete=await run('topic_get',{topic_id:firstTopic});
   assert.equal(incomplete.dialogues.find(d=>d.title==='thread-first').summary_incomplete,true);
   assert.equal((await run('topic_get',{topic_id:secondTopic})).topic_id,firstTopic);
   const dialog=detail.dialogues.find(d=>d.title==='thread-first').dialogue_id;
   const history=await run('dialogue_get',{dialogue_id:dialog});
   assert.deepEqual(history.items.map(i=>[i.representation,i.text]),
    [['original','Короткий оригинал.'],['summary','Краткая свёртка длинного.']]);
   assert.equal(history.items[0].attachments,true);
   const ids=history.items.map(i=>i.message_id);
   assert.ok(ids.every(i=>/^M[1-9]\d*$/.test(i)));
   let cursor,combined=new Map();
   do{
    const read=await run('read_many',{message_ids:ids,...(cursor?{cursor}:{})});
    for(const message of read.messages){
     if(message.message_id===ids[0])assert.deepEqual(message.attachments,[{artifactId:'synthetic-file'}]);
     const prior=combined.get(message.message_id)??'';
     assert.equal(Array.from(prior).length,message.offset);
     combined.set(message.message_id,prior+message.text);
    }
    if(read.continuation_cursor)await assert.rejects(run('read_many',{message_ids:ids.slice().reverse(),cursor:read.continuation_cursor}),{code:'INVALID_CURSOR'});
    cursor=read.continuation_cursor;
   }while(cursor);
   assert.deepEqual(ids.map(id=>combined.get(id)),['Короткий оригинал.',long]);
   const found=await run('search',{query:'Короткий оригинал.'});
   assert.equal(found.messages[0].message_id,'m-first');
   assert.equal((await run('read',{dialogue_id:'thread-first',message_id:'m-long',target:'original',archive_only:true,limit:3})).text,'А🙂Б');
   await assert.rejects(run('topic_get',{topic_id:firstTopic},'foreign'),{code:'NOT_FOUND'});
   await assert.rejects(run('dialogue_get',{dialogue_id:dialog},'foreign'),{code:'NOT_FOUND'});
   await assert.rejects(run('read_many',{message_ids:ids},'foreign'),{code:'NOT_FOUND'});
  });

  await t.test('неудачная авторизация Luna восстанавливает только актуальное задание',async()=>{
   const profile='auth-recovery-fixture';
   let online=false;
   const luna={async probe(){if(!online)throw new DialoguesFault('LUNA_AUTH_UNAVAILABLE');},
    async run(){assert.equal(online,true);return 'Сохранённая свёртка';}};
   const jobs=createJobs(app,profile,luna);
   await api.append(profile,{request_id:req(),dialogue:{id:'recovery',channel:'synthetic'},
    messages:Array.from({length:10},(_,i)=>({id:'m'+i,turn_id:'t'+i,role:'user',kind:'input',text:'Вход '+i}))});
   for(let i=0;i<3;i++){
    await owner.query("UPDATE dialogues_live.summary_jobs SET available_at=now() WHERE owner_id=$1",[profile]);
    await jobs.tick();
   }
   assert.equal((await app.query("SELECT state FROM dialogues_live.summary_jobs WHERE owner_id=$1",[profile])).rows[0].state,'failed');
   online=true;
   await owner.query("UPDATE dialogues_live.summary_jobs SET available_at=now() WHERE owner_id=$1",[profile]);
   await jobs.tick();
   assert.deepEqual((await app.query("SELECT state,attempts,error_code FROM dialogues_live.summary_jobs WHERE owner_id=$1",[profile])).rows[0],
    {state:'succeeded',attempts:1,error_code:null});
   assert.equal((await app.query("SELECT count(*)::integer AS n FROM dialogues_live.dialogue_summaries WHERE owner_id=$1",[profile])).rows[0].n,1);
  });

  await t.test('другие временные отказы и истёкшие аренды восстанавливаются после проверки модели',async()=>{
   for(const code of ['LUNA_NOT_AVAILABLE','LUNA_PROBE_FAILED','LUNA_CATALOG_UNAVAILABLE','ATTEMPTS_EXHAUSTED']){
    const profile='recovery-'+code;
    let online=false;
    const luna={async probe(){if(!online)throw new DialoguesFault('LUNA_UNAVAILABLE');},
     async run(){return 'Свёртка после восстановления';}};
    const jobs=createJobs(app,profile,luna);
    await api.append(profile,{request_id:req(),dialogue:{id:'recovery',channel:'synthetic'},
     messages:Array.from({length:10},(_,i)=>({id:'m'+i,turn_id:'t'+i,role:'user',kind:'input',text:'Вход '+i}))});
    await owner.query("UPDATE dialogues_live.summary_jobs SET state='failed',attempts=3,error_code=$2,available_at=now() WHERE owner_id=$1",[profile,code]);
    await jobs.tick();
    assert.equal((await app.query("SELECT state FROM dialogues_live.summary_jobs WHERE owner_id=$1",[profile])).rows[0].state,'failed');
    online=true;
    await Promise.all([jobs.tick(),createJobs(app,profile,luna).tick()]);
    assert.equal((await app.query("SELECT state FROM dialogues_live.summary_jobs WHERE owner_id=$1",[profile])).rows[0].state,'succeeded');
    assert.equal((await app.query("SELECT count(*)::integer AS n FROM dialogues_live.dialogue_summaries WHERE owner_id=$1",[profile])).rows[0].n,1);
   }
  });

  await t.test('фон сохраняет компактную версию отдельно от обычного саммари',async()=>{
   const profile='topic-worker-fixture';
   const dialogue={id:'worker',channel:'synthetic',title:'Уточнение PR'};
   await api.append(profile,{request_id:req(),dialogue,messages:[
    {id:'big',turn_id:'turn',role:'user',kind:'input',text:'Проверка. '.repeat(50),
     summary:'Обычное саммари. '.repeat(400)}
   ]});
   const generator={async structured(input){
    const data=JSON.parse(input);
    if(data.sources)return JSON.stringify({extended:'Запланирована проверка.',compact:'Нужна проверка.',source_indexes:[0]});
    return JSON.stringify({text:'Короткая проверка.'});
   }};
   const jobs=createTopicJobs(app,profile,generator);
   const lease=await app.connect();
   try{
    await lease.query('SELECT pg_advisory_lock(hashtextextended($1,0))',['dialogues-topic-worker:'+profile]);
    await assert.rejects(jobs.tick({requireIdleWorker:true}),{code:'TOPIC_WORKER_BUSY'});
   }finally{
    await lease.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',['dialogues-topic-worker:'+profile]);
    lease.release();
   }
   assert.equal(await jobs.tick(),true);
   assert.equal(await jobs.tick(),true);
   const same=await api.message(profile,{dialogue_id:dialogue.id,message_id:'big',target:'message_summary'});
   assert.match(same.text,/Обычное саммари/);
   const context=await api.pull(profile,{request_id:req(),consumer_id:'worker-reader',context_instance_id:'default',format:'index'});
   assert.match(context.items[0].text,/Запланирована проверка\./);
   assert.match(context.items[0].text,/Короткая проверка\./);
  });

  await t.test('фон автоматически группирует одну задачу и сохраняет ручное разделение',async()=>{
   const profile='topic-grouping-fixture';
   for(const [id,message] of [
    ['first','Проверка выпуска PR 123'],['second','Продолжение проверки выпуска PR 123'],
    ['other','Отдельная проверка выпуска PR 124']
   ]){
    await api.append(profile,{request_id:req(),dialogue:{id,channel:'synthetic',title:'Проверка выпуска'},
     messages:[{id:'request',turn_id:'turn',role:'user',kind:'input',text:message}]});
   }
   let continuationOf='';
   const generator={async structured(input){
    const data=JSON.parse(input);
    if(data.candidates){
     const sameTask=data.dialogue.text.includes('Точный следующий шаг')?continuationOf:'PR 123';
     const candidate=data.dialogue.text.includes('PR 123')&&data.candidates.find(item=>item.extended.includes(sameTask));
     return JSON.stringify({topic_id:candidate?candidate.topic_id:null});
    }
    const text=data.sources.map(source=>source.text).join(' ');
    return JSON.stringify({extended:text,compact:text,source_indexes:[0]});
   }};
   const memberships=async()=>Object.fromEntries((await app.query(`SELECT dialogue_id,topic_id
    FROM dialogues_live.topic_members WHERE owner_id=$1`,[profile])).rows.map(row=>[row.dialogue_id,row.topic_id]));
   const initial=await memberships();
   assert.equal(new Set(Object.values(initial)).size,3);
   const jobs=createTopicJobs(app,profile,generator);
   while(await jobs.tick()){}
   const grouped=await memberships();
   assert.equal(grouped.first,grouped.second);
   assert.equal(grouped.other,initial.other);
   assert.notEqual(grouped.other,grouped.first);
   const moved=grouped.first===initial.first?'second':'first';
   await api.topics.move(profile,req(),moved,null);
   while(await jobs.tick()){}
   assert.deepEqual(await memberships(),initial);
   continuationOf=moved==='first'?'Проверка выпуска PR 123':'Продолжение проверки выпуска PR 123';
   await api.append(profile,{request_id:req(),dialogue:{id:'followup',channel:'synthetic',title:'Проверка выпуска'},
    messages:[{id:'request',turn_id:'turn',role:'user',kind:'input',text:'Точный следующий шаг для PR 123'}]});
   while(await jobs.tick()){}
   assert.deepEqual(await memberships(),{...initial,followup:initial[moved]});
  });

  await t.test('сначала сопоставляет новое свидетельство, затем обновляет только итоговую тему',async()=>{
   const profile='grouping-order-fixture';
   const append=(id,title,message,text)=>api.append(profile,{request_id:req(),dialogue:{id,channel:'synthetic',title},
    messages:[{id:message,turn_id:'turn',role:'user',kind:'input',text,...(text.length>100?{summary:'Краткий след сообщения'}:{})}]});
   const target='https://github.com/team/app/pull/12';
   const calls=[];
   const generator={async structured(input){
    const data=JSON.parse(input);
    if(data.candidates){
     calls.push('group');
     return JSON.stringify({topic_id:data.dialogue.text.includes('PR team/app#12')?data.candidates[0].topic_id:null});
    }
    calls.push('summary');
    return JSON.stringify({extended:'Проверка выпуска '+target,compact:'Проверка выпуска.',source_indexes:[0]});
   }};
   await append('initial','Проверка выпуска','target','Проверка '+target);
   const jobs=createTopicJobs(app,profile,generator);
   while(await jobs.tick()){}
   assert.deepEqual(calls,['summary']);

   await append('new','Новый разговор','greeting','Продолжим');
   calls.length=0;
   while(await jobs.tick()){}
   assert.deepEqual(calls,['summary']);

   await api.append(profile,{request_id:req(),dialogue:{id:'new',channel:'synthetic',title:'Новый разговор'},
    messages:Array.from({length:25},(_,i)=>({id:'extra-'+i,turn_id:'turn',role:'user',kind:'input',
     text:i===21?'А'.repeat(6100)+' Перепроверю '+target:'Б'.repeat(6100),summary:'Краткий след сообщения'}))});
   await append('initial','Проверка выпуска','latest','Уточнение по уже готовой теме.');
   calls.length=0;
   while(await jobs.tick()){}
   assert.deepEqual(calls,['group','summary']);
   const rows=(await app.query('SELECT topic_id FROM dialogues_live.topic_members WHERE owner_id=$1',[profile])).rows;
   assert.equal(rows.length,2);
   assert.equal(rows[0].topic_id,rows[1].topic_id);
  });

  await t.test('проверяет вход, который пришёл между сопоставлением и чтением состояния',async()=>{
   const profile='grouping-watermark-fixture';
   const append=(message,text)=>api.append(profile,{request_id:req(),dialogue:{id:'race',channel:'synthetic',title:'Работа'},
    messages:[{id:message,turn_id:'turn',role:'user',kind:'input',text}]});
   await append('first','Первый вход');
   let inject=true,cards=0;
   const pool={async connect(){
    const client=await app.connect();
    return {release:()=>client.release(),async query(sql,params){
     if(inject&&sql.startsWith('WITH member_state AS')){
      inject=false;
      await append('during-read','Новый факт для сопоставления');
     }
     return await client.query(sql,params);
    }};
   }};
   const jobs=createTopicJobs(pool,profile,{async structured(input){
    ++cards;
    return JSON.stringify({extended:'Суть работы.',compact:'Работа.',source_indexes:[0]});
   }});
   assert.equal(await jobs.tick(),true);
   assert.equal(cards,0);
   assert.equal(await jobs.tick(),true);
   assert.equal(cards,1);
   assert.equal(await jobs.tick(),false);
   const [{checked_at,evidence_seq,dirty_seq}]=(await app.query(`SELECT checked_at,evidence_seq,dirty_seq
    FROM dialogues_live.topic_members tm JOIN dialogues_live.topics t ON t.owner_id=tm.owner_id AND t.id=tm.topic_id
    WHERE tm.owner_id=$1`,[profile])).rows;
   assert.equal(checked_at,evidence_seq);
   assert.equal(dirty_seq,null);
  });

  await t.test('архив из 1000 тем сохраняет лимит bootstrap и исторический импорт в дельте',async()=>{
   const profile='large-topic-fixture',context={consumer_id:'large-reader',context_instance_id:'default',format:'index'};
   await app.query(`INSERT INTO dialogues_live.dialogues(owner_id,id,channel,title)
    SELECT $1,'dialogue-'||i,'synthetic','Проверка архива '||i FROM generate_series(1,1000) g(i)`,[profile]);
   await app.query(`INSERT INTO dialogues_live.turns(owner_id,dialogue_id,id,turn_order,status,change_seq)
    SELECT $1,id,'turn',1,'completed',1 FROM dialogues_live.dialogues WHERE owner_id=$1`,[profile]);
   await app.query(`INSERT INTO dialogues_live.messages(owner_id,dialogue_id,turn_id,id,role,kind,message_order,item_order,text,payload,content_hash,occurred_at,source,change_seq)
    SELECT $1,id,'turn','first','user','input',1,1,'Запись '||id,'{}','synthetic',to_timestamp(1000000000+row_number() over (ORDER BY id)),'{}',1
    FROM dialogues_live.dialogues WHERE owner_id=$1`,[profile]);
   await app.query(`INSERT INTO dialogues_live.requests(owner_id,id,operation,hash,result,change_seq)
    VALUES($1,'seed-fixture','import','synthetic','{}',nextval('dialogues_live.change_seq'))`,[profile]);
   await app.query(`INSERT INTO dialogues_live.dialogue_summaries(owner_id,dialogue_id,version,text,through_message_id,through_order,change_seq)
    SELECT owner_id,dialogue_id,1,'Расширенная архивная карточка',id,1,1 FROM dialogues_live.messages WHERE owner_id=$1`,[profile]);
   const jobs=createTopicJobs(app,profile,{structured:async()=>assert.fail('используем заданные свёртки')});
   assert.equal(await jobs.seed(),1000);
   await app.query(`INSERT INTO dialogues_live.topic_summaries(owner_id,topic_id,version,source_digest,membership_version,extended,compact,extended_tokens,compact_tokens,source_refs,change_seq)
    SELECT $1,id,1,'synthetic',0,$2,$3,$4,$5,'[]',1 FROM dialogues_live.topics WHERE owner_id=$1`,
    [profile,'Расширенная архивная карточка','Короткая карточка',countContextTokens('Расширенная архивная карточка'),countContextTokens('Короткая карточка')]);
   const request=req();
   let page=await api.pull(profile,{request_id:request,...context});
   const delivery=page.delivery_id,items=[...page.items],pages=[page];
   while(page.continuation_cursor){
    page=await api.pull(profile,{request_id:request,consumer_id:context.consumer_id,context_instance_id:context.context_instance_id,
     continuation_cursor:page.continuation_cursor});
    items.push(...page.items);pages.push(page);
   }
   const index=items.find(item=>item.type==='context_index').text;
   assert.equal(index.split('Расширенная архивная карточка').length-1,20);
   assert.equal(index.split('Короткая карточка').length-1,200);
   assert.equal(index.split('Последние сообщения\n')[1].split('\n').length,20);
   assert.ok(countContextTokens(index)<=22000);
   assert.equal((await api.ack(profile,{request_id:req(),delivery_id:delivery,consumer_id:context.consumer_id,context_instance_id:context.context_instance_id})).acknowledged,true);
   const legacyReq=req(),legacy={consumer_id:'legacy-reader',context_instance_id:'default'};
   let legacyPage=await api.pull(profile,{request_id:legacyReq,...legacy});
   const legacyPages=[legacyPage];
   while(legacyPage.continuation_cursor){
    legacyPage=await api.pull(profile,{request_id:legacyReq,...legacy,continuation_cursor:legacyPage.continuation_cursor});
    legacyPages.push(legacyPage);
   }
   const measure=rows=>({pages:rows.length,bytes:rows.reduce((n,p)=>n+Buffer.byteLength(JSON.stringify(p)),0),
    tokens:rows.reduce((n,p)=>n+countContextTokens(JSON.stringify(p)),0)});
   const sizes={legacy:measure(legacyPages),compact:measure(pages)};
   assert.ok(sizes.compact.tokens<sizes.legacy.tokens);
   console.log(JSON.stringify({fixture:'1000-topics',...sizes}));
   const changes=Array.from({length:21},(_,i)=>({
    turn_id:'older',id:'old-'+i,role:'user',kind:'input',text:'Исторический импорт '+i,occurred_at:'1999-01-01T00:00:00Z'
   }));
   await api.append(profile,{request_id:req(),dialogue:{id:'dialogue-1',channel:'synthetic'},messages:changes});
   const update=await api.pull(profile,{request_id:req(),...context});
   assert.equal(update.summaries_mode,'updates');
   assert.equal(update.items[0].text.split('Исторический импорт ').length-1,21);
   assert.equal((await api.topics.search(profile,'Запись dialogue-1')).messages[0].dialogue_id,'dialogue-1');
   const {id:oldTopic}=(await app.query(`SELECT 'T'||short_id AS id FROM dialogues_live.topics
    WHERE owner_id=$1 AND home_dialogue_id='dialogue-1' AND dirty_seq IS NOT NULL`,[profile])).rows[0];
   await api.append(profile,{request_id:req(),dialogue:{id:'explicit-continuation',channel:'synthetic'},
    messages:[{id:'request',turn_id:'turn',role:'user',kind:'input',text:'Вернёмся к теме «Проверка архива 1».'}]});
   const pinned=await api.pull(profile,{request_id:req(),consumer_id:'pinned-reader',context_instance_id:'default',
    format:'index',dialogue_id:'explicit-continuation'});
   assert.ok(pinned.items[0].text.split('\n')[1].startsWith(oldTopic+' '));
  });

  await t.test('правило 100 символов и атомарный пакет',async()=>{
   const dialogue={id:'bounds',channel:'synthetic'};
   const packet={request_id:req(),dialogue,messages:[{id:'short',turn_id:'turn',role:'user',kind:'input',text:'😀'.repeat(100)},{id:'long',turn_id:'turn',role:'user',kind:'input',text:'😀'.repeat(101)}]};
   await assert.rejects(api.append(who,packet),{code:'INVALID_ARGUMENT'});
   assert.equal((await owner.query("SELECT count(*)::int AS n FROM dialogues_live.dialogues WHERE id='bounds'")).rows[0].n,0);
   packet.messages[1].summary='Краткое содержание';
   const saved=await api.append(who,packet);assert.equal(saved.messages.length,2);assert.deepEqual(await api.append(who,packet),saved);
  });

  await t.test('новый контекст, окно 50, ACK и новые сообщения',async()=>{
   const dialogue={id:'seed',channel:'synthetic'};
   const messages=Array.from({length:70},(_,i)=>({id:'msg-'+i,turn_id:'seed-turn',role:'user',kind:'input',text:'текст '+i}));
   await api.append(who,{request_id:req(),dialogue,messages});
   const first=await execute('input',{request_id:req(),dialogue:{id:'live',channel:'synthetic'},messages:[{id:'live-input',text:'задача'}]});
   assert.equal(first.created,true);
   const items=await consume(first),ids=items.filter(x=>x.type==='message'&&x.dialogue_id==='seed').map(x=>x.id);
   assert.equal(ids.length,70);assert.equal(new Set(ids).size,70);
   assert.ok(items.some(x=>x.type==='turn_work'&&x.dialogue_id==='live'));
   const next=await execute('poll',{request_id:req(),dialogue_id:'live'});assert.equal(next.context.context_status,'no_updates');
   await api.append(who,{request_id:req(),dialogue,messages:[{id:'msg-new',turn_id:'seed-turn',role:'user',kind:'input',text:'новое'}]});
   const pending=await execute('poll',{request_id:req(),dialogue_id:'live'});
   await api.append(who,{request_id:req(),dialogue,messages:[{id:'msg-between',turn_id:'seed-turn',role:'user',kind:'input',text:'между выдачей и ACK'}]});
   const before=await consume(pending);assert.ok(before.some(x=>x.id==='msg-new'));assert.ok(!before.some(x=>x.id==='msg-between'));
   const later=await execute('poll',{request_id:req(),dialogue_id:'live'});const after=await consume(later);assert.ok(after.some(x=>x.id==='msg-between'));
   const other=await api.pull('another-owner',{request_id:req(),consumer_id:'other',context_instance_id:'other'});assert.equal(other.items.some(x=>x.dialogue_id==='seed'),false);
  });

  await t.test('история передаёт саммари, оригинал читается по ID',async()=>{
   const long='секретный оригинал '.repeat(9),summary='Смысл сообщения';
   await api.append(who,{request_id:req(),dialogue:{id:'story',channel:'synthetic'},messages:[{id:'story-long',turn_id:'story-turn',role:'user',kind:'input',text:long,summary}]});
   const history=await execute('history',{request_id:req(),dialogue_id:'story'});assert.equal(history.items.find(x=>x.type==='message_representation').text,summary);
   assert.ok(!JSON.stringify(history.items).includes(long));await consume(history);
   const original=await execute('read',{request_id:req(),dialogue_id:'story',message_id:'story-long'});assert.equal(original.text,long);await consume(original);
  });

  await t.test('незакрытый финал и успешное завершение',async()=>{
   const dialogue_id='live',snapshot=await api.turnGet(who,{dialogue_id}),turn_id=snapshot.turn_id;
   const update=await execute('update',{request_id:req(),dialogue_id,turn_id,expected_version:snapshot.version,changes:{add:[{id:'work',formulation:'Проверить'}]}});
   await consume(update);
   const rejected=await execute('finish',{request_id:req(),dialogue_id,turn_id,expected_version:update.version,final:{id:'answer',text:'готово'}});
   assert.equal(rejected.code,'PENDING_RESULTS');assert.equal(rejected.status,'rejected');assert.ok(rejected.pending.some(x=>x.id==='work'));await consume(rejected);
   const completed=await execute('update',{request_id:req(),dialogue_id,turn_id,expected_version:update.version,changes:{update:[{id:'work',status:'done',result:'проверено'}]}});await consume(completed);
   const done=await execute('finish',{request_id:req(),dialogue_id,turn_id,expected_version:completed.version,final:{id:'answer',text:'готово'}});
   assert.equal(done.status,'completed');assert.equal(done.context,undefined);
  });

  await t.test('окно покрытой истории и проверка параметров до записи',async()=>{
   await api.summary(who,{request_id:req(),dialogue_id:'seed',target:'dialogue',through_message_id:'msg-69',expected_version:null,text:'Сводка семидесяти сообщений'});
   const fresh={consumer_id:'fresh-reader',context_instance_id:'fresh-instance'};
   const response=await execute('poll',{request_id:req(),dialogue_id:'live'},fresh);
   let page=response.context;const all=[...page.items];
   while(page.continuation_cursor){page=await api.pull(who,{request_id:response.context_request_id,...fresh,continuation_cursor:page.continuation_cursor});all.push(...page.items);}
   assert.ok(all.some(x=>x.type==='dialogue_summary'&&x.dialogue_id==='seed'));
   assert.ok(!all.some(x=>x.type==='message'&&x.id==='msg-0'));
   assert.ok(all.some(x=>x.type==='message'&&x.id==='msg-between'));
   const delivered=all.filter(x=>x.type==='message');
   assert.equal(new Set(delivered.map(x=>x.dialogue_id+':'+x.id)).size,delivered.length);
   await api.ack(who,{request_id:req(),...fresh,delivery_id:page.delivery_id});
   const before=await owner.query("SELECT count(*)::int n FROM dialogues_live.dialogues WHERE id='bad-reset'");
   await assert.rejects(execute('input',{request_id:req(),dialogue:{id:'bad-reset',channel:'synthetic'},messages:[{id:'bad',text:'текст'}]},{...ctx,reset:'yes'}),{code:'INVALID_ARGUMENT'});
   const after=await owner.query("SELECT count(*)::int n FROM dialogues_live.dialogues WHERE id='bad-reset'");
   assert.equal(after.rows[0].n,before.rows[0].n);
  });

  await t.test('большая история возвращается страницами без оригинала',async()=>{
   const text='оригинал '.repeat(20),summary='саммари '.repeat(12000);
   await api.append(who,{request_id:req(),dialogue:{id:'large-history',channel:'synthetic'},messages:[{id:'large-message',turn_id:'large-turn',role:'user',kind:'input',text,summary}]});
   let cursor,joined='',pages=0;
   do {
    const result=await execute('history',{request_id:req(),dialogue_id:'large-history',...(cursor?{cursor}:{})});
    assert.ok(Buffer.byteLength(JSON.stringify(result))<=65024);
    for(const item of result.items)if(item.type==='message_summary_fragment')joined+=item.text;
    assert.ok(!JSON.stringify(result.items).includes(text));
    cursor=result.continuation_cursor;pages++;await consume(result);
   }while(cursor);
   assert.ok(pages>1);assert.equal(joined,summary);
  });

  await t.test('неполная выдача не подтверждается и повтор не теряет изменения',async()=>{
   const isolated={consumer_id:'ack-reader',context_instance_id:'ack-instance'};
   const first=await execute('poll',{request_id:req(),dialogue_id:'live'},isolated);
   const firstPage=first.context??await api.pull(who,first.context_error.arguments);
   assert.ok(firstPage.continuation_cursor);
   await assert.rejects(api.ack(who,{request_id:req(),...isolated,delivery_id:firstPage.delivery_id}),{code:'PAGES_INCOMPLETE'});
   const repeated=await execute('poll',{request_id:req(),dialogue_id:'live'},isolated);
   let page=repeated.context??await api.pull(who,repeated.context_error.arguments);
   assert.notEqual(page.delivery_id,firstPage.delivery_id);
   await assert.rejects(api.ack(who,{request_id:req(),...isolated,delivery_id:firstPage.delivery_id}),{code:'DELIVERY_SUPERSEDED'});
   const items=[...page.items];
   while(page.continuation_cursor){page=await api.pull(who,{request_id:repeated.context_request_id,...isolated,continuation_cursor:page.continuation_cursor});items.push(...page.items);}
   assert.ok(items.some(x=>x.type==='message'&&x.id==='large-message'));
   assert.equal((await api.ack(who,{request_id:req(),...isolated,delivery_id:page.delivery_id})).acknowledged,true);
  });

  await t.test('снимок хода сохраняет версию саммари между страницами',async()=>{
   const text='исходник '.repeat(20);
   const created=await api.turnInput(who,{request_id:req(),dialogue:{id:'snapshot-test',channel:'synthetic'},messages:[{id:'snapshot-input',text,summary:'A'.repeat(20000)}]});
   const first=await api.turnGet(who,{dialogue_id:'snapshot-test',turn_id:created.turn_id});
   assert.ok(first.next_cursor);
   const legacy=JSON.parse(Buffer.from(first.next_cursor.split('.')[0],'base64url').toString());delete legacy.through;
   const encoded=Buffer.from(JSON.stringify(legacy)).toString('base64url');
   const oldCursor=encoded+'.'+createHmac('sha256','synthetic-key').update('dialogues-turn-v1:'+encoded).digest('base64url');
   await assert.rejects(api.turnGet(who,{dialogue_id:'snapshot-test',turn_id:created.turn_id,cursor:oldCursor}),{code:'INVALID_CURSOR'});
   await api.summary(who,{request_id:req(),dialogue_id:'snapshot-test',target:'message',message_id:'snapshot-input',expected_version:'1',text:'B'.repeat(20000)});
   const second=await api.turnGet(who,{dialogue_id:'snapshot-test',turn_id:created.turn_id,cursor:first.next_cursor});
   assert.equal(second.sha256,first.sha256);assert.ok(!second.text.includes('B'.repeat(100)));
  });

  await t.test('ACK при чтении другой беседы не пропускает состояние хода',async()=>{
   const created=await api.turnInput(who,{request_id:req(),dialogue:{id:'scope-a',channel:'synthetic'},messages:[{id:'scope-input',text:'вопрос'}]});
   await consume(await execute('poll',{request_id:req(),dialogue_id:'seed'}));
   await api.turnUpdate(who,{request_id:req(),dialogue_id:'scope-a',turn_id:created.turn_id,expected_version:created.version,changes:{add:[{id:'scope-work',formulation:'Завершить задачу'}]}});
   const history=await execute('history',{request_id:req(),dialogue_id:'seed'}),updates=await consume(history);
   assert.ok(updates.some(x=>x.type==='turn_work'&&x.dialogue_id==='scope-a'&&x.text.includes('scope-work')));
  });

  await t.test('backfill готовит старое саммари и сохраняет исходник',async()=>{
   const text='Историческое сообщение. '.repeat(600);
   await api.append(who,{request_id:req(),dialogue:{id:'old',channel:'synthetic'},messages:[{id:'old-long',turn_id:'old-turn',role:'user',kind:'input',text,summary:'временное'}]});
   await owner.query("DELETE FROM dialogues_live.message_summaries WHERE owner_id=$1 AND dialogue_id='old' AND message_id='old-long'",[who]);
   let calls=0;const luna={async probe(){},async run(input,state,save){calls++;if(calls===2)throw new Error('synthetic interruption');await save({execution_state:'completed',result:'Синтетическое саммари'});return 'Синтетическое саммари';}};
   await assert.rejects(backfill(app,who,luna),/synthetic interruption/);
   assert.ok((await owner.query("SELECT next_offset FROM dialogues_live.message_backfill WHERE owner_id=$1 AND message_id='old-long'",[who])).rows[0].next_offset>0);
   const result=await backfill(app,who,luna);assert.equal(result.completed,1);assert.ok(calls>=1);
   assert.equal((await api.message(who,{dialogue_id:'old',message_id:'old-long',target:'message_summary'})).text,'Синтетическое саммари');
   assert.equal((await api.message(who,{dialogue_id:'old',message_id:'old-long',limit:1})).text,Array.from(text)[0]);
   assert.equal((await backfill(app,who,luna)).completed,0);
   await api.append(who,{request_id:req(),dialogue:{id:'late',channel:'synthetic'},messages:[{id:'late-long',turn_id:'late-turn',role:'user',kind:'input',text:'поздняя запись '.repeat(12),summary:'временное'}]});
   await owner.query("DELETE FROM dialogues_live.message_summaries WHERE owner_id=$1 AND dialogue_id='late' AND message_id='late-long'",[who]);
   await ensureBackfilled(app,who,luna);
   assert.equal((await api.message(who,{dialogue_id:'late',message_id:'late-long',target:'message_summary'})).text,'Синтетическое саммари');
  });
  await t.test('граница переключения удерживает новые записи до готовности',async()=>{
   const text='сообщение перехода '.repeat(12);
   await api.append(who,{request_id:req(),dialogue:{id:'fence-old',channel:'synthetic'},messages:[{id:'fence-old-message',turn_id:'fence-old-turn',role:'user',kind:'input',text,summary:'временное'}]});
   await owner.query("DELETE FROM dialogues_live.message_summaries WHERE owner_id=$1 AND dialogue_id='fence-old' AND message_id='fence-old-message'",[who]);
   let ready,release;
   const readyPromise=new Promise(r=>{ready=r;}),releasePromise=new Promise(r=>{release=r;});
   const luna={async probe(){},async run(){return 'Хвост обработан';}};
   const fencedPool=new Pool({connectionString:appUrl,application_name:'dialogues-fence:synthetic-fence'});
   const fence=backfill(fencedPool,who,luna,{id:'synthetic-fence',wait:async()=>{ready();await releasePromise;}});
   await readyPromise;
   const pending=api.append(who,{request_id:req(),dialogue:{id:'fence-new',channel:'synthetic'},messages:[{id:'fence-new-message',turn_id:'fence-new-turn',role:'user',kind:'input',text:'новая запись'}]});
   try{
    assert.equal(await Promise.race([pending.then(()=>true),new Promise(r=>setTimeout(()=>r(false),100))]),false);
    const lock=await app.query(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity a JOIN pg_locks l ON l.pid=a.pid
      JOIN dialogues_live.exchange_events e ON e.owner_id=$1 AND e.event_id='fence:synthetic-fence' AND e.event_type='cutover_fence_ready' AND e.turn_id=a.pid::text
      WHERE a.application_name=$2 AND l.locktype='advisory' AND l.granted AND l.objsubid=1
      AND l.classid::bigint=((hashtextextended('dialogues-live:'||$1,0)>>32)&4294967295)
      AND l.objid::bigint=(hashtextextended('dialogues-live:'||$1,0)&4294967295)) AS ready`,[who,'dialogues-fence:synthetic-fence']);
    assert.equal(lock.rows[0].ready,true);
    assert.equal((await api.message(who,{dialogue_id:'fence-old',message_id:'fence-old-message',target:'message_summary'})).text,'Хвост обработан');
   }finally{release();}
   await fence;await pending;await fencedPool.end();
   assert.ok((await owner.query("SELECT 1 FROM dialogues_live.exchange_events WHERE owner_id=$1 AND event_id='fence:synthetic-fence' AND turn_id IS NOT NULL",[who])).rowCount);
   await assert.rejects(backfill(app,who,luna,{id:'synthetic-fence',wait:async()=>{}}),/FENCE_ID_REUSED/);
   await assert.rejects(backfill(app,who,luna,{id:'x'.repeat(49),wait:async()=>{}}),/FENCE_ID_TOO_LONG/);
  });
  const logs=(await owner.query('SELECT event_type,dialogue_id,turn_id,delivery_id,result_ids FROM dialogues_live.exchange_events WHERE owner_id=$1',[who])).rows;
  assert.ok(logs.some(x=>x.event_type==='context_ack'));assert.ok(logs.some(x=>x.event_type==='poll'));assert.ok(logs.some(x=>x.event_type==='finish_rejected'));assert.ok(!JSON.stringify(logs).includes('секретный оригинал'));
 }finally{await app.end();await owner.end();}
});
