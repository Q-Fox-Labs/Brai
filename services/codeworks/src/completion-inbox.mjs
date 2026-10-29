// ABOUTME: Сохраняет метаданные Post до сверки дерева и повторяет доставку из локального журнала.
// ABOUTME: Использует прежний допуск и guard; не выводит завершение из таймера или выпуска.
import {createHash} from 'node:crypto';
import {canonical,validate} from './contracts.mjs';
import {Fault} from './errors.mjs';
import {createWriteAdmission} from './write-admission.mjs';
import {createGit} from './git.mjs';
import {scanNotices,ackNotice} from './write-notice.mjs';

const digest=value=>createHash('sha256').update(canonical(value)).digest('hex');

/** Проверяет исходный допуск, включая точный инструмент и хэш перенаправленного входа. */
export function validatePostCompletion(call,notice,executorId) {
  const same=['project_id','session_id','turn_id','tool_use_id','tool_name'].every(key=>call?.[key]===notice[key]);
  const notStarted=notice.execution_status==='not_started'&&notice.outcome==='error';
  const rewrittenMatches=call?.completion_input_sha256
    ? call.completion_input_sha256===notice.canonical_input_sha256
    : call?.rewritten_sha256===notice.input_sha256;
  const inputMatches=rewrittenMatches||(notStarted&&!!call?.original_input_sha256&&call.original_input_sha256===notice.canonical_input_sha256);
  const states=notStarted?['preparing','denied_pending','in_flight','uncertain','finished']:['in_flight','uncertain','finished'];
  if(!same||call.executor_id!==executorId||(!notStarted&&!call.admitted_at)||!inputMatches||!states.includes(call.state)||(notice.execution_status==='not_started'&&!notStarted))throw new Fault('WRITE_CALL_MISMATCH');
  if(call.state==='finished'&&call.tool_result?.outcome!==notice.outcome)throw new Fault('WRITE_CALL_MISMATCH');
}

