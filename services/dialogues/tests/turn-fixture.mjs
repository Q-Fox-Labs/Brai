// ABOUTME: Проверяет управляемые ходы на настоящем изолированном PostgreSQL.
// ABOUTME: Все данные синтетические; старые записи не изменяются.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createStore} from '../dist/store.js';
export async function turnChecks(t,app){
 const api=createStore(app,'synthetic-turn-key');let n=0;const req=()=>`turn-test-${++n}`;
 const dialogue={id:'managed',channel:'synthetic'},owner='managed-owner';
 const inp=(id,text='вход')=>({request_id:req(),dialogue,messages:[{id,text}]});
 const get=async args=>{let page=await api.turnGet(owner,args),body=page.text;const first=page;while(page.next_cursor){page=await api.turnGet(owner,{dialogue_id:args.dialogue_id,cursor:page.next_cursor});body+=page.text;}assert.equal(createHash('sha256').update(body).digest('hex'),first.sha256);return JSON.parse(body);};
 await t.test('короткий ввод, повтор, один открытый ход и стир',async()=>{
  const packet=inp('one');const one=await api.turnInput(owner,packet);assert.deepEqual(await api.turnInput(owner,packet),one);
  const snapshot=await get({dialogue_id:dialogue.id});assert.equal(snapshot.results.length,1);assert.equal(snapshot.results[0].kind,'final');assert.equal(snapshot.results[0].status,'pending');
  const repeat=await api.turnInput(owner,{...packet,request_id:req()});assert.equal(repeat.turn_id,one.turn_id);assert.equal(repeat.version,one.version);
  const next=await api.turnInput(owner,inp('steer','сначала другое'));assert.equal(next.turn_id,one.turn_id);assert.notEqual(next.version,one.version);
  assert.equal((await get({dialogue_id:dialogue.id})).messages.length,2);
 });
 await t.test('результаты, блокировка финала и версии',async()=>{
  let s=await get({dialogue_id:dialogue.id});let u=await api.turnUpdate(owner,{request_id:req(),dialogue_id:dialogue.id,turn_id:s.turn_id,expected_version:s.version,changes:{purpose:'Две задачи',add:[{id:'first',formulation:'Первая',source_refs:['one']},{id:'second',formulation:'Вторая',source_refs:['steer']}]}});
  const f={request_id:req(),dialogue_id:dialogue.id,turn_id:s.turn_id,expected_version:u.version,final:{id:'final-one',text:'итог'}};
  await assert.rejects(api.turnFinish(owner,f),e=>e.code==='PENDING_RESULTS'&&e.details.pending.length===2);
  s=await get({dialogue_id:dialogue.id});assert.equal(s.version,u.version);assert.equal(s.messages.length,2);
  await assert.rejects(api.turnUpdate(owner,{request_id:req(),dialogue_id:dialogue.id,turn_id:s.turn_id,expected_version:'1',changes:{purpose:'устарело'}}),{code:'VERSION_CONFLICT'});
  await assert.rejects(api.turnUpdate(owner,{request_id:req(),dialogue_id:dialogue.id,turn_id:s.turn_id,expected_version:s.version,changes:{update:[{id:'first',status:'not_done'}]}}),{code:'REASON_REQUIRED'});
  const changed=await api.turnUpdate(owner,{request_id:req(),dialogue_id:dialogue.id,turn_id:s.turn_id,expected_version:s.version,changes:{update:[{id:'first',status:'done',result:'готово'},{id:'second',status:'not_done',reason:'не проверено',remainder:'продолжить'}]}});
  const done=await api.turnFinish(owner,{...f,request_id:req(),expected_version:changed.version});assert.equal(done.status,'completed');
  const after=await get({dialogue_id:dialogue.id,turn_id:s.turn_id});assert.equal(after.messages.at(-1).text,'итог');assert.equal(after.results.find(r=>r.kind==='final').status,'done');
  const replay=await api.turnInput(owner,{...inp('one'),messages:[{id:'one',text:'вход'}]});assert.equal(replay.turn_id,s.turn_id);
 });
 await t.test('параллельное создание и чужой владелец',async()=>{
  const dialogue={id:'race-managed',channel:'synthetic'};const [a,b]=await Promise.all([api.turnInput(owner,{...inp('r1'),dialogue}),api.turnInput(owner,{...inp('r2'),dialogue})]);assert.equal(a.turn_id,b.turn_id);
  await assert.rejects(api.turnGet('foreign',{dialogue_id:dialogue.id,turn_id:a.turn_id}),{code:'NOT_FOUND'});
  const s=await get({dialogue_id:dialogue.id});assert.equal(s.messages.length,2);
 });
 await t.test('переход со старой схемы только после завершения хода',async()=>{
  const dialogue={id:'legacy-boundary',channel:'synthetic'};
  await api.append(owner,{request_id:req(),dialogue,messages:[{id:'old-input',turn_id:'old-turn',role:'user',kind:'input',text:'старый ввод'}]});
  await assert.rejects(api.turnInput(owner,{...inp('new-input'),dialogue}),{code:'LEGACY_TURN_OPEN'});
  await api.append(owner,{request_id:req(),dialogue,messages:[{id:'old-final',turn_id:'old-turn',role:'assistant',kind:'final',text:'старый финал'}]});
  assert.ok((await api.turnInput(owner,{...inp('new-input'),dialogue})).turn_id);
 });
 await t.test('страницы Unicode и конфликт версии',async()=>{
  const dialogue={id:'big-managed',channel:'synthetic'};const start=await api.turnInput(owner,{...inp('big','😀Я'.repeat(20000)),dialogue});
  const page=await api.turnGet(owner,{dialogue_id:dialogue.id});assert.ok(page.next_cursor);const full=await get({dialogue_id:dialogue.id});assert.equal(full.messages[0].text,'😀Я'.repeat(20000));
  await api.turnInput(owner,{...inp('late'),dialogue});await assert.rejects(api.turnGet(owner,{dialogue_id:dialogue.id,cursor:page.next_cursor}),{code:'VERSION_CONFLICT'});
  await assert.rejects(api.turnFinish(owner,{request_id:req(),dialogue_id:dialogue.id,turn_id:start.turn_id,expected_version:start.version,final:{id:'stale-final',text:'неверно'}}),{code:'VERSION_CONFLICT'});
 });
 await t.test('импорт подтверждённого финала и восстановление без дубля',async()=>{
  const dialogue={id:'repair-managed',channel:'synthetic'};const start=await api.turnInput(owner,{...inp('repair-input'),dialogue});
  await api.append(owner,{request_id:req(),dialogue,messages:[{id:'actual-final',turn_id:start.turn_id,role:'assistant',kind:'final',text:'точный ответ',source:{kind:'native_client',native_thread_id:'thread',native_turn_id:'turn',phase:'final_answer',status:'completed'}}]});
  await assert.rejects(api.turnInput(owner,{...inp('after-repair'),dialogue}),{code:'FINAL_RECONCILIATION_REQUIRED'});
  let s=await get({dialogue_id:dialogue.id});await assert.rejects(api.turnRepair(owner,{request_id:req(),dialogue_id:dialogue.id,turn_id:s.turn_id,expected_version:s.version,final_message_id:'actual-final',evidence:{kind:'native_client',native_thread_id:'thread',native_turn_id:'turn',phase:'commentary',status:'completed'}}),{code:'FINAL_EVIDENCE_REQUIRED'});
  const repaired=await api.turnRepair(owner,{request_id:req(),dialogue_id:dialogue.id,turn_id:s.turn_id,expected_version:s.version,final_message_id:'actual-final',evidence:{kind:'native_client',native_thread_id:'thread',native_turn_id:'turn',phase:'final_answer',status:'completed'}});assert.equal(repaired.status,'completed');s=await get({dialogue_id:dialogue.id,turn_id:s.turn_id});assert.equal(s.messages.filter(m=>m.kind==='final').length,1);
  const next=await api.turnInput(owner,{...inp('after-repair'),dialogue});assert.notEqual(next.turn_id,start.turn_id);
 });
 await t.test('больше 50 входов, рабочий блок и независимый checkpoint',async()=>{
  const dialogue={id:'many-managed',channel:'synthetic'};
  const inputs=Array.from({length:55},(_,i)=>({id:'item-'+i,text:i===0?'😀'.repeat(20000):'сообщение '+i}));
  const start=await api.turnInput(owner,{request_id:req(),dialogue,messages:inputs});
  const before=(await app.query('SELECT count(*)::int AS n FROM dialogues_live.messages WHERE owner_id=$1',[owner])).rows[0].n;
  const jobs=(await app.query('SELECT count(*)::int AS n FROM dialogues_live.summary_jobs WHERE owner_id=$1',[owner])).rows[0].n;
  await api.turnUpdate(owner,{request_id:req(),dialogue_id:dialogue.id,turn_id:start.turn_id,expected_version:start.version,changes:{add:[{id:'work',formulation:'Зафиксировать',source_refs:['item-0']}]}});
  assert.equal((await app.query('SELECT count(*)::int AS n FROM dialogues_live.messages WHERE owner_id=$1',[owner])).rows[0].n,before);
  assert.equal((await app.query('SELECT count(*)::int AS n FROM dialogues_live.summary_jobs WHERE owner_id=$1',[owner])).rows[0].n,jobs);
  const args={request_id:req(),consumer_id:'managed-consumer',context_instance_id:'managed-instance',dialogue_id:dialogue.id};let p=await api.pull(owner,args),items=[...p.items],delivery=p.delivery_id;
  while(p.continuation_cursor){p=await api.pull(owner,{...args,continuation_cursor:p.continuation_cursor});items.push(...p.items);}
  assert.equal(items.filter(x=>x.type==='message').length,50);const header=items.find(x=>x.type==='turn_work');assert.ok(header);
  const fragments=items.filter(x=>x.type==='turn_work_fragment');const body=fragments.length?fragments.map(x=>x.text).join(''):header.text;
  assert.equal(JSON.parse(body).messages.length,55);assert.equal(JSON.parse(body).messages[0].text,inputs[0].text);
  await api.ack(owner,{request_id:req(),consumer_id:args.consumer_id,context_instance_id:args.context_instance_id,delivery_id:delivery});
  const checkpoint=(await app.query('SELECT checkpoint FROM dialogues_live.context_consumers WHERE owner_id=$1 AND consumer_id=$2',[owner,args.consumer_id])).rows[0].checkpoint;
  await get({dialogue_id:dialogue.id});assert.equal((await app.query('SELECT checkpoint FROM dialogues_live.context_consumers WHERE owner_id=$1 AND consumer_id=$2',[owner,args.consumer_id])).rows[0].checkpoint,checkpoint);
 });
 await t.test('потеря ответа после commit не повторяет изменение',async()=>{
  const dialogue={id:'unknown-managed',channel:'synthetic'},packet={...inp('unknown-input'),dialogue};
  let lost=true;const wrapped={async connect(){const c=await app.connect();return {async query(sql,...args){const r=await c.query(sql,...args);if(lost&&sql==='COMMIT'){lost=false;throw new Error('synthetic lost receipt');}return r;},release(){c.release();}};}};
  await assert.rejects(createStore(wrapped,'synthetic-turn-key').turnInput(owner,packet),{code:'INTERNAL'});
  const snapshot=await get({dialogue_id:dialogue.id});assert.equal(snapshot.messages.length,1);
  const receipt=await api.turnInput(owner,packet);assert.equal(receipt.turn_id,snapshot.turn_id);assert.equal((await get({dialogue_id:dialogue.id})).messages.length,1);
 });
}
