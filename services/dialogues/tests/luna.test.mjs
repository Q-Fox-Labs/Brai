// ABOUTME: Проверяет временные запросы, повторы и изоляцию Luna на локальном fake App Server.
// ABOUTME: Не вызывает модель, общий daemon или реальные MCP и переписку.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {WebSocketServer} from 'ws';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createLuna} from '../dist/luna.js';

async function fixture(mode='completed'){
 // AIDEV-NOTE: Unix socket должен помещаться в системный sun_path независимо от длины worktree.
 const dir=await mkdtemp(join(tmpdir(),'brai-dialogues-')),path=join(dir,'rpc.sock');
 const server=createServer(),wss=new WebSocketServer({server});
 const threads=new Map(),calls=[],replies=[];let next=0,turnStarts=0,configReads=0;
 wss.on('connection',socket=>socket.on('message',raw=>{
  const p=JSON.parse(raw.toString());if(!p.method){replies.push(p);return;}calls.push(p);
  const send=result=>socket.send(JSON.stringify({id:p.id,result}));
  const reject=()=>socket.send(JSON.stringify({id:p.id,error:{code:-32602,message:'Synthetic reject'}}));
  if(p.method==='initialize')send({userAgent:'synthetic/0.166.0'});
  else if(p.method==='model/list')send({data:[{model:'gpt-6-luna',supportedReasoningEfforts:[{reasoningEffort:'medium'},{reasoningEffort:'low'}]}]});
  else if(p.method==='config/read'){
   configReads++;if(mode==='config-fail'&&configReads===1)reject();else send({config:{mcp_servers:{synthetic:{}},plugins:{'test@fixture':{enabled:true}}}});
  }else if(p.method==='thread/start'){
   const id='service-thread-'+(++next);threads.set(id,[]);send({thread:{id,ephemeral:p.params.ephemeral},model:'gpt-6-luna'});
  }else if(p.method==='turn/start'){
   turnStarts++;
   if(mode==='reject'&&turnStarts===1){reject();return;}
   const id='turn-'+turnStarts;
   const items=[{id:'native-user-item',clientId:p.params.clientUserMessageId,type:'userMessage',content:[{type:'text',text:'synthetic'}]},{id:'answer',type:'agentMessage',phase:'final_answer',text:(()=>{const answer=mode==='huge'?'Ж😀'.repeat(40000):mode==='oversize-chars'&&p.params.outputSchema?'A'.repeat(3501):mode==='oversize-always'||mode.startsWith('oversize')&&turnStarts===1?'ф'.repeat(5000):'Бюджет 37 рублей, поручение не завершено.';return p.params.outputSchema?JSON.stringify({summary:answer}):answer;})()}];
   const turn={id,status:mode==='failed'&&turnStarts===1?'failed':'completed',items};
   if(mode==='tool')items.push({id:'forbidden',type:'mcpToolCall'});
   threads.get(p.params.threadId).push(turn);
   if(mode==='unknown'&&turnStarts===1||mode==='oversize-unknown'&&turnStarts===2){socket.close();return;}
   const completed=()=>{
    socket.send(JSON.stringify({method:'item/completed',params:{threadId:'foreign-thread',item:{id:'foreign',type:'agentMessage',text:'wrong'}}}));
    for(const item of items)socket.send(JSON.stringify({method:'item/completed',params:{threadId:p.params.threadId,turnId:id,item}}));
    socket.send(JSON.stringify({method:'turn/completed',params:{threadId:p.params.threadId,turn:{...turn,items:mode==='summary-truncated'?items.map(i=>({...i,text:'truncated'})):[]}}}));
   };
   if(mode==='early')completed();
   send({turn:{id,status:'inProgress',items:[]}});
   if(mode!=='early'&&mode!=='hang')completed();
   if(mode==='tool'){
    socket.send(JSON.stringify({id:777,method:'item/tool/call',params:{threadId:p.params.threadId,name:'forbidden'}}));
    socket.send(JSON.stringify({id:778,method:'item/tool/call',params:{threadId:'foreign-thread',name:'foreign'}}));
   }
  }else if(p.method==='thread/read')reject();
  else if(['thread/unsubscribe','turn/interrupt'].includes(p.method))send({});
  else if(p.id!==undefined)reject();
 }));
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(path,resolve);});
 const luna=createLuna('ws+unix:'+path+':/','/tmp');
 return {luna,calls,replies,get starts(){return turnStarts;},async close(){await luna.close();for(const x of wss.clients)x.terminate();await new Promise(r=>wss.close(r));await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}};
}
test('Luna: потерянный временный запрос повторяется без чтения истории',async()=>{
 const f=await fixture('unknown');let state={};
 try{
  await assert.rejects(f.luna.run('synthetic',state,async x=>{state=x;}),{code:'NATIVE_OUTCOME_UNKNOWN'});
  assert.equal(state.execution_state,'running');assert.equal(state.native_thread_id,undefined);
  const result=await f.luna.run('synthetic',state,async x=>{state=x;});
  assert.match(result,/37/);assert.equal(f.starts,2);assert.equal(state.execution_state,'completed');
  assert.equal(f.calls.some(x=>x.method==='thread/read'),false);
 }finally{await f.close();}
});
test('Luna: точная модель, минимальный effort и thread-local запреты',async()=>{
 const f=await fixture();
 try{
  await f.luna.probe();const params=f.calls.find(x=>x.method==='thread/start').params;
  assert.equal(params.ephemeral,true);
  assert.equal(params.model,'gpt-6-luna');assert.equal(params.allowProviderModelFallback,false);
  assert.equal(params.config['mcp_servers.synthetic.enabled'],false);assert.equal(params.config['plugins.test@fixture.enabled'],false);
  assert.equal(params.config.project_doc_max_bytes,0);assert.equal(params.config.skills.include_instructions,false);
  assert.equal(params.config.features.shell_tool,false);assert.equal(params.config.features.multi_agent,false);
  assert.deepEqual(params.environments,[]);assert.deepEqual(params.dynamicTools,[]);
  assert.equal(f.calls.find(x=>x.method==='turn/start').params.effort,'low');
 }finally{await f.close();}
});
test('Luna: явный rejected/failed исход допускает новую попытку',async()=>{
 for(const mode of ['reject','failed']){
  const f=await fixture(mode);let state={};
  try{
   await assert.rejects(f.luna.run('synthetic',state,async x=>{state=x;}),{code:mode==='reject'?'LUNA_RPC_REJECTED':'LUNA_EXECUTION_FAILED'});
   assert.equal(state.execution_state,'running');
   assert.match(await f.luna.run('synthetic',state,async x=>{state=x;}),/37/);assert.equal(f.starts,2);
  }finally{await f.close();}
 }
});
test('Luna: config failure не открывает запуск без изоляции',async()=>{
 const f=await fixture('config-fail');
 try{
  await assert.rejects(f.luna.run('synthetic',{},async()=>{}),{code:'LUNA_RPC_REJECTED'});
  assert.equal(f.starts,0);assert.equal(f.calls.filter(x=>x.method==='thread/start').length,0);
  assert.match(await f.luna.run('synthetic',{},async()=>{}),/37/);
  assert.ok(f.calls.filter(x=>x.method==='config/read').length>=2);
 }finally{await f.close();}
});
test('Luna: отклоняет свои tool requests и не отвечает на чужие',async()=>{
 const f=await fixture('tool');
 try{
  await assert.rejects(f.luna.run('synthetic',{},async()=>{}),{code:'LUNA_ISOLATION_VIOLATION'});
  await new Promise(r=>setTimeout(r,20));
  assert.equal(f.replies.find(x=>x.id===777)?.error?.message,'DIALOGUES_TOOLS_DISABLED');
  assert.equal(f.replies.some(x=>x.id===778),false);
 }finally{await f.close();}
});

