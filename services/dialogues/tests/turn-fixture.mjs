// ABOUTME: Проверяет управляемые ходы на настоящем изолированном PostgreSQL.
// ABOUTME: Все данные синтетические; старые записи не изменяются.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {createStore} from '../dist/store.js';
import {startMcp} from '../dist/mcp.js';
/** Проверяет управляемые ходы на отдельной временной базе. */
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
  await assert.rejects(api.turnUpdate(owner,{request_id:req(),dialogue_id:dialogue.id,turn_id:s.turn_id,expected_version:u.version,changes:{add:[{id:'bad-ref',formulation:'Чужая ссылка',source_refs:['unknown-input']}]}}),{code:'INVALID_SOURCE_REFS'});
  const f={request_id:req(),dialogue_id:dialogue.id,turn_id:s.turn_id,expected_version:u.version,final:{id:'final-one',text:'итог'}};
  await assert.rejects(api.turnFinish(owner,{...f,changes:{update:[{id:'first',status:'done',result:'не должно сохраниться'}]}}),e=>e.code==='PENDING_RESULTS'&&e.details.pending.length===1);
  s=await get({dialogue_id:dialogue.id});assert.equal(s.version,u.version);assert.equal(s.messages.length,2);
  assert.equal(s.results.find(r=>r.id==='first').status,'pending');
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
  await assert.rejects(api.append(owner,{request_id:req(),dialogue,messages:[{id:'old-again',turn_id:'old-turn',role:'user',kind:'input',text:'повторно открыть',turn_status:'in_progress'}]}),{code:'MANAGED_TURN_OPEN'});
 });
 await t.test('неподтверждённый финал сохраняется, но после сверки ход продолжается',async()=>{
  const dialogue={id:'prepared-managed',channel:'synthetic'};const start=await api.turnInput(owner,{...inp('prepared-input'),dialogue});
  const jobs=(await app.query('SELECT count(*)::int AS n FROM dialogues_live.summary_jobs WHERE owner_id=$1',[owner])).rows[0].n;
  await api.append(owner,{request_id:req(),dialogue,messages:[{id:'prepared-final',turn_id:start.turn_id,role:'assistant',kind:'final',text:'подготовленный ответ'}]});
  assert.equal((await app.query('SELECT count(*)::int AS n FROM dialogues_live.summary_jobs WHERE owner_id=$1',[owner])).rows[0].n,jobs);
  await assert.rejects(api.turnInput(owner,{...inp('continue-input'),dialogue}),{code:'FINAL_RECONCILIATION_REQUIRED'});
  const continued=await api.turnInput(owner,{...inp('continue-input'),dialogue,reconciled_no_final:true});assert.equal(continued.turn_id,start.turn_id);
  const view=await get({dialogue_id:dialogue.id});assert.equal(view.messages.find(m=>m.id==='prepared-final').publication_status,'not_confirmed');
  await api.turnFinish(owner,{request_id:req(),dialogue_id:dialogue.id,turn_id:start.turn_id,expected_version:continued.version,final:{id:'actual-final-2',text:'настоящий ответ'}});
  const args={request_id:req(),consumer_id:'prepared-consumer',context_instance_id:'prepared-instance'};let p=await api.pull(owner,args),items=[...p.items];while(p.continuation_cursor){p=await api.pull(owner,{...args,continuation_cursor:p.continuation_cursor});items.push(...p.items);}
  assert.ok(!items.some(x=>x.type==='message'&&x.id==='prepared-final'));assert.ok(items.some(x=>x.type==='message'&&x.id==='actual-final-2'));
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
  await assert.rejects(api.turnRepair(owner,{request_id:req(),dialogue_id:dialogue.id,turn_id:s.turn_id,expected_version:s.version,final_message_id:'actual-final',evidence:{kind:'native_client',native_thread_id:'wrong',native_turn_id:'turn',phase:'final_answer',status:'completed'}}),{code:'FINAL_SOURCE_MISMATCH'});
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
 await t.test('reset bootstrap: продолжение наследует параметры и сохраняет ACK',async()=>{
  await api.summary(owner,{request_id:req(),dialogue_id:'many-managed',target:'message',message_id:'item-54',expected_version:null,text:'ы'.repeat(40000)});
  for(const legacy of [false,true]){
   const args={request_id:req(),consumer_id:legacy?'legacy-reset':'new-reset',context_instance_id:'ctx',reset:true,...(legacy?{}:{dialogue_id:'many-managed'})};
   let p=await api.pull(owner,args);assert.ok(p.continuation_cursor);const delivery=p.delivery_id;
   if(legacy)await app.query('UPDATE dialogues_live.context_deliveries SET request_options=NULL WHERE owner_id=$1 AND id=$2',[owner,delivery]);
   const next={request_id:args.request_id,consumer_id:args.consumer_id,context_instance_id:args.context_instance_id,continuation_cursor:p.continuation_cursor};
   await assert.rejects(api.pull(owner,{...next,reset:false}),{code:'REQUEST_CONFLICT'});
   await assert.rejects(api.ack(owner,{request_id:req(),consumer_id:args.consumer_id,context_instance_id:args.context_instance_id,delivery_id:delivery}),{code:'PAGES_INCOMPLETE'});
   p=await api.pull(owner,next);assert.deepEqual(await api.pull(owner,next),p);
   while(p.continuation_cursor)p=await api.pull(owner,{...next,continuation_cursor:p.continuation_cursor});
   const receipt=await api.ack(owner,{request_id:req(),consumer_id:args.consumer_id,context_instance_id:args.context_instance_id,delivery_id:delivery});assert.equal(receipt.acknowledged,true);
   const following=await api.pull(owner,{request_id:req(),consumer_id:args.consumer_id,context_instance_id:args.context_instance_id});assert.equal(following.summaries_mode,'updates');
  }
 });
 await t.test('гонка финала и дополнения сохраняет оба сообщения без второго открытого хода',async()=>{
  const dialogue={id:'finish-race',channel:'synthetic'};const start=await api.turnInput(owner,{...inp('race-input'),dialogue});
  const finishing=api.turnFinish(owner,{request_id:req(),dialogue_id:dialogue.id,turn_id:start.turn_id,expected_version:start.version,final:{id:'race-final',text:'итог'}});
  const steering=api.turnInput(owner,{...inp('race-steer'),dialogue});const results=await Promise.allSettled([finishing,steering]);
  const steer=results[1];assert.equal(steer.status,'fulfilled');const old=await get({dialogue_id:dialogue.id,turn_id:start.turn_id});
  if(results[0].status==='fulfilled'){assert.equal(old.status,'completed');assert.notEqual(steer.value.turn_id,start.turn_id);}else{assert.equal(results[0].reason.code,'VERSION_CONFLICT');assert.equal(steer.value.turn_id,start.turn_id);assert.equal(old.messages.at(-1).id,'race-steer');}
 });
 await t.test('потерянная квитанция финала восстанавливается без второго ответа',async()=>{
  const dialogue={id:'unknown-finish',channel:'synthetic'};const start=await api.turnInput(owner,{...inp('unknown-finish-input'),dialogue});let lost=true;
  const wrapped={async connect(){const c=await app.connect();return {async query(sql,...args){const r=await c.query(sql,...args);if(lost&&sql==='COMMIT'){lost=false;throw new Error('lost receipt');}return r;},release(){c.release();}};}};
  const packet={request_id:req(),dialogue_id:dialogue.id,turn_id:start.turn_id,expected_version:start.version,final:{id:'unknown-finish-final',text:'один итог'}};
  await assert.rejects(createStore(wrapped,'synthetic-turn-key').turnFinish(owner,packet),{code:'INTERNAL'});const after=await get({dialogue_id:dialogue.id,turn_id:start.turn_id});assert.equal(after.status,'completed');
  const receipt=await api.turnFinish(owner,packet);assert.equal(receipt.status,'completed');assert.equal(after.messages.filter(m=>m.kind==='final').length,1);
 });
 await t.test('реальные операции через MCP и proxy после restart',async()=>{
  const cfg={host:'127.0.0.1',port:0,owner,hosts:['initial'],origins:['http://initial'],token:'synthetic-token-012345678901234567890123456789'};
  let listener=await startMcp(api,cfg);const url=new URL(listener.url);cfg.hosts.push(url.host);cfg.origins.push(url.origin);
  const tmp=fileURLToPath(new URL('../../../tmp/',import.meta.url));await mkdir(tmp,{recursive:true});const dir=await mkdtemp(join(tmp,'dialogues-managed-mcp-')),token=join(dir,'token');await writeFile(token,cfg.token,{mode:0o600});
  const proxy=new Client({name:'managed-fixture',version:'1'});
  try{
   await proxy.connect(new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../dist/stdio-proxy.js',import.meta.url))],env:{...process.env,DIALOGUES_MCP_URL:listener.url,DIALOGUES_MCP_TOKEN_FILE:token}}));
   const invalid=await proxy.callTool({name:'dialogues_turn_input',arguments:{request_id:'ok',dialogue:{id:'mcp',channel:'synthetic'},messages:[]}});const issue=JSON.parse(invalid.content[0].text);assert.equal(issue.code,'INVALID_ARGUMENT');assert.equal(issue.field,'messages');assert.equal(issue.applied,false);
   const first=await proxy.callTool({name:'dialogues_turn_input',arguments:{request_id:req(),dialogue:{id:'mcp',channel:'synthetic'},messages:[{id:'mcp-in',text:'тест'}]}});assert.ok(first.structuredContent.turn_id);
   const added=await proxy.callTool({name:'dialogues_turn_update',arguments:{request_id:req(),dialogue_id:'mcp',turn_id:first.structuredContent.turn_id,expected_version:first.structuredContent.version,changes:{add:[{id:'long',formulation:'х'.repeat(100000)}]}}});
   const blocked=await proxy.callTool({name:'dialogues_turn_finish',arguments:{request_id:req(),dialogue_id:'mcp',turn_id:first.structuredContent.turn_id,expected_version:added.structuredContent.version,final:{id:'mcp-final',text:'готово'}}});assert.equal(JSON.parse(blocked.content[0].text).pending[0].id,'long');assert.ok(Buffer.byteLength(JSON.stringify(blocked))<65024);
   const done=await proxy.callTool({name:'dialogues_turn_update',arguments:{request_id:req(),dialogue_id:'mcp',turn_id:first.structuredContent.turn_id,expected_version:added.structuredContent.version,changes:{update:[{id:'long',status:'done'}]}}});
   const pullArgs={request_id:req(),consumer_id:'mcp-reset',context_instance_id:'ctx',reset:true,dialogue_id:'mcp'};
   const initial=await proxy.callTool({name:'dialogues_context_pull',arguments:pullArgs});assert.ok(initial.structuredContent.continuation_cursor);
   const conflict=await proxy.callTool({name:'dialogues_context_pull',arguments:{...pullArgs,reset:false,continuation_cursor:initial.structuredContent.continuation_cursor}});assert.equal(JSON.parse(conflict.content[0].text).code,'REQUEST_CONFLICT');
   await listener.close();cfg.port=Number(url.port);listener=await startMcp(api,cfg);
   let page=await proxy.callTool({name:'dialogues_context_pull',arguments:{request_id:pullArgs.request_id,consumer_id:pullArgs.consumer_id,context_instance_id:pullArgs.context_instance_id,continuation_cursor:initial.structuredContent.continuation_cursor}});assert.equal(page.isError,undefined);
   while(page.structuredContent.continuation_cursor)page=await proxy.callTool({name:'dialogues_context_pull',arguments:{request_id:pullArgs.request_id,consumer_id:pullArgs.consumer_id,context_instance_id:pullArgs.context_instance_id,continuation_cursor:page.structuredContent.continuation_cursor}});
   const ack=await proxy.callTool({name:'dialogues_context_ack',arguments:{request_id:req(),consumer_id:pullArgs.consumer_id,context_instance_id:pullArgs.context_instance_id,delivery_id:initial.structuredContent.delivery_id}});assert.equal(ack.structuredContent.acknowledged,true);
   let read=await proxy.callTool({name:'dialogues_turn_get',arguments:{dialogue_id:'mcp'}}),body=read.structuredContent.text;assert.equal(read.isError,undefined);while(read.structuredContent.next_cursor){read=await proxy.callTool({name:'dialogues_turn_get',arguments:{dialogue_id:'mcp',cursor:read.structuredContent.next_cursor}});body+=read.structuredContent.text;}assert.equal(JSON.parse(body).messages[0].text,'тест');
   const final=await proxy.callTool({name:'dialogues_turn_finish',arguments:{request_id:req(),dialogue_id:'mcp',turn_id:first.structuredContent.turn_id,expected_version:done.structuredContent.version,final:{id:'mcp-final',text:'готово'}}});assert.equal(final.structuredContent.status,'completed');
  }finally{await proxy.close().catch(()=>{});await listener.close();await rm(dir,{recursive:true,force:true});}
 });
}
