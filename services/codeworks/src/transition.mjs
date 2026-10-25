// ABOUTME: Инвентаризирует прежние операции и атомарно передаёт их единственному Temporal исполнителю.
// ABOUTME: Остановка сервиса, резервная копия и сверка внешних установок принадлежат Ansible вызывающей стороне.
import {createHash} from 'node:crypto';
import {canonical} from './contracts.mjs';
const unfinished=['pending','running','awaiting_execution','awaiting_ci','awaiting_deployment','awaiting_reconciliation'];
/** Read-only снимок сохраняет IDs, базы и этапы; удалённые области учитываются только количеством. */
export async function transitionInventory(db,projectId){
  const workspaces=(await db.query('SELECT id,workspace_key,kind,base_ref,base_sha,branch,path,preparation_state,removed_at FROM codeworks.workspaces WHERE project_id=$1 ORDER BY id',[projectId])).rows;
  const operations=(await db.query('SELECT * FROM codeworks.operations WHERE project_id=$1 AND NOT archived ORDER BY created_at,id',[projectId])).rows;
  const releases=(await db.query('SELECT r.* FROM codeworks.releases r JOIN codeworks.operations o ON o.id=r.operation_id WHERE o.project_id=$1 AND NOT o.archived ORDER BY r.created_at,r.id',[projectId])).rows;
  const deployments=(await db.query('SELECT * FROM codeworks.deployments WHERE project_id=$1 AND NOT archived ORDER BY created_at,operation_id',[projectId])).rows;
  const active=workspaces.filter(w=>!w.removed_at&&['feature','hotfix'].includes(w.kind));
  const snapshot={project_id:projectId,removed:workspaces.filter(w=>w.removed_at).length,workspaces:active,operations:operations.filter(o=>(!o.workspace_id||active.some(w=>w.id===o.workspace_id))&&unfinished.includes(o.status)),releases:releases.filter(r=>active.some(w=>w.id===r.workspace_id)),deployments};
  return {...snapshot,digest:createHash('sha256').update(canonical(snapshot)).digest('hex')};
}
/** Требует проверенную остановку старого исполнителя; повторный apply не меняет владельца или ID. */
export async function importTransition(db,projectId,instanceId,{executorStopped=false,observations={}}={}){
  if(!executorStopped||!/^[a-z][a-z0-9-]{0,63}$/.test(instanceId))throw Error('STOPPED_EXECUTOR_REQUIRED');
  await db.query('BEGIN');
  try{
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[projectId]);
    const control=(await db.query('SELECT * FROM codeworks.execution_control WHERE project_id=$1 FOR UPDATE',[projectId])).rows[0];
    if(control?.owner==='temporal'){
      if(control.instance_id!==instanceId)throw Error('INSTANCE_ID_CHANGED');
      const missing=(await db.query("SELECT 1 FROM codeworks.workspaces w WHERE w.project_id=$1 AND w.removed_at IS NULL AND w.kind IN ('feature','hotfix') AND NOT EXISTS(SELECT 1 FROM codeworks.workflow_registry r WHERE r.workspace_id=w.id AND r.owner='temporal') LIMIT 1",[projectId])).rowCount;
      if(missing)throw Error('INCOMPLETE_TRANSITION');
      await db.query('UPDATE codeworks.execution_control SET mutations_paused=false,updated_at=now() WHERE project_id=$1',[projectId]);
      await db.query('COMMIT');return {already_applied:true,...await transitionInventory(db,projectId)};
    }
    if(!control?.mutations_paused)throw Error('MUTATION_PAUSE_REQUIRED');
    const inventory=await transitionInventory(db,projectId),registry=new Map();
    for(const w of inventory.workspaces){
      const id=`codeworks/${instanceId}/${projectId}/workspace/${w.id}`;
      await db.query("INSERT INTO codeworks.workflow_registry(workflow_id,project_id,workspace_id,owner,last_stage) VALUES($1,$2,$3,'temporal',$4)",[id,projectId,w.id,w.preparation_state]);registry.set(w.id,id);
    }
    for(const op of inventory.operations){
      let id=registry.get(op.workspace_id);
      if(!id){
        if(op.workspace_id)throw Error('LIVE_OPERATION_WITHOUT_WORKSPACE');
        id=`codeworks/${instanceId}/${projectId}/rollout/${op.id}`;
        await db.query("INSERT INTO codeworks.workflow_registry(workflow_id,project_id,operation_id,owner,last_stage) VALUES($1,$2,$3,'temporal',$4)",[id,projectId,op.id,op.step]);
      }
      let uncertain=observations[op.id]==='unknown';
      const r=inventory.releases.find(r=>r.operation_id===op.id);
      if(r)uncertain||=[r.details.primary,r.details.backport].some(l=>l?.deployment_operation_id&&observations[l.deployment_operation_id]==='unknown');
      if(op.kind==='rollout'&&!observations[op.id])throw Error('EXTERNAL_ROLLOUT_NOT_RECONCILED');
      const position=(await db.query('UPDATE codeworks.workflow_registry SET next_sequence=next_sequence+1 WHERE workflow_id=$1 RETURNING next_sequence',[id])).rows[0].next_sequence;
      await db.query("INSERT INTO codeworks.commands(operation_id,workflow_id,sequence,generation,kind,admitted_request,requested_sha,state) VALUES($1,$2,$3,1,$4,$5,$6,$7)",[op.id,id,position,op.kind,op.request,op.request.commit_sha??null,uncertain?'reconciliation':'pending']);
      if(uncertain){
        await db.query("UPDATE codeworks.operations SET status='awaiting_reconciliation',step='IMPORTED_UNKNOWN_OUTCOME',updated_at=now() WHERE id=$1",[op.id]);
        await db.query("UPDATE codeworks.workflow_registry SET blocked_reason='IMPORTED_UNKNOWN_OUTCOME' WHERE workflow_id=$1",[id]);
      }
    }
    const hold=async(id,target)=>{
      const other=(await db.query("SELECT operation_id FROM codeworks.release_queue WHERE project_id=$1 AND target=$2 AND state='held' AND operation_id<>$3",[projectId,target,id])).rowCount;
      if(other)throw Error('LEGACY_TARGET_HAS_MULTIPLE_EXECUTORS');
      await db.query("INSERT INTO codeworks.release_queue(project_id,target,operation_id,state) VALUES($1,$2,$3,'held') ON CONFLICT(operation_id,target) DO NOTHING",[projectId,target,id]);
    };
    for(const r of inventory.releases){
      if(r.closed_at||r.state==='succeeded')continue;
      for(const leg of [r.details.primary,r.details.backport].filter(Boolean)){
        if(leg===r.details.backport&&r.details.primary&&!r.details.primary.deployment_evidence_id){
          if(leg.merge_push_attempted||leg.deployment_operation_id)throw Error('LEGACY_HOTFIX_REQUIRES_RECONCILIATION');
          continue;
        }
        if(leg.deployment_operation_id)await db.query('UPDATE codeworks.deployments SET release_operation_id=$2 WHERE operation_id=$1 AND release_operation_id IS NULL',[leg.deployment_operation_id,r.operation_id]);
        if(!leg.deployment_evidence_id&&(leg.merge_push_attempted||unfinished.includes(r.state)))await hold(r.operation_id,leg.target==='main'?'prod':'dev');
      }
    }
    for(const d of inventory.deployments){
      const release=inventory.releases.some(r=>[r.details.primary,r.details.backport].some(l=>l?.deployment_operation_id===d.operation_id));
      if(!release&&inventory.operations.some(o=>o.id===d.operation_id))await hold(d.operation_id,d.target);
    }
    await db.query("UPDATE codeworks.execution_control SET owner='temporal',instance_id=$2,mutations_paused=false,updated_at=now() WHERE project_id=$1",[projectId,instanceId]);
    await db.query('COMMIT');return {already_applied:false,...await transitionInventory(db,projectId)};
  }catch(error){await db.query('ROLLBACK');throw error;}
}
/** Возобновляет прежнее поручение только после внешней owner-сверки; ID, запрос, SHA и proof не меняет. */
export async function resumeReconciledCommand(db,operationId,{confirmed=false}={}){
  if(!confirmed)throw Error('CONFIRMED_RECONCILIATION_REQUIRED');
  const project=(await db.query('SELECT project_id FROM codeworks.operations WHERE id=$1',[operationId])).rows[0]?.project_id;
  if(!project)throw Error('RECONCILABLE_COMMAND_REQUIRED');
  await db.query('BEGIN');
  try{
    await db.query("SET LOCAL lock_timeout='2s'");await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[project]);
    const row=(await db.query("SELECT c.workflow_id,c.state,o.status,o.archived,r.owner,r.state AS workflow_state FROM codeworks.commands c JOIN codeworks.operations o ON o.id=c.operation_id JOIN codeworks.workflow_registry r USING(workflow_id) WHERE c.operation_id=$1 FOR UPDATE OF c,o,r",[operationId])).rows[0];
    if(!row||row.archived||row.owner!=='temporal'||row.workflow_state==='completed'||['succeeded','failed'].includes(row.status))throw Error('RECONCILABLE_COMMAND_REQUIRED');
    if(row.state==='reconciliation'){
      await db.query("UPDATE codeworks.operations SET status='awaiting_execution',step='RECONCILIATION_CONFIRMED',error=NULL,updated_at=now() WHERE id=$1",[operationId]);
      await db.query("UPDATE codeworks.commands SET state='pending',delivered_at=NULL,updated_at=now() WHERE operation_id=$1",[operationId]);
      await db.query("UPDATE codeworks.workflow_registry SET blocked_reason=NULL,executor_state='waiting',updated_at=now() WHERE workflow_id=$1",[row.workflow_id]);
    }
    await db.query('COMMIT');return {operation_id:operationId,workflow_id:row.workflow_id};
  }catch(error){await db.query('ROLLBACK');throw error;}
}