test('Luna: summary >8KiB принимается целиком без повторной компрессии',async()=>{
 const f=await fixture('oversize');let state={};
 try{
  const result=await f.luna.run('synthetic',state,async x=>{state=x;});
  assert.equal(result,'ф'.repeat(5000));assert.equal(Buffer.byteLength(result),10000);assert.equal(f.starts,1);
  assert.equal(state.result,result);assert.equal(state.execution_state,'completed');
  assert.equal(f.calls.find(x=>x.method==='turn/start').params.outputSchema,undefined);
  assert.ok(!f.calls.find(x=>x.method==='thread/start').params.baseInstructions.includes('8192'));
 }finally{await f.close();}
});
test('Luna: summary >64KiB и Unicode проходят события без усечения',async()=>{
 const f=await fixture('huge');let state={};
 try{
  const result=await f.luna.run('synthetic',state,async x=>{state=x;});
  assert.equal(result,'Ж😀'.repeat(40000));assert.equal(f.starts,1);
  assert.ok(Buffer.byteLength(result)>65536);assert.equal(state.result,result);
 }finally{await f.close();}
});
test('Luna: старый completed root используется полностью, size-compression caches игнорируются',async()=>{
 const f=await fixture();const raw='Полный текст 😀 '.repeat(10000);
 const state={native_thread_id:'original-root',native_turn_id:'original-turn',execution_state:'completed',result:raw,
  compressions:[{execution_state:'completed',result:'Неудачный короткий cache'}],compression_v2:{prompt_version:'rejected',executions:[{result:'Неполный'}]}};
 const snapshot=structuredClone(state);
 try{
  assert.equal(await f.luna.run('synthetic',state,async()=>assert.fail('cached source must not be relaunched')),raw);
  assert.equal(f.starts,0);assert.deepEqual(state,snapshot);
 }finally{await f.close();}
});