/** Commit подтверждения не зависит от доступности Git и не снимает учёт писателя. */
export function createCompletionInbox(pool) {
  async function receive(args,executorId) {
    validate('write.finish',args);
    const db=await pool.connect();
    try {
      await db.query('BEGIN');
      const identity=[args.project_id,executorId,args.session_id,args.turn_id,args.tool_use_id];
      // AIDEV-NOTE: Fence и begin сериализованы до создания строки: поздний запрос не возродит вызов.
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['write-session:'+JSON.stringify(identity.slice(0,3))]);
      const notification={...args,execution_status:args.execution_status??'completed',executor_id:executorId},receipt=digest(notification);
      const initial=(await db.query('SELECT * FROM codeworks.write_calls WHERE project_id=$1 AND executor_id=$2 AND session_id=$3 AND turn_id=$4 AND tool_use_id=$5',identity)).rows[0];
      if(!initial){
        if(notification.execution_status!=='not_started'||notification.outcome!=='error')throw new Fault('NOT_FOUND');
        await db.query(`INSERT INTO codeworks.write_call_fences(project_id,executor_id,session_id,turn_id,tool_use_id,tool_name,original_input_sha256,receipt_sha256)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,[...identity,args.tool_name,args.canonical_input_sha256,receipt]);
        const fence=(await db.query('SELECT * FROM codeworks.write_call_fences WHERE project_id=$1 AND executor_id=$2 AND session_id=$3 AND turn_id=$4 AND tool_use_id=$5',identity)).rows[0];
        if(fence?.receipt_sha256!==receipt||fence.tool_name!==args.tool_name||fence.original_input_sha256!==args.canonical_input_sha256)throw new Fault('WRITE_CALL_MISMATCH');
        await db.query('COMMIT');return {write_call_id:null,state:'not_started',receipt_sha256:receipt};
      }
      // AIDEV-NOTE: Сохраняем общий порядок блокировок admission/cleanup перед строкой вызова.
      await db.query('SELECT id FROM codeworks.workspaces WHERE id=$1 FOR UPDATE',[initial.workspace_id]);
      await db.query('SELECT workflow_id FROM codeworks.workflow_registry WHERE workspace_id=$1 FOR UPDATE',[initial.workspace_id]);
      const call=(await db.query('SELECT * FROM codeworks.write_calls WHERE id=$1 FOR UPDATE',[initial.id])).rows[0];
      validatePostCompletion(call,notification,executorId);
      const old=(await db.query('SELECT * FROM codeworks.write_completions WHERE write_call_id=$1 FOR UPDATE',[call.id])).rows[0];
      if(old&&(old.receipt_sha256!==receipt||canonical(old.notification)!==canonical(notification)))throw new Fault('WRITE_CALL_MISMATCH');
      if(!old)await db.query('INSERT INTO codeworks.write_completions(write_call_id,receipt_sha256,notification) VALUES($1,$2,$3::jsonb)',[call.id,receipt,JSON.stringify(notification)]);
      await db.query('COMMIT');
      return {write_call_id:call.id,state:old?.state==='done'?'finished':'pending',...(old?.state==='done'?{changed:!!call.tool_result?.changed}:{})};
    } catch(error) {await db.query('ROLLBACK').catch(()=>{});throw error;}
    finally {db.release();}
  }
  return {receive};
}

async function processOne(pool,item,{allowedRepositories,git}) {
  const db=await pool.connect();let locked=false,lost=false;
  const onError=()=>{lost=true;};db.on('error',onError);
  const key=item.workspace_id?'execution:workspace:'+item.workspace_id:'execution:write-call:'+item.write_call_id;
  try {
    locked=!!(await db.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired',[key])).rows[0]?.acquired;
    if(!locked)return false;
    const current=(await db.query("SELECT * FROM codeworks.write_completions WHERE write_call_id=$1 AND state='pending' AND (next_attempt_at IS NULL OR next_attempt_at<=now())",[item.write_call_id])).rows[0];
    if(!current)return false;
    const {executor_id:executorId,...notice}=current.notification;
    if(digest(current.notification)!==current.receipt_sha256)throw new Fault('WRITE_CALL_MISMATCH');
    const workspace=async(projectId,id)=>{
      const project=(await db.query('SELECT config FROM codeworks.projects WHERE id=$1',[projectId])).rows[0]?.config;
      const workspace=(await db.query('SELECT * FROM codeworks.workspaces WHERE id=$1 AND project_id=$2',[id,projectId])).rows[0];
      if(!project||!workspace||!allowedRepositories.includes(project.repo_path)||!project.executors.includes(executorId))throw new Fault('FORBIDDEN');
      return {project,workspace};
    };
    const session={query:(...args)=>db.query(...args),connect:async()=>({query:(...args)=>db.query(...args),release(){}})};
    const admission=createWriteAdmission(session,{workspace,inspect:async(project,w)=>{
      const result=await git.inspect(project,w);
      if(lost)throw Error('EXECUTION_GUARD_LOST');return result;
    }});
    await admission.finish(notice,executorId,{postProof:{...notice,executor_id:executorId,receipt_sha256:current.receipt_sha256},expectedWorkspaceId:item.workspace_id});
    if(lost)throw Error('EXECUTION_GUARD_LOST');
    await db.query("UPDATE codeworks.write_completions SET state='done',error=NULL,next_attempt_at=NULL,finished_at=now(),updated_at=now() WHERE write_call_id=$1 AND receipt_sha256=$2 AND state='pending'",[item.write_call_id,current.receipt_sha256]);
    return true;
  } finally {
    if(locked&&!lost)await db.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[key]).catch(()=>{});
    db.removeListener('error',onError);db.release(lost?new Error('EXECUTION_GUARD_LOST'):undefined);
  }
}

/** Ограниченный раунд существующего Temporal reconciler; не требует нового события от клиента. */
export async function processProjectCompletions(pool,projectId,{allowedRepositories,git=createGit(),spoolDirectory,list=scanNotices,ack=ackNotice}={}) {
  let imported=0,processed=0,deliveryErrors=0;
  const inbox=createCompletionInbox(pool);
  if(spoolDirectory) {
    const project=(await pool.query('SELECT config FROM codeworks.projects WHERE id=$1',[projectId])).rows[0]?.config;
    if(!project||!allowedRepositories?.includes(project.repo_path))throw new Fault('FORBIDDEN');
    const cursor=(await pool.query('SELECT completion_spool_cursor FROM codeworks.execution_control WHERE project_id=$1',[projectId])).rows[0]?.completion_spool_cursor??null;
    let scanned;
    try {scanned=await list(spoolDirectory,{projectId,cursor,limit:32});}
    catch {deliveryErrors++;scanned=[];}
    const batch=scanned.filter(entry=>entry.notice?.request.project_id===projectId);
    deliveryErrors+=scanned.filter(entry=>entry.error).length;
    for(const entry of batch) {
      try {
        if(!project.executors.includes(entry.notice.executor_id))throw new Fault('FORBIDDEN');
        await inbox.receive(entry.notice.request,entry.notice.executor_id);
        await ack(spoolDirectory,entry.id,entry.notice);imported++;
      } catch {deliveryErrors++;}
      // AIDEV-NOTE: Ошибочная запись не блокирует остальные и остаётся в журнале до решения.
      await pool.query('UPDATE codeworks.execution_control SET completion_spool_cursor=$2 WHERE project_id=$1',[projectId,entry.id]);
    }
  }
  const entries=(await pool.query(`SELECT c.write_call_id,w.workspace_id FROM codeworks.write_completions c
    JOIN codeworks.write_calls w ON w.id=c.write_call_id WHERE w.project_id=$1 AND c.state='pending'
    AND (c.next_attempt_at IS NULL OR c.next_attempt_at<=now()) ORDER BY c.updated_at,c.created_at,c.write_call_id LIMIT 32`,[projectId])).rows;
  for(const entry of entries) {
    try {
      if(await processOne(pool,entry,{allowedRepositories,git}))processed++;
      else await pool.query("UPDATE codeworks.write_completions SET next_attempt_at=now()+interval '30 seconds',updated_at=now() WHERE write_call_id=$1 AND state='pending'",[entry.write_call_id]);
    }
    catch(error) {
      const conflict=['WRITE_CALL_MISMATCH','FORBIDDEN','CONFLICT','NOT_FOUND'].includes(error?.code);
      await pool.query(`UPDATE codeworks.write_completions SET state=$2,attempts=attempts+1,error=$3,
        next_attempt_at=CASE WHEN $2='pending' THEN now()+interval '30 seconds' ELSE NULL END,updated_at=now()
        WHERE write_call_id=$1 AND state='pending'`,[entry.write_call_id,conflict?'waiting_decision':'pending',conflict?error.code:'TECHNICAL_RETRY']);
    }
  }
  const pending=(await pool.query("SELECT 1 FROM codeworks.write_completions c JOIN codeworks.write_calls w ON w.id=c.write_call_id WHERE w.project_id=$1 AND c.state='pending' AND (c.next_attempt_at IS NULL OR c.next_attempt_at<=now()) LIMIT 1",[projectId])).rowCount>0;
  if(deliveryErrors)console.error('Codeworks POST_DELIVERY_REQUIRES_RECONCILIATION',JSON.stringify({project_id:projectId,count:deliveryErrors}));
  return {imported,processed,pending,deliveryErrors};
}
