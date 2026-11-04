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