test('Luna: ранние события перед RPC-ответом дают полный результат и закрывают соединение',async()=>{
 const f=await fixture('early');let state={};
 try{
  assert.match(await f.luna.run('synthetic',state,async x=>{state=x;}),/37/);
  assert.equal(state.native_thread_id,undefined);
  assert.equal(f.calls.filter(x=>x.method==='thread/unsubscribe').length,1);
  assert.equal(f.calls.some(x=>x.method==='thread/read'),false);
  assert.match(await f.luna.run('synthetic',{},async()=>{}),/37/);
  assert.equal(f.calls.filter(x=>x.method==='thread/unsubscribe').length,2);
 }finally{await f.close();}
});
test('Luna: restart с прежними native IDs повторяет только незавершённый фрагмент',async()=>{
 const f=await fixture();let state={native_thread_id:'old-durable-thread',native_turn_id:'old-turn',execution_state:'running'};
 try{
  assert.match(await f.luna.run('synthetic',state,async x=>{state=x;}),/37/);
  assert.equal(f.starts,1);assert.equal(state.native_thread_id,undefined);
  assert.equal(f.calls.some(x=>x.method==='thread/read'),false);
 }finally{await f.close();}
});
test('Luna: сбой сохранения результата освобождает временный запрос',async()=>{
 const f=await fixture();
 try{
  await assert.rejects(f.luna.run('synthetic',{},async x=>{if(x.execution_state==='completed')throw new Error('save failed');}),/save failed/);
  assert.equal(f.calls.filter(x=>x.method==='thread/unsubscribe').length,1);
  assert.match(await f.luna.run('synthetic',{},async()=>{}),/37/);
 }finally{await f.close();}
});


test('Luna: summary-view завершения не заменяет полный item/completed',async()=>{
 const f=await fixture('summary-truncated');
 try{assert.match(await f.luna.run('synthetic',{},async()=>{}),/37/);}finally{await f.close();}
});


test('Luna: таймаут прерывает собственный ход и освобождает подписку',async t=>{
 const original=setTimeout;
 t.mock.method(globalThis,'setTimeout',(callback,delay,...args)=>original(callback,delay===120000?20:delay,...args));
 const f=await fixture('hang');
 try{
  await assert.rejects(f.luna.run('synthetic',{},async()=>{}),{code:'LUNA_EXECUTION_TIMEOUT'});
  assert.equal(f.calls.filter(x=>x.method==='turn/interrupt').length,1);
  assert.equal(f.calls.filter(x=>x.method==='thread/unsubscribe').length,1);
 }finally{await f.close();}
});
