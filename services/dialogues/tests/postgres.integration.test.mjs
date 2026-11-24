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
import {createTopicJobs} from '../dist/topic-jobs.js';
import {countContextTokens} from '../dist/compact-context.js';
import {backfill,ensureBackfilled} from '../dist/backfill.js';

const ownerUrl=process.env.DIALOGUES_TEST_OWNER_DATABASE_URL,appUrl=process.env.DIALOGUES_TEST_DATABASE_URL;
test('PostgreSQL: обмен, контекст, история и перенос саммари',{skip:!ownerUrl||!appUrl},async t=>{
 const owner=new Pool({connectionString:ownerUrl}),app=new Pool({connectionString:appUrl,max:8}),who='test-owner';
 const api=createStore(app,'synthetic-key'),ctx={consumer_id:'reader',context_instance_id:'instance'};
 let counter=0;const req=()=>`new-test-${++counter}`;
 const execute=(action,args,context=ctx)=>exchange(api,who,{action,arguments:args,context});
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

  await t.test('темы, поиск оригинала и компактный снимок с подтверждением',async()=>{
   const profile='topics-fixture';
   const stable={consumer_id:'topic-consumer',format:'compact'};
   const archive={consumer_id:'topic-consumer',context_instance_id:'default'};
   const operation=(action,arguments_,context)=>exchange(api,profile,{action,arguments:{request_id:req(),...arguments_},context});
   const first=await operation('input',{dialogue:{id:'initial',channel:'synthetic',title:'Фикс отправки'},messages:[
    {id:'original',text:'Привет. '.repeat(800)+'точная строка PR #599',summary:'Работа продолжается. '.repeat(400)}
   ]},stable);
   assert.equal(first.context.context_format,'compact');
   assert.equal(first.context.context_instance_id,'default');
   const topic=first.context.items.find(item=>item.type==='topic_summary');
   assert.ok(topic?.topic_id);
   assert.ok(!first.context.items.some(item=>item.message_id==='original'));
   const found=await operation('search',{query:'точная строка PR #599'});
   assert.equal(found.messages[0].message_id,'original');
   assert.ok(found.messages[0].offset>4096);
   const read=await operation('read',{archive_only:true,dialogue_id:'initial',message_id:'original',offset:found.messages[0].offset});
   assert.match(read.text,/точная строка PR #599/);
   assert.equal(read.context,undefined);
   await api.ack(profile,{...archive,request_id:req(),delivery_id:first.context.delivery_id});
   const next=await operation('input',{dialogue:{id:'next',channel:'synthetic'},messages:[{id:'next-in',text:'Уточнение'}]},stable);
   assert.equal(next.context.summaries_mode,'updates');
   const oversized=next.context.items.find(item=>item.message_id==='original');
   assert.equal(oversized,undefined); // Вход первого хода уже получен клиентом.
   const nextTopic=next.context.items.find(item=>item.type==='topic_summary').topic_id;
   await operation('topic_move',{dialogue_id:'next',topic_id:topic.topic_id});
   assert.equal((await operation('topic_get',{topic_id:nextTopic})).topic_id,topic.topic_id);
   assert.equal((await operation('topic_get',{topic_id:topic.topic_id})).dialogues.length,2);
   const third=await operation('input',{dialogue:{id:'third',channel:'synthetic'},messages:[{id:'third-in',text:'Третий тред'}]},stable);
   const thirdTopic=third.context.items.find(item=>item.type==='topic_summary'&&item.topic_id!==topic.topic_id&&item.topic_id!==nextTopic).topic_id;
   await operation('topic_move',{dialogue_id:'next',topic_id:thirdTopic});
   await operation('topic_move',{dialogue_id:'initial',topic_id:thirdTopic});
   await operation('topic_move',{dialogue_id:'initial',topic_id:null});
   assert.equal((await operation('topic_get',{topic_id:nextTopic})).topic_id,thirdTopic);
   await operation('topic_move',{dialogue_id:'next',topic_id:null});
   assert.equal((await operation('topic_get',{topic_id:nextTopic})).topic_id,nextTopic);
   const restart=await operation('poll',{dialogue_id:'next'},{...stable,reset:true});
   assert.equal(restart.context.summaries_mode,'bootstrap');
   assert.equal(restart.context.items.find(item=>item.message_id==='original').representation,'reference');
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
   const context=await api.pull(profile,{request_id:req(),consumer_id:'worker-reader',context_instance_id:'default',format:'compact'});
   assert.equal(context.items.find(item=>item.message_id==='big').text,'Короткая проверка.');
   assert.equal(context.items.find(item=>item.type==='topic_summary').text,'Запланирована проверка.');
  });

  await t.test('группировка сначала сохраняет предложение и защищает ручной перенос',async()=>{
   const profile='topic-grouping-fixture';
   for(const [id,message] of [['first','Проверка выпуска PR 123'],['second','Продолжение проверки выпуска PR 123']]){
    await api.append(profile,{request_id:req(),dialogue:{id,channel:'synthetic',title:'Проверка выпуска'},
     messages:[{id:'request',turn_id:'turn',role:'user',kind:'input',text:message}]});
   }
   const generator={async structured(input){
    const data=JSON.parse(input);
    return data.candidates?JSON.stringify({topic_id:data.candidates[0].topic_id}):
     JSON.stringify({extended:'Проверка выпуска PR 123.',compact:'Проверка PR 123.',source_indexes:[0]});
   }};
   const proposed=createTopicJobs(app,profile,generator);
   assert.equal(await proposed.tick(),true);
   assert.equal(await proposed.tick(),true);
   assert.equal(await proposed.tick(),true);
   const rows=(await app.query(`SELECT dialogue_id,topic_id,proposed_topic_id FROM dialogues_live.topic_members
    WHERE owner_id=$1 ORDER BY dialogue_id`,[profile])).rows;
   const proposal=rows.find(row=>row.proposed_topic_id);
   assert.ok(proposal);
   assert.equal(new Set(rows.map(row=>row.topic_id)).size,2);
   await api.topics.move(profile,req(),proposal.dialogue_id,proposal.proposed_topic_id);
   await api.topics.move(profile,req(),proposal.dialogue_id,null);
   const applied=createTopicJobs(app,profile,generator,undefined,true);
   assert.equal(await applied.tick(),true);
   assert.equal(await applied.tick(),true);
   assert.equal((await app.query(`SELECT topic_id,manually_assigned FROM dialogues_live.topic_members
    WHERE owner_id=$1 AND dialogue_id=$2`,[profile,proposal.dialogue_id])).rows[0].manually_assigned,true);
  });

  await t.test('архив из 1000 тем сохраняет лимит bootstrap и исторический импорт в дельте',async()=>{
   const profile='large-topic-fixture',context={consumer_id:'large-reader',context_instance_id:'default',format:'compact'};
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
   assert.equal(items.filter(item=>item.tier==='extended').length,20);
   assert.equal(items.filter(item=>item.tier==='compact').length,200);
   assert.equal(items.filter(item=>item.type==='message_representation').length,20);
   assert.ok(items.reduce((sum,item)=>sum+(item.tokens??0),0)<=22000);
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
   assert.equal(update.items.filter(item=>item.message_id?.startsWith('old-')).length,21);
   assert.equal((await api.topics.search(profile,'Запись dialogue-1')).messages[0].dialogue_id,'dialogue-1');
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
