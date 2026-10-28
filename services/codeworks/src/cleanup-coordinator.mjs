// ABOUTME: Продвигает подтверждённую очистку принадлежащей задачи по сохранённым шагам.
// ABOUTME: Не принимает внешних поручений и не удаляет ресурсы без проверки владельца.
import {gitResourcesAbsent,command} from './git.mjs';
import {verifyDisposition} from './disposition.mjs';

const steps=['remote','worktree','local_refs','index','verify'];
const indexAbsent=value=>value?.complete===true && value.owner?.present===false && Array.isArray(value.resources?.collections) && !value.resources.collections.length && Array.isArray(value.resources?.metadataPoints) && !value.resources.metadataPoints.length;

/** Выполняет один идемпотентный шаг под внешним execution guard и проверкой эпохи. */
export async function advanceCleanup(db,obligation,project,workspace,{git,flowGit,codeIndex,allowedRepositories=[],checkpoint=async()=>{}}) {
  const id=obligation.id,epoch=Number(obligation.epoch),owner=obligation.owner_workflow_id;
  const fence=async()=>{
    await checkpoint('cleanup-fence');
    const result=await db.query("SELECT 1 FROM codeworks.cleanup_obligations WHERE id=$1 AND epoch=$2 AND owner_workflow_id=$3 AND state IN ('pending','running','retry')",[id,epoch,owner]);
    if(!result.rowCount)throw Error('CLEANUP_FENCE_LOST');
  };
  const save=async(fields,values)=>{
    await fence();
    const row=await db.query(`UPDATE codeworks.cleanup_obligations SET ${fields},updated_at=now() WHERE id=$1 AND epoch=$2 AND owner_workflow_id=$3 RETURNING *`,[id,epoch,owner,...values]);
    if(!row.rowCount)throw Error('CLEANUP_FENCE_LOST');
    return row.rows[0];
  };
  const wait=async reason=>save("state='waiting_decision',blocker=$4",[reason]);
  const manifest=obligation.evidence?.manifest;
  const releaseProof=async()=>{
    const release=(await db.query("SELECT * FROM codeworks.releases WHERE workspace_id=$1 AND state='succeeded' ORDER BY created_at DESC LIMIT 1",[workspace.id])).rows[0];
    const legs=workspace.kind==='hotfix'?[release?.details?.primary,release?.details?.backport]:[release?.details?.primary];
    if(!release||legs.some(leg=>!leg?.merged||!leg.deployment_evidence_id||!leg.merge_sha))return null;
    for(const leg of legs){
      const target=leg.target==='main'?'prod':'dev';
      if(!(await db.query('SELECT 1 FROM codeworks.deployment_evidence WHERE id=$1 AND project_id=$2 AND target=$3 AND commit_sha=$4',[leg.deployment_evidence_id,workspace.project_id,target,leg.merge_sha])).rowCount)return null;
    }
    return release;
  };
  if(!workspace)return wait('WORKSPACE_REQUIRED');
  if(manifest?.protected_task_ids?.includes(workspace.id))return wait('LIVE_TASK_PROTECTED');
  if(manifest&&(await db.query("SELECT 1 FROM codeworks.workspaces w JOIN codeworks.workflow_registry r ON r.workspace_id=w.id WHERE w.project_id=$1 AND (w.id=$2 OR w.path=$3 OR w.branch=$4) AND r.lifecycle='active' LIMIT 1",[project.id,workspace.id,workspace.path,workspace.branch])).rowCount)return wait('LIVE_TASK_PROTECTED');
  if((await db.query("SELECT 1 FROM codeworks.write_calls WHERE workspace_id=$1 AND state IN ('preparing','in_flight','uncertain') LIMIT 1",[workspace.id])).rowCount)return wait('WRITER_OUTCOME_UNKNOWN');
  if((await db.query("SELECT 1 FROM codeworks.release_queue q JOIN codeworks.operations o ON o.id=q.operation_id WHERE o.workspace_id=$1 AND q.state IN ('held','queued') LIMIT 1",[workspace.id])).rowCount)return wait('RELEASE_OUTCOME_UNKNOWN');
  let expected=obligation.expected;
  if(!expected || !expected.branch){
    await fence();
    const observed=await git.inspectResources(project,workspace,{manifest});
    if(!codeIndex)return wait('INDEX_ADAPTER_REQUIRED');
    await fence();
    const indexObserved=await codeIndex.inspect(project,workspace,{manifest});
    if(indexObserved?.complete!==true)throw Error('INDEX_INSPECTION_INCOMPLETE');
    const head=observed.worktree.head??observed.branch.oid;
    if(observed.worktree.dirty!==false && observed.worktree.pathExists)return wait('DIRTY_WORKTREE');
    if(['unused','cancelled'].includes(obligation.outcome)){
      if((head && head!==workspace.base_sha)||(observed.branch.oid && observed.branch.oid!==workspace.base_sha)||(observed.remote.oid && observed.remote.oid!==workspace.base_sha))return wait('UNIQUE_CHANGES');
    }else if(obligation.outcome==='released'&&!obligation.evidence?.verified_disposition){
      const release=await releaseProof();
      if(!release || (head&&head!==release.requested_sha) || (observed.branch.oid&&observed.branch.oid!==release.requested_sha) || (observed.remote.oid&&observed.remote.oid!==release.requested_sha))return wait('RELEASE_PROOF_MISMATCH');
    }else if(obligation.outcome!=='transferred'&&!obligation.evidence?.verified_disposition)return wait('DISPOSITION_PROOF_REQUIRED');
    expected=observed;
    obligation=await save("expected=$4::jsonb,evidence=$5::jsonb,step='remote',state='pending',blocker=NULL,next_attempt_at=NULL",[JSON.stringify(expected),JSON.stringify({...obligation.evidence,index_observation:indexObserved})]);
  }
  // AIDEV-NOTE: Сохранённый снимок сам по себе не является разрешением уничтожить уникальные изменения.
  const fixedHead=expected.worktree?.head??expected.branch?.oid;
  if(expected.worktree?.pathExists&&expected.worktree?.dirty!==false)return wait('DIRTY_WORKTREE');
  const retained=obligation.evidence?.verified_disposition;
  if(retained?.type==='retained'&&manifest){
    if(retained.target!=='dev'||!flowGit||!retained.target_sha||!retained.refs)return wait('DISPOSITION_PROOF_REQUIRED');
    const actual=[expected.branch?.oid,expected.remote?.oid,expected.worktree?.head];
    if(JSON.stringify(actual)!==JSON.stringify([retained.refs.branch,retained.refs.remote,retained.refs.worktree]))return wait('DISPOSITION_PROOF_REQUIRED');
    await fence();
    if(await flowGit.remote(project,'dev')!==retained.target_sha)return wait('TARGET_CHANGED');
    for(const sha of actual.filter(Boolean)){
      const result=await command('git',['-C',project.repo_path,'merge-base','--is-ancestor',sha,retained.target_sha],{allowFailure:true});
      if(result.code!==0)return wait('DISPOSITION_PROOF_REQUIRED');
    }
  }else if(['unused','cancelled'].includes(obligation.outcome)){
    if((fixedHead&&fixedHead!==workspace.base_sha)||(expected.branch?.oid&&expected.branch.oid!==workspace.base_sha)||(expected.remote?.oid&&expected.remote.oid!==workspace.base_sha))return wait('UNIQUE_CHANGES');
  }else if(obligation.outcome==='released'){
    const release=await releaseProof();
    if(!release||(fixedHead&&fixedHead!==release.requested_sha)||(expected.branch?.oid&&expected.branch.oid!==release.requested_sha)||(expected.remote?.oid&&expected.remote.oid!==release.requested_sha))return wait('RELEASE_PROOF_MISMATCH');
  }else if(obligation.outcome==='transferred'){
    const transfer=obligation.evidence?.transfer;
    if(!transfer||fixedHead!==transfer.source_head||(expected.remote?.oid&&expected.remote.oid!==transfer.source_head))return wait('DISPOSITION_PROOF_REQUIRED');
    if(['inspect','remote','worktree'].includes(obligation.step)){
      try{await fence();await verifyDisposition(project,workspace,transfer,{allowedRepositories});}
      catch(error){if(error.code==='TRANSFER_UNVERIFIED')return wait('TRANSFER_UNVERIFIED');throw error;}
    }
  }else return wait('DISPOSITION_PROOF_REQUIRED');
  const step=steps.includes(obligation.step)?obligation.step:'remote';
  await fence();
  if(['remote','worktree','local_refs'].includes(step)){
    await git.cleanupStep(project,workspace,expected,step,{manifest});
  }else if(step==='index'){
    if(!codeIndex)return wait('INDEX_ADAPTER_REQUIRED');
    const evidence=obligation.evidence??{};
    await codeIndex.remove(project,workspace,{manifest,checkpointState:evidence.index_checkpoint,checkpoint:async state=>{
      evidence.index_checkpoint=state;
      await save('evidence=$4::jsonb',[JSON.stringify(evidence)]);
    }});
  }else{
    if(!codeIndex)return wait('INDEX_ADAPTER_REQUIRED');
    const gitState=await git.inspectResources(project,workspace,{manifest});
    await fence();
    const indexState=await codeIndex.inspect(project,workspace,{manifest});
    if(!gitResourcesAbsent(gitState)||!indexAbsent(indexState))return wait('RESOURCES_REMAIN');
    await fence();
    await db.query('BEGIN');
    try{
      if(obligation.workspace_id){
        await db.query('SELECT id FROM codeworks.workspaces WHERE id=$1 FOR UPDATE',[workspace.id]);
        await db.query('SELECT workflow_id FROM codeworks.workflow_registry WHERE workspace_id=$1 FOR UPDATE',[workspace.id]);
      }
      const locked=(await db.query('SELECT * FROM codeworks.cleanup_obligations WHERE id=$1 FOR UPDATE',[id])).rows[0];
      if(!locked||Number(locked.epoch)!==epoch||locked.owner_workflow_id!==owner||!['pending','running','retry'].includes(locked.state))throw Error('CLEANUP_FENCE_LOST');
      if(obligation.workspace_id){
        await db.query('UPDATE codeworks.workspaces SET removed_at=COALESCE(removed_at,now()) WHERE id=$1',[workspace.id]);
        await db.query("UPDATE codeworks.workflow_registry SET lifecycle='removed',updated_at=now() WHERE workspace_id=$1",[workspace.id]);
      }
      const result=await db.query("UPDATE codeworks.cleanup_obligations SET state='done',step='done',blocker=NULL,result=$2::jsonb,updated_at=now() WHERE id=$1 RETURNING *",[id,JSON.stringify({git:gitState,index:indexState})]);
      await db.query('COMMIT');return result.rows[0];
    }catch(error){await db.query('ROLLBACK');throw error;}
  }
  return save("step=$4,state='pending',blocker=NULL,next_attempt_at=NULL",[steps[steps.indexOf(step)+1]]);
}
