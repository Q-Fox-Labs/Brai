// ABOUTME: Завершает очистку исторических Git-ссылок без рабочей области.
// ABOUTME: Не создаёт путь или индекс и не удаляет ссылки без проверенного решения.
import {canonical} from './contracts.mjs';
import {verifyCleanupArchive} from './cleanup-archive.mjs';

/** Выполняет один шаг закреплённой очистки под внешним guard субъекта. */
export async function advanceBranchCleanup(db,obligation,project,{git,checkpoint=async()=>{},verifyArchive=verifyCleanupArchive}) {
  const manifest=obligation.evidence?.manifest,ref=obligation.subject_key?.slice(7);
  if(obligation.workspace_id||manifest?.subject_type!=='branch'||obligation.subject_key!=='branch:'+ref||!/^refs\/heads\/.+/.test(ref)||['refs/heads/dev','refs/heads/main'].includes(ref)||manifest.branch?.ref!==ref)throw Error('BRANCH_SUBJECT_INVALID');
  const id=obligation.id,owner=obligation.owner_workflow_id,epoch=Number(obligation.epoch),subject={ref};
  const fence=async()=>{
    await checkpoint('branch-cleanup-fence');
    if(!(await db.query("SELECT 1 FROM codeworks.cleanup_obligations WHERE id=$1 AND epoch=$2 AND owner_workflow_id=$3 AND state IN ('pending','running','retry')",[id,epoch,owner])).rowCount)throw Error('CLEANUP_FENCE_LOST');
    const active=await db.query(`SELECT 1 FROM codeworks.workspaces w LEFT JOIN codeworks.workflow_registry r ON r.workspace_id=w.id
      WHERE w.project_id=$1 AND w.branch=$2 AND (w.removed_at IS NULL OR r.lifecycle='active' OR EXISTS(
        SELECT 1 FROM codeworks.operations o WHERE o.workspace_id=w.id AND NOT o.archived AND o.status IN ('pending','running','awaiting_execution','awaiting_ci','awaiting_deployment','awaiting_reconciliation'))) LIMIT 1`,[project.id,ref.slice(11)]);
    if(active.rowCount)throw Error('BRANCH_LIVE_TASK');
  };
  const save=async(fields,values)=>{
    await fence();
    const result=await db.query(`UPDATE codeworks.cleanup_obligations SET ${fields},updated_at=now() WHERE id=$1 AND epoch=$2 AND owner_workflow_id=$3 AND state IN ('pending','running','retry') RETURNING *`,[id,epoch,owner,...values]);
    if(!result.rowCount)throw Error('CLEANUP_FENCE_LOST');return result.rows[0];
  };
  const wait=reason=>save("state='waiting_decision',blocker=$4",[reason]);
  const expected=obligation.expected;
  if(!expected?.branch||expected.branch.ref!==ref||expected.remote?.ref!==ref)return wait('BRANCH_SNAPSHOT_REQUIRED');
  await fence();
  const current=await git.inspectBranchResources(project,subject);
  if(current.remote?.known!==true||current.index?.scope!=='not_allocated_by_codeworks'||current.worktree?.registered!==false||current.worktree?.path!==null||current.ownership?.oid!==null)return wait('BRANCH_INSPECTION_INCOMPLETE');
  if(!current.branch?.oid&&!current.remote?.oid&&!current.tracking?.oid){
    return save("state='done',step='done',blocker=NULL,result=$4::jsonb",[JSON.stringify({scope:'git_refs',git:current,index:{scope:'not_allocated_by_codeworks'},...(obligation.step==='verify'?{disposition:'resources_removed_with_archive'}:{})})]);
  }
  if(obligation.step==='verify')return wait('RESOURCES_REMAIN');
  const archive=obligation.evidence?.archive;
  if(archive){
    if(manifest.reviewed!==true||manifest.disposition?.type!=='archived'||obligation.evidence?.archive_authorized!==true||canonical(archive)!==canonical(manifest.disposition.archive))return wait('ARCHIVE_UNVERIFIED');
    try{await fence();await verifyArchive(project,expected,archive,{manifest});await fence();}catch(error){if(error.message==='CLEANUP_FENCE_LOST'||error.message==='BRANCH_LIVE_TASK')throw error;return wait('ARCHIVE_UNVERIFIED');}
  }else return wait('DISPOSITION_PROOF_REQUIRED');
  const step=obligation.step==='local_refs'?'local_refs':'remote';
  await fence();await git.cleanupBranchStep(project,subject,expected,step);
  return save("step=$4,state='pending',blocker=NULL,next_attempt_at=NULL",[step==='remote'?'local_refs':'verify']);
}
