// ABOUTME: Сверяет потерянное завершение с read-only API штатного исполнителя.
// ABOUTME: Не запускает и не возобновляет чаты; отсутствие события не подтверждает остановку.
import WebSocket from 'ws';
import {lstat,realpath} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {canonical} from './contracts.mjs';
import {importNativeCompletion} from './write-completion.mjs';
const hash=value=>createHash('sha256').update(canonical(value)).digest('hex');

/** Читает одну страницу items; соединение не умеет запускать ходы или менять настройки. */
export async function readExecutorItems(socketPath,threadId,turnId,cursor=null,logicalThreadId=threadId) {
  if(!path.isAbsolute(socketPath)||path.normalize(socketPath)!==socketPath)throw Error('EXECUTOR_SOCKET_INVALID');
  // AIDEV-NOTE: Штатный Codex публикует alias на короткий сокет в закрытом каталоге daemon UID.
  const target=await realpath(socketPath),alias=await lstat(socketPath),socket=await lstat(target);
  for(const directory of [path.dirname(socketPath),path.dirname(target)]){
    const parent=await lstat(directory);
    if(!parent.isDirectory()||parent.isSymbolicLink()||parent.uid!==process.getuid()||(parent.mode&0o077))throw Error('EXECUTOR_SOCKET_INVALID');
  }
  if(alias.uid!==process.getuid()||!socket.isSocket()||socket.uid!==process.getuid()||(socket.mode&0o077))throw Error('EXECUTOR_SOCKET_INVALID');
  const ws=new WebSocket('ws+unix://'+target+':/',{maxPayload:16*1024*1024});
  const pending=new Map();let sequence=0;
  const call=(method,params)=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
  const cancel=error=>{for(const entry of pending.values())entry.reject(error);pending.clear();};
  const timer=setTimeout(()=>{cancel(Error('EXECUTOR_READ_TIMEOUT'));ws.terminate();},3000);
  ws.on('message',bytes=>{try{const message=JSON.parse(String(bytes)),entry=pending.get(message.id);if(entry){pending.delete(message.id);if(message.error)entry.reject(Error('EXECUTOR_READ_FAILED'));else entry.resolve(message.result);}}catch{cancel(Error('EXECUTOR_READ_INVALID'));ws.terminate();}});
  ws.on('error',()=>cancel(Error('EXECUTOR_UNAVAILABLE')));
  ws.on('close',()=>cancel(Error('EXECUTOR_DISCONNECTED')));
  try{
    await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);ws.once('close',()=>reject(Error('EXECUTOR_DISCONNECTED')));});
    await call('initialize',{clientInfo:{name:'codeworks_completion_reader',version:'1'}});
    ws.send(JSON.stringify({method:'initialized',params:{}}));
    if(threadId!==logicalThreadId){
      const info=(await call('thread/read',{threadId})).thread,spawn=info?.source?.subAgent?.thread_spawn;
      if(info?.id!==threadId||info.parentThreadId!==logicalThreadId||spawn?.parent_thread_id!==logicalThreadId||spawn.depth!==1)throw Error('EXECUTOR_LINEAGE_INVALID');
    }
    // AIDEV-NOTE: turns/list поддерживает также старые legacy histories; items/list может их отвергать.
    const response=await call('thread/turns/list',{threadId,limit:1,itemsView:'full',sortDirection:'desc',...(cursor?{cursor}: {})});
    if(!Array.isArray(response?.data)||response.data.length>1||(response.nextCursor!==null&&typeof response.nextCursor!=='string'))throw Error('EXECUTOR_READ_INVALID');
    return {data:response.data.filter(t=>t.id===turnId).flatMap(t=>(t.items??[]).map(item=>({turnId:t.id,item}))),nextCursor:response.data.some(t=>t.id===turnId)?null:response.nextCursor};
  }finally{clearTimeout(timer);ws.close();}
}

