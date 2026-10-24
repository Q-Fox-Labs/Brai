// ABOUTME: Проверяет допуск сохранённых команд, владение workflow и постоянную очередь выпусков.
// ABOUTME: Никакие параметры сигнала Temporal не разрешают внешнее действие без записи PostgreSQL.
import {Fault} from './errors.mjs';
const active=['pending','running','awaiting_execution','awaiting_ci','awaiting_deployment','awaiting_reconciliation'];
/** Проверяет ID фактического workflow, поколение и неизменность поручения перед каждым проходом Activity. */
export async function authorizeCommand(db,operationId,workflowId,generation) {
  const row=(await db.query(`SELECT c.*,r.owner,r.state AS workflow_state,r.lifecycle,o.kind AS operation_kind,o.request,o.archived,o.step
    FROM codeworks.commands c JOIN codeworks.workflow_registry r USING(workflow_id) JOIN codeworks.operations o ON o.id=c.operation_id
    WHERE c.operation_id=$1 AND c.workflow_id=$2 AND c.generation=$3 AND r.generation=c.generation`,[operationId,workflowId,generation])).rows[0];
  if(!row||row.owner!=='temporal'||row.workflow_state==='completed'||row.archived||row.kind!==row.operation_kind||JSON.stringify(sort(row.request))!==JSON.stringify(sort(row.admitted_request))||row.requested_sha!==(row.request.commit_sha??null))throw new Fault('FORBIDDEN','Activity requires an admitted command owned by this workflow.');
  if(!['prepare','sync','release','cleanup','rollout','release.close','workspace.cancel'].includes(row.kind))throw new Fault('FORBIDDEN');
  return row;
}
function sort(value){return Array.isArray(value)?value.map(sort):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,sort(value[k])])):value;}
/** FIFO acquisition не удерживает транзакцию, соединение или файловый lock при ожидании. */
export async function acquireTarget(db,projectId,target,operationId,retryOf=null) {
  await db.query('BEGIN');
  try {
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['lane:'+projectId+':'+target]);
    await db.query('INSERT INTO codeworks.release_queue(project_id,target,operation_id) VALUES($1,$2,$3) ON CONFLICT(operation_id,target) DO NOTHING',[projectId,target,operationId]);
    const holder=(await db.query("SELECT * FROM codeworks.release_queue WHERE project_id=$1 AND target=$2 AND state='held'",[projectId,target])).rows[0];
    if(holder?.operation_id===operationId){await db.query('COMMIT');return true;}
    if(holder&&holder.operation_id!==retryOf){await db.query('COMMIT');return false;}
    if(holder){
      const prior=(await db.query("SELECT r.requested_sha,o.status,n.requested_sha AS next_sha FROM codeworks.releases r JOIN codeworks.operations o ON o.id=r.operation_id JOIN codeworks.releases n ON n.operation_id=$2 AND n.retry_of=r.operation_id WHERE r.operation_id=$1 AND r.closed_at IS NULL",[retryOf,operationId])).rows[0];
      const rollout=prior?null:(await db.query("SELECT o.status,p.commit_sha AS requested_sha,n.commit_sha AS next_sha FROM codeworks.deployments p JOIN codeworks.operations o ON o.id=p.operation_id JOIN codeworks.deployments n ON n.retry_of=p.operation_id AND n.operation_id=$2 AND n.composition_digest=p.composition_digest AND n.project_id=p.project_id AND n.target=p.target WHERE p.operation_id=$1",[retryOf,operationId])).rows[0];
      const previous=prior??rollout;
      if(!previous||previous.status!=='failed'||previous.requested_sha!==previous.next_sha){await db.query('COMMIT');return false;}
      await db.query("UPDATE codeworks.release_queue SET state='released',updated_at=now() WHERE ticket=$1",[holder.ticket]);
    }else{
      const first=(await db.query("SELECT operation_id FROM codeworks.release_queue WHERE project_id=$1 AND target=$2 AND state='queued' ORDER BY ticket LIMIT 1",[projectId,target])).rows[0];
      if(first?.operation_id!==operationId){await db.query('COMMIT');return false;}
    }
    await db.query("UPDATE codeworks.release_queue SET state='held',updated_at=now() WHERE operation_id=$1 AND target=$2 AND state='queued'",[operationId,target]);
    await db.query('COMMIT');return true;
  }catch(error){await db.query('ROLLBACK');throw error;}
}
/** Освобождает только собственный контур после подтверждённой установки или безопасного закрытия. */
export async function releaseTarget(db,operationId,target,state='released') {
  if(!['released','closed'].includes(state))throw Error('INVALID_LANE_STATE');
  await db.query("UPDATE codeworks.release_queue SET state=$3,updated_at=now() WHERE operation_id=$1 AND target=$2 AND state IN ('held','queued')",[operationId,target,state]);
}
/** Закрывает попытку только после сверки возможных Git и Ansible эффектов; задача остаётся активной. */
export async function closeRelease(db,op,project,workspace,{flowGit,github,reconcileDeployment}) {
  const r=(await db.query('SELECT * FROM codeworks.releases WHERE operation_id=$1 AND workspace_id=$2',[op.request.release_operation_id,workspace.id])).rows[0];
  if(!r)throw new Fault('NOT_FOUND');
  if(r.closed_at)return {status:'succeeded',reason:'RELEASE_ALREADY_CLOSED'};
  if(r.state==='succeeded')throw new Fault('CONFLICT','A successful release cannot be closed.');
  // AIDEV-NOTE: Проектный flock исключает параллельный проход; external Ansible живёт независимо от него.
  for(const leg of [r.details.primary,r.details.backport].filter(Boolean)){
    if(leg.pr_attempted&&!leg.pr_number){
      const pr=await github.find(project,leg);
      if(!pr)return {status:'awaiting_reconciliation',reason:'PR_CREATE_UNCERTAIN'};
      leg.pr_number=pr.number;
    }
    if(leg.merge_push_attempted&&!leg.merged){
      if(!await flowGit.verifyMerge(project,leg)){
        if(await flowGit.remote(project,leg.target)!==leg.target_sha)return {status:'awaiting_reconciliation',reason:'MERGE_PUSH_UNCERTAIN'};
        continue;
      }
      const pr=await github.get(project,leg.pr_number);
      if(!pr?.merged||pr.merge_commit_sha!==leg.merge_sha)return {status:'awaiting_reconciliation',reason:'GITHUB_MERGE_NOT_CONFIRMED'};
      leg.merged=true;
    }
    if(leg.deployment_operation_id){
      await reconcileDeployment(leg.deployment_operation_id);
      const d=(await db.query('SELECT o.status,d.receipt FROM codeworks.operations o JOIN codeworks.deployments d ON d.operation_id=o.id WHERE o.id=$1',[leg.deployment_operation_id])).rows[0];
      if(!d||active.includes(d.status)||!['failed','succeeded'].includes(d.status))return {status:'awaiting_reconciliation',reason:'ROLLOUT_NOT_TERMINAL'};
      if(d.status==='succeeded'&&d.receipt?.verified!==true)return {status:'awaiting_reconciliation',reason:'RECEIPT_REQUIRED'};
      if(d.status==='failed'&&d.receipt?.status!=='failed')return {status:'awaiting_reconciliation',reason:'ROLLOUT_RESULT_UNKNOWN'};
    }
  }
  await db.query('BEGIN');
  try{
    await db.query("UPDATE codeworks.releases SET closed_at=COALESCE(closed_at,now()),close_reason=$2,state='failed',details=$3 WHERE operation_id=$1",[r.operation_id,op.request.reason,r.details]);
    await db.query("UPDATE codeworks.operations SET status='failed',step='closed',updated_at=now() WHERE id=$1 AND status<>'succeeded'",[r.operation_id]);
    await db.query("UPDATE codeworks.commands SET state='done',updated_at=now() WHERE operation_id=$1",[r.operation_id]);
    await db.query("UPDATE codeworks.release_queue SET state='closed',updated_at=now() WHERE operation_id=$1 AND state IN ('held','queued')",[r.operation_id]);
    await db.query('COMMIT');
  }catch(error){await db.query('ROLLBACK');throw error;}
  return {status:'succeeded',reason:'RELEASE_CLOSED'};
}
/** Отмена сохраняет дерево и ветку; незавершённые/неопределённые выпуски сначала закрывают. */
export async function cancelWorkspace(db,op) {
  const unresolved=(await db.query(`SELECT 1 FROM codeworks.operations o WHERE workspace_id=$1 AND id<>$2 AND NOT archived AND
    (status NOT IN ('failed','succeeded') OR (kind='release' AND EXISTS(SELECT 1 FROM codeworks.release_queue q WHERE q.operation_id=o.id AND q.state IN ('queued','held')))) LIMIT 1`,[op.workspace_id,op.id])).rowCount;
  if(unresolved)throw new Fault('CONFLICT','Resolve or close unfinished releases and uncertain actions before cancellation.');
  await db.query("UPDATE codeworks.workflow_registry SET lifecycle='cancelled',state='draining',updated_at=now() WHERE workspace_id=$1 AND state='open'",[op.workspace_id]);
  return {status:'succeeded',reason:'TASK_CANCELLED_RESOURCES_PRESERVED'};
}
