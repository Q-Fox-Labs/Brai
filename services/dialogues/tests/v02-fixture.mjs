// ABOUTME: Проверяет v0.2 на реальной изолированной PostgreSQL fixture.
// ABOUTME: Использует только синтетические сообщения и подменяет платную модель.
import assert from 'node:assert/strict';
import {createStore} from '../dist/store.js';
import {createJobs} from '../dist/jobs.js';
import {DialoguesFault} from '../dist/domain.js';
/** Дополняет legacy приемку теми же реальными миграциями и app permissions. */
export async function v02Checks(t,owner,app){
 let n=0;const rid=()=> 'v02-'+(++n),api=createStore(app,'fixture-v02-key');
 const packet=(dialogue,count,start=0,more={})=>({request_id:rid(),dialogue:{id:dialogue,channel:'synthetic',title:'Same title'},messages:Array.from({length:count},(_,i)=>({id:'m'+(start+i),turn_id:'t'+(start+i),role:'user',kind:'input',text:'Синтетический текст '+(start+i),occurred_at:new Date(Date.UTC(2026,0,1,0,0,start+i)).toISOString(),...more}))});
 async function pull(who,consumer='one',instance='ctx',extra={}){
  const args={request_id:rid(),consumer_id:consumer,context_instance_id:instance,...extra},pages=[];
  let r=await api.pull(who,args);
  for(let i=0;i<1000;i++){
   assert.ok(Buffer.byteLength(JSON.stringify({jsonrpc:'2.0',id:1,result:{content:[],structuredContent:r}}))<=65536);
   pages.push(r);if(!r.continuation_cursor)break;
   r=await api.pull(who,{...args,continuation_cursor:r.continuation_cursor});
  }
  return {args,pages,items:pages.flatMap(p=>p.items),first:pages[0]};
 }
 const selected=p=>p.items.filter(i=>i.type==='message').sort((a,b)=>a.global_order-b.global_order);
 const ack=(who,p)=>api.ack(who,{request_id:rid(),consumer_id:p.args.consumer_id,context_instance_id:p.args.context_instance_id,delivery_id:p.first.delivery_id});
 await t.test('v0.2: 12 => 12, unanswered и точный временной отбор 50',async()=>{
  await api.append('v2',packet('a',12));
  let p=await pull('v2');assert.equal(selected(p).length,12);assert.ok(selected(p).every(m=>m.kind==='input'));
  await ack('v2',p);
  await api.append('v2',packet('b',40,12));
  // Поздно импортированная старая реплика не вытесняет актуальную по recorded_at.
  await api.append('v2',packet('old',1,0));
  p=await pull('v2');
  const ids=selected(p).map(m=>m.dialogue_id+'/'+m.id);
  assert.equal(ids.length,50);assert.equal(ids[0],'a/m2');assert.equal(ids.at(-1),'b/m51');
  assert.equal(new Set(ids).size,50);
  for(const d of ['a','b'])assert.ok(p.items.some(i=>i.type==='dialogue'&&i.dialogue_id===d));
  for(const d of ['a','b'])await api.summary('v2',{request_id:rid(),target:'dialogue',dialogue_id:d,through_message_id:d==='a'?'m11':'m51',expected_version:null,text:'Синтетическая свёртка '+d});
  await ack('v2',p);
  p=await pull('v2');assert.deepEqual(selected(p).map(m=>m.dialogue_id+'/'+m.id),ids);assert.equal(p.items.filter(i=>i.type==='dialogue_summary').length,2);
  await ack('v2',p);
  p=await pull('v2');assert.deepEqual(selected(p).map(m=>m.dialogue_id+'/'+m.id),ids);assert.equal(p.items.filter(i=>i.type==='dialogue_summary').length,0);
  await api.append('v2',packet('b',1,52));p=await pull('v2');
  assert.deepEqual(selected(p).map(m=>m.dialogue_id+'/'+m.id),[...ids.slice(1),'b/m52']);
  await api.append('fallback',packet('unknown-time',1,0,{occurred_at:null}));
  const fallback=selected(await pull('fallback'))[0];assert.equal(fallback.occurred_at,null);assert.equal(fallback.time_provenance,'recorded_at_fallback');
 });
 await t.test('v0.2: bootstrap всех бесед и обновления старой свёртки по sequence',async()=>{
  let p=await pull('v2','fresh');assert.equal(p.items.filter(i=>i.type==='dialogue').length,3);await ack('v2',p);
  await api.summary('v2',{request_id:rid(),target:'dialogue',dialogue_id:'old',through_message_id:'m0',expected_version:null,text:'Саммари старой беседы'});
  p=await pull('v2','fresh');assert.deepEqual(p.items.filter(i=>i.type==='dialogue_summary').map(x=>x.dialogue_id),['old']);
  const other=await pull('v2','two');assert.equal(other.first.summaries_mode,'bootstrap');assert.equal(other.items.filter(i=>i.type==='dialogue_summary').length,3);
  await ack('v2',p);
  assert.equal((await pull('v2','fresh')).items.filter(i=>i.type==='dialogue_summary').length,0);
  assert.equal((await pull('v2','two')).first.summaries_mode,'bootstrap');
 });
 await t.test('v0.2: frozen replay, supersede, reset, owner spoof, restart',async()=>{
  const p=await pull('v2','replay');await api.append('v2',packet('b',1,53));
  assert.deepEqual(await api.pull('v2',p.args),p.first);
  await assert.rejects(api.pull('v2',{...p.args,reset:true}),{code:'REQUEST_CONFLICT'});
  await assert.rejects(api.pull('v2',{...p.args,owner_id:'other'}),{code:'INVALID_ARGUMENT'});
  const q=await pull('v2','replay');await assert.rejects(ack('v2',p),{code:'DELIVERY_SUPERSEDED'});
  assert.deepEqual(await createStore(app,'fixture-v02-key').pull('v2',q.args),q.first);
  const receipt=await ack('v2',q);
  assert.deepEqual(await api.ack('v2',{request_id:receipt.request_id,consumer_id:q.args.consumer_id,context_instance_id:q.args.context_instance_id,delivery_id:q.first.delivery_id}),receipt);
  await assert.rejects(api.ack('other',{request_id:rid(),consumer_id:'replay',context_instance_id:'ctx',delivery_id:q.first.delivery_id}),{code:'NOT_FOUND'});
  assert.equal((await pull('v2','replay','ctx',{reset:true})).first.summaries_mode,'bootstrap');
  assert.equal((await pull('v2','replay','new-instance')).first.summaries_mode,'bootstrap');
 });
 await t.test('v0.2: многостраничный полный состав, escaped byte budget и ACK только после всех страниц',async()=>{
  for(let i=0;i<55;i++){
   await api.append('pages',packet('dialogue-'+i,1,0,{text:'😀'.repeat(4000),source:{kind:'fixture',detail:'я'.repeat(3000)}}));
   await api.summary('pages',{request_id:rid(),dialogue_id:'dialogue-'+i,target:'dialogue',through_message_id:'m0',expected_version:null,text:'\u0001'.repeat(8000)});
  }
  const args={request_id:rid(),consumer_id:'page-reader',context_instance_id:'ctx'};
  const first=await api.pull('pages',args);assert.ok(first.continuation_cursor);
  await assert.rejects(api.ack('pages',{request_id:rid(),consumer_id:'page-reader',context_instance_id:'ctx',delivery_id:first.delivery_id}),{code:'PAGES_INCOMPLETE'});
  let page=first,items=[];
  do{items.push(...page.items);if(!page.continuation_cursor)break;page=await api.pull('pages',{...args,continuation_cursor:page.continuation_cursor});assert.ok(Buffer.byteLength(JSON.stringify(page))<=65024);}while(true);
  assert.equal(items.filter(x=>x.type==='message').length,50);assert.equal(items.filter(x=>x.type==='dialogue_summary').length,55);
  assert.ok(items.some(x=>x.type==='message_representation'&&x.truncated&&x.next_offset===1024));
  await api.ack('pages',{request_id:rid(),consumer_id:'page-reader',context_instance_id:'ctx',delivery_id:first.delivery_id});
 });
 await t.test('v0.2: concurrent committed writes и summary update не теряются за ACK',async()=>{
  const p=await pull('concurrent-v2');
  await Promise.all(Array.from({length:24},(_,i)=>api.append('concurrent-v2',packet('c'+i,1,i))));
  await ack('concurrent-v2',p);
  assert.equal(selected(await pull('concurrent-v2')).length,24);
  const q=await pull('concurrent-v2');await api.summary('concurrent-v2',{request_id:rid(),dialogue_id:'c0',target:'dialogue',through_message_id:'m0',expected_version:null,text:'Новая свёртка'});
  await ack('concurrent-v2',q);assert.ok((await pull('concurrent-v2')).items.some(i=>i.type==='dialogue_summary'&&i.dialogue_id==='c0'));
 });
 await t.test('v0.2: 10 OR 6h, no duplicates, >20/day, complete source fragments',async()=>{
  const calls=[],fake={async probe(){return {completed:true};},async run(input,state,save){const x=JSON.parse(input);calls.push(x);await save({execution_state:'completed',result:'Сводка 37'});return 'Сводка 37';}};
  const jobs=createJobs(app,'queue',fake);
  await api.append('queue',packet('nine',9));await jobs.schedule();assert.equal((await app.query("SELECT count(*) AS n FROM dialogues_live.summary_jobs WHERE owner_id='queue'")).rows[0].n,'0');
  // Только owner fixture имитирует старый recorded_at; реальные originals не меняются.
  await owner.query("UPDATE dialogues_live.messages SET recorded_at=now()-interval '7 hours' WHERE owner_id='queue'");
  await jobs.schedule();await jobs.schedule();
  assert.equal((await app.query("SELECT count(*) AS n FROM dialogues_live.summary_jobs WHERE owner_id='queue'")).rows[0].n,'1');
  await jobs.tick();assert.equal(calls.length,1);assert.equal(calls[0].originals.length,9);
  for(let i=0;i<21;i++)await api.append('queue',packet('bulk-'+i,10));
  for(let i=0;i<21;i++)await jobs.tick();
  assert.equal((await app.query("SELECT count(*) AS n FROM dialogues_live.summary_jobs WHERE owner_id='queue' AND state='succeeded'")).rows[0].n,'22');
  const long='α😀'.repeat(17000);await api.append('large-queue',packet('large',10,0,{text:long}));
  const pieces=[];const big=createJobs(app,'large-queue',{...fake,async run(input){pieces.push(...JSON.parse(input).originals);return 'Полный текст обработан';}});
  await big.tick();
  for(let i=0;i<10;i++)assert.equal(pieces.filter(x=>x.id==='m'+i).map(x=>x.original_fragment).join(''),long);
  assert.equal((await app.query("SELECT through_message_id FROM dialogues_live.dialogue_summaries WHERE owner_id='large-queue'")).rows[0].through_message_id,'m9');
 });
 await t.test('v0.2: lease recovery и stale CAS не публикуют второй результат',async()=>{
  const fake={async probe(){},async run(){return 'Свёртка';}},jobs=createJobs(app,'lease',fake);
  await api.append('lease',packet('x',10));const job=await jobs.claim();assert.ok(job);
  await owner.query("UPDATE dialogues_live.summary_jobs SET lease_until=now()-interval '1 minute' WHERE owner_id='lease'");
  const recovered=await jobs.claim();assert.equal(recovered.id,job.id);assert.notEqual(recovered.lease_id,job.lease_id);
  await assert.rejects(jobs.publish(job,'Старый результат'),{code:'LEASE_LOST'});
  await api.summary('lease',{request_id:rid(),dialogue_id:'x',target:'dialogue',through_message_id:'m9',expected_version:null,text:'Ручная версия'});
  await jobs.publish(recovered,'Устаревшая версия');
  assert.equal((await app.query("SELECT count(*) AS n FROM dialogues_live.dialogue_summaries WHERE owner_id='lease'")).rows[0].n,'1');
  assert.equal((await app.query("SELECT state FROM dialogues_live.summary_jobs WHERE owner_id='lease'")).rows[0].state,'stale');
 });
 await t.test('v0.2: ошибка Luna имеет 3 attempts, failed и сохранённый хвост',async()=>{
  const jobs=createJobs(app,'unavailable',{async probe(){throw new DialoguesFault('LUNA_UNAVAILABLE');},async run(){assert.fail('must not execute without probe');}});
  await api.append('unavailable',packet('x',10));
  for(let i=0;i<3;i++){await owner.query("UPDATE dialogues_live.summary_jobs SET available_at=now() WHERE owner_id='unavailable'");await jobs.tick();}
  const job=(await app.query("SELECT state,attempts,error_code FROM dialogues_live.summary_jobs WHERE owner_id='unavailable'")).rows[0];
  assert.deepEqual(job,{state:'failed',attempts:3,error_code:'LUNA_UNAVAILABLE'});await jobs.schedule();
  assert.equal((await app.query("SELECT count(*) AS n FROM dialogues_live.summary_jobs WHERE owner_id='unavailable'")).rows[0].n,'1');
  assert.equal((await pull('unavailable')).first.missing_dialogue_summaries,1);
 });
 await t.test('v0.2: stop ждёт занятый worker после повторного scheduler wake',async()=>{
  let release,entered,wake;
  const gate=new Promise(r=>{release=r;}),started=new Promise(r=>{entered=r;});
  const originalInterval=global.setInterval;
  global.setInterval=(fn,ms,...args)=>{if(ms===60000)wake=fn;return originalInterval(fn,ms,...args);};
  const jobs=createJobs(app,'shutdown',{async probe(){},async run(){entered();await gate;return 'Синтетическая свёртка';}});
  try{
   await api.append('shutdown',packet('x',10));jobs.start();await started;
   wake();let stopped=false;
   const stopping=jobs.stop().then(()=>{stopped=true;});
   await new Promise(r=>setTimeout(r,20));assert.equal(stopped,false);
   release();await stopping;assert.equal(stopped,true);
  }finally{global.setInterval=originalInterval;release();await jobs.stop();}
 });

}