/** Проверяет точный terminal item; не выводит состояние писателя из состояния хода. */
export function executorProof(call,entry) {
  const item=entry?.item;
  if(entry?.turnId!==call.turn_id||item?.id!==call.tool_use_id)return null;
  let outcome;
  if(call.tool_name==='Bash'&&item.type==='commandExecution'&&['completed','failed','declined'].includes(item.status)){
    if(item.status!=='declined'&&!Number.isSafeInteger(item.exitCode))return null;
    outcome=item.status==='completed'&&item.exitCode===0?'success':'error';
  }else if(call.tool_name==='apply_patch'&&item.type==='fileChange'&&['completed','failed','declined'].includes(item.status))outcome=item.status==='completed'?'success':'error';
  else return null;
  if(!call.admitted_at||!['in_flight','uncertain'].includes(call.state))return null;
  const proof={version:3,provenance:'executor_api',write_call_id:call.id,project_id:call.project_id,workspace_id:call.workspace_id,executor_id:call.executor_id,session_id:call.session_id,turn_id:call.turn_id,tool_use_id:call.tool_use_id,tool_name:call.tool_name,payload_sha256:call.payload_sha256,rewritten_sha256:call.rewritten_sha256,outcome,item_type:item.type,item_status:item.status,observation_sha256:hash({turnId:entry.turnId,item})};
  return {...proof,receipt_sha256:hash(proof)};
}

/** Ограниченный проход Temporal; API ошибки сохраняют писателя до следующей сверки. */
export async function recoverExecutorCompletions(pool,projectId,{socketPath,allowedRepositories,git,read=readExecutorItems}={}) {
  if(!socketPath)return {recovered:0};
  const calls=(await pool.query(`SELECT c.* FROM codeworks.write_calls c JOIN codeworks.workspaces w ON w.id=c.workspace_id
    WHERE c.project_id=$1 AND c.executor_id='codex' AND c.state IN ('in_flight','uncertain')
    AND c.admitted_at IS NOT NULL AND w.removed_at IS NULL
    AND ((w.activation_state='awaiting_first_write' AND c.tool_name='Bash') OR EXISTS(SELECT 1 FROM codeworks.cleanup_obligations o WHERE o.workspace_id=w.id AND o.state<>'done') OR EXISTS(SELECT 1 FROM codeworks.operations r WHERE r.workspace_id=w.id AND r.kind='release' AND NOT r.archived AND r.status IN ('running','awaiting_reconciliation','awaiting_execution') AND r.step IN ('LOCAL_CHECKOUT_SYNC_REQUIRED','WRITER_OUTCOME_UNKNOWN')))
    ORDER BY c.updated_at,c.id LIMIT 8`,[projectId])).rows;
  let recovered=0;
  for(const call of calls){
    try{
      const page=await read(socketPath,call.tool_result?.executor_thread_id??call.session_id,call.turn_id,call.tool_result?.executor_scan_cursor??null,call.session_id);
      const entries=page.data.filter(entry=>entry.turnId===call.turn_id&&entry.item?.id===call.tool_use_id);
      if(entries.length>1)throw Error('EXECUTOR_ITEM_CONFLICT');
      const proof=entries.length===1?executorProof(call,entries[0]):null;
      if(proof){await importNativeCompletion(pool,null,{allowedRepositories,git,verifyReceipt:async()=>proof});recovered++;}
      else await pool.query(`UPDATE codeworks.write_calls SET tool_result=COALESCE(tool_result,'{}') || jsonb_build_object('executor_scan_cursor',$2::text),updated_at=now() WHERE id=$1 AND state IN ('in_flight','uncertain')`,[call.id,page.nextCursor]);
    }catch{
      // AIDEV-NOTE: Ни ошибка API, ни отсутствие item не разрешают освобождать ресурсы.
      await pool.query("UPDATE codeworks.write_calls SET updated_at=now() WHERE id=$1 AND state IN ('in_flight','uncertain')",[call.id]);
    }
  }
  return {recovered};
}
