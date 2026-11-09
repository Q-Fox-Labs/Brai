// ABOUTME: Исправляет один дневник отдельным эфемерным запросом существующей Luna.
// ABOUTME: Модель не получает инструменты, файлы, сеть, MCP или историю других записей.
import {WebSocket} from 'ws';
import {randomUUID} from 'node:crypto';
import {DiaryFault,instructions,text} from './domain.mjs';
/** Создаёт изолированный вызов; socket/CWD задаёт только защищённая конфигурация. */
export async function correctWithLuna(cfg,entry){
 const ws=new WebSocket(cfg.socketUrl,{maxPayload:4*1024*1024,handshakeTimeout:15000}),pending=new Map();let seq=0,thread,turn,active,timer;
 const fail=code=>new DiaryFault(code,503);
 const call=(method,params,ms=15000)=>new Promise((resolve,reject)=>{
  const id=++seq,t=setTimeout(()=>{pending.delete(id);reject(fail('LUNA_OUTCOME_UNKNOWN'));},ms);
  pending.set(id,{resolve,reject,t});ws.send(JSON.stringify({id,method,params}),e=>{if(e){clearTimeout(t);pending.delete(id);reject(fail('LUNA_UNAVAILABLE'));}});
 });
 ws.on('message',raw=>{try{
  const p=JSON.parse(raw.toString());
  if(p.method){
   if(p.id!==undefined&&p.params?.threadId===thread){ws.send(JSON.stringify({id:p.id,error:{code:-32601,message:'DIARY_TOOLS_DISABLED'}}));active?.reject(fail('LUNA_ISOLATION_VIOLATION'));}
   if(p.params?.threadId===thread&&active){
    const item=p.params.item;if(item&& !['userMessage','agentMessage','reasoning'].includes(item.type))active.reject(fail('LUNA_ISOLATION_VIOLATION'));
    if(p.method==='item/completed'&&item)active.items.set(item.id,item);
    if(p.method==='turn/completed')active.resolve(p.params.turn);
   }return;
  }
  const q=pending.get(p.id);if(!q)return;pending.delete(p.id);clearTimeout(q.t);
  p.error?q.reject(fail('LUNA_RPC_REJECTED')):q.resolve(p.result);
 }catch{active?.reject(fail('LUNA_PROTOCOL'));ws.terminate();}});
 ws.on('error',()=>active?.reject(fail('LUNA_UNAVAILABLE')));
 ws.on('close',()=>{for(const q of pending.values()){clearTimeout(q.t);q.reject(fail('LUNA_OUTCOME_UNKNOWN'));}pending.clear();active?.reject(fail('LUNA_OUTCOME_UNKNOWN'));});
 try{
  await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',()=>reject(fail('LUNA_UNAVAILABLE')));});
  await call('initialize',{clientInfo:{name:'brai_diary',version:'1.0.0'},capabilities:{experimentalApi:true}});
  ws.send(JSON.stringify({method:'initialized',params:{}}));
  const model=(await call('model/list',{})).data?.find(x=>x.model==='gpt-6-luna');
  if(!model||!model.supportedReasoningEfforts?.some(x=>x.reasoningEffort==='medium'))throw fail('LUNA_NOT_AVAILABLE');
  const base=(await call('config/read',{includeLayers:false})).config;
  const overrides={project_doc_max_bytes:0,web_search:'disabled',skills:{include_instructions:false,bundled:{enabled:false}},
   tools:{update_plan:{enabled:false},experimental_request_user_input:{enabled:false}},agents:{enabled:false},apps:{_default:{enabled:false}},plugins:{_default:{enabled:false}},
   features:{shell_tool:false,code_mode:false,code_mode_host:false,multi_agent:false,multi_agent_v2:false,apps:false,memories:false,view_image:false,image_generation:false,browser_use:false,computer_use:false,skill_search:false,tool_suggest:false,goals:false,sleep_tool:false}};
  for(const name of Object.keys(base?.mcp_servers??{}))overrides['mcp_servers.'+name+'.enabled']=false;
  for(const name of Object.keys(base?.plugins??{}))if(name!=='_default')overrides['plugins.'+name+'.enabled']=false;
  const started=await call('thread/start',{model:'gpt-6-luna',allowProviderModelFallback:false,cwd:cfg.cwd,ephemeral:true,historyMode:'legacy',threadSource:'dialogues_summary',serviceName:'brai_diary',environments:[],dynamicTools:[],approvalPolicy:'never',sandbox:'read-only',baseInstructions:instructions,developerInstructions:'Только редактура текущего дневника и извлечение даты в строгий JSON. Никаких инструментов.',config:overrides});
  thread=started.thread.id;
  if(started.model!=='gpt-6-luna'||started.thread.ephemeral!==true)throw fail('LUNA_ISOLATION_VIOLATION');
  const done=new Promise((resolve,reject)=>{active={resolve,reject,items:new Map()};timer=setTimeout(()=>reject(fail('LUNA_TIMEOUT')),180000);});
  void done.catch(()=>{});
  const input=JSON.stringify({rawText:text(entry.rawText),recordedAt:entry.audioInput.recordedAt,timezone:entry.audioInput.timezone,uploadedAt:entry.createdAt});
  const launched=await call('turn/start',{threadId:thread,model:'gpt-6-luna',effort:'medium',environments:[],clientUserMessageId:randomUUID(),input:[{type:'text',text:input}]});
  turn=launched.turn.id;const result=await done;
  if(result.id!==turn||result.status!=='completed')throw fail('LUNA_EXECUTION_FAILED');
  for(const item of result.items??[])if(!active.items.has(item.id))active.items.set(item.id,item);
  const items=[...active.items.values()];
  if(items.some(i=>!['userMessage','agentMessage','reasoning'].includes(i.type)))throw fail('LUNA_ISOLATION_VIOLATION');
  const output=items.filter(i=>i.type==='agentMessage'&&(i.phase==='final_answer'||!i.phase)).map(i=>i.text??'').join('\n');
  text(output);turn=undefined;return output;
 }finally{
  clearTimeout(timer);active=undefined;
  if(thread&&ws.readyState===WebSocket.OPEN){
   if(turn)await call('turn/interrupt',{threadId:thread,turnId:turn},5000).catch(()=>{});
   await call('thread/unsubscribe',{threadId:thread},5000).catch(()=>{});
  }
  ws.terminate();
 }
}
