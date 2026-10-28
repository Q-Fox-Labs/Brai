// ABOUTME: Проверяет native completion и защищённую расписку для восстановления учёта записи.
// ABOUTME: Не сохраняет команды или вывод и не исполняет shell; принятие остаётся в write admission.
import {open,lstat,realpath} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {foregroundCommand} from './hook.mjs';
import {createGit} from './git.mjs';
import {createWriteAdmission} from './write-admission.mjs';
const hash=x=>createHash('sha256').update(x).digest('hex');
const MAX_SOURCE=64*1024*1024,MAX_RECEIPT=16384;
const fail=()=>{throw Error('NATIVE_COMPLETION_UNVERIFIED');};
const keys=['version','write_call_id','project_id','workspace_id','executor_id','session_id','turn_id','tool_use_id','tool_name','payload_sha256','rewritten_sha256','exit_code','native_event_sha256','native_thread_id','parent_thread_id','lineage_sha256'];
async function readExact(file,limit){
 if(typeof file!=='string'||!path.isAbsolute(file)||path.normalize(file)!==file||await realpath(file)!==file)fail();
 const h=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);try{
  const before=await h.stat();if(!before.isFile()||before.nlink!==1||before.size>limit)fail();
  const bytes=await h.readFile();const after=await h.stat();if(bytes.length>limit||before.dev!==after.dev||before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs)fail();return {bytes,stat:before};
 }finally{await h.close();}
}
/** Возвращает доказанные metadata; точный input восстанавливается только при совпадении обоих ledger digest. */
export async function attestNativeCompletion({sourcePath,call,project,workspace}){
 if(!call||!workspace||!project||call.project_id!==project.id||call.workspace_id!==workspace.id||call.executor_id!=='codex'||call.tool_name!=='Bash'||!['in_flight','uncertain'].includes(call.state)||!call.admitted_at||!Number.isFinite(Date.parse(call.admitted_at))||!/^([a-f0-9]{64})$/.test(call.payload_sha256??'')||!/^([a-f0-9]{64})$/.test(call.rewritten_sha256??''))fail();
 const {bytes}=await readExact(sourcePath,MAX_SOURCE);let offset=0,session=null,sessionLine=null,found=[];
 while(offset<bytes.length){const end=bytes.indexOf(10,offset);if(end<0)fail();const line=bytes.subarray(offset,end+1);offset=end+1;let event;try{event=JSON.parse(line.toString('utf8'));}catch{fail();}
  if(event.type==='session_meta'){if(session)fail();session=event.payload;sessionLine=line;}
  const p=event.payload,item=p?.item;if(event.type!=='event_msg'||p?.type!=='item_completed'||item?.id!==call.tool_use_id)continue;
  if(!session||p.thread_id!==session.id||p.turn_id!==call.turn_id||item.type!=='CommandExecution'||item.source!=='unified_exec_startup'||item.status!=='completed'||!Number.isSafeInteger(item.exit_code)||typeof item.process_id!=='string'||!/^\d+$/.test(item.process_id)||!Array.isArray(item.command)||item.command.length!==3||item.command[0]!=='/bin/bash'||item.command[1]!=='-lc'||typeof item.command[2]!=='string'||!foregroundCommand(item.command[2])||typeof item.cwd!=='string')fail();
  let cwd;try{cwd=fileURLToPath(item.cwd);}catch{fail();}if(cwd!==workspace.path)fail();
  if(!event.timestamp||!Number.isFinite(Date.parse(event.timestamp))||Date.parse(event.timestamp)<Date.parse(call.admitted_at))fail();
  const input={command:item.command[2]};if(hash(JSON.stringify(input))!==call.rewritten_sha256)fail();
  found.push({line,command:item.command[2],exit_code:item.exit_code});
 }
 if(!session||typeof session.id!=='string'||session.cwd!==project.repo_path||found.length!==1)fail();
 const parent=session.parent_thread_id??null,spawn=session.source?.subagent?.thread_spawn;
 if(session.id===call.session_id){if(parent!==null||spawn?.parent_thread_id)fail();}
 else if(parent!==call.session_id||spawn?.parent_thread_id!==call.session_id||spawn?.depth!==1)fail();
 const item=found[0],payload={tool_name:call.tool_name,tool_input:{command:item.command},cwd:session.cwd,project_id:call.project_id,workspace_id:call.workspace_id};
 if(hash(JSON.stringify(payload))!==call.payload_sha256)fail();
 return {version:1,write_call_id:call.id,project_id:call.project_id,workspace_id:call.workspace_id,executor_id:call.executor_id,session_id:call.session_id,turn_id:call.turn_id,tool_use_id:call.tool_use_id,tool_name:call.tool_name,payload_sha256:call.payload_sha256,rewritten_sha256:call.rewritten_sha256,exit_code:item.exit_code,native_event_sha256:hash(item.line),native_thread_id:session.id,parent_thread_id:parent,lineage_sha256:hash(sessionLine)};
}
/** Проверяет root-owned неизменяемые предки и не следует символическим ссылкам. */
export async function assertRootDirectory(directory){
 if(!path.isAbsolute(directory)||path.normalize(directory)!==directory||await realpath(directory)!==directory)fail();
 for(let current=directory;;current=path.dirname(current)){
  const st=await lstat(current);if(!st.isDirectory()||st.isSymbolicLink()||st.uid!==0||(st.mode&0o022))fail();if(current==='/')break;
 }
}
/** Читает ограниченную root-owned receipt, не доверяя присланному digest. */
export async function verifyCompletionReceipt(file){
 await assertRootDirectory(path.dirname(file));const {bytes,stat}=await readExact(file,MAX_RECEIPT);
 if(stat.uid!==0||![0o600,0o440].includes(stat.mode&0o777))fail();let receipt;try{receipt=JSON.parse(bytes);}catch{fail();}
 if(!receipt||Object.keys(receipt).sort().join(',')!==[...keys].sort().join(',')||receipt.version!==1||!Number.isSafeInteger(receipt.exit_code)||!keys.filter(k=>!['version','exit_code','parent_thread_id'].includes(k)).every(k=>typeof receipt[k]==='string'&&receipt[k].length>0&&receipt[k].length<=256)||!(receipt.parent_thread_id===null||typeof receipt.parent_thread_id==='string'&&receipt.parent_thread_id.length>0&&receipt.parent_thread_id.length<=256)||!['payload_sha256','rewritten_sha256','native_event_sha256','lineage_sha256'].every(k=>/^[a-f0-9]{64}$/.test(receipt[k])))fail();
 return {...receipt,receipt_sha256:hash(bytes)};
}
/** Под workspace guard использует штатное завершение write admission, без ручного обновления состояний. */
export async function importNativeCompletion(pool,receiptPath,{allowedRepositories,git=createGit(),verifyReceipt=verifyCompletionReceipt}={}){
 const proof=await verifyReceipt(receiptPath);const db=await pool.connect();let locked=false,lost=false;const onError=()=>{lost=true;};db.on('error',onError);
 try{
  const call=(await db.query('SELECT * FROM codeworks.write_calls WHERE id=$1',[proof.write_call_id])).rows[0];
  if(!call||call.project_id!==proof.project_id||call.workspace_id!==proof.workspace_id||call.executor_id!==proof.executor_id)fail();
  const key='execution:workspace:'+call.workspace_id;locked=!!(await db.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired',[key])).rows[0]?.acquired;if(!locked)throw Error('CLEANUP_BUSY');
  const workspace=async(projectId,id)=>{const p=(await db.query('SELECT config FROM codeworks.projects WHERE id=$1',[projectId])).rows[0]?.config,w=(await db.query('SELECT * FROM codeworks.workspaces WHERE id=$1 AND project_id=$2',[id,projectId])).rows[0];if(!p||!w||!allowedRepositories?.includes(p.repo_path))fail();return {project:p,workspace:w};};
  const session={query:(...args)=>db.query(...args),connect:async()=>({query:(...args)=>db.query(...args),release:()=>{}})};
  const admission=createWriteAdmission(session,{workspace,inspect:async(p,w)=>{const result=await git.inspect(p,w);if(lost)throw Error('EXECUTION_GUARD_LOST');return result;}});
  const args={project_id:proof.project_id,session_id:proof.session_id,turn_id:proof.turn_id,tool_use_id:proof.tool_use_id,outcome:proof.exit_code===0?'success':'error'};
  return await admission.finish(args,proof.executor_id,{completionProof:proof});
 }finally{if(locked&&!lost)await db.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',['execution:workspace:'+proof.workspace_id]).catch(()=>{});db.removeListener('error',onError);db.release(lost?new Error('EXECUTION_GUARD_LOST'):undefined);}
}
