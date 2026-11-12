// ABOUTME: Повторно проверяет прежнее доказательство очистки и сохраняет операторский ремонт в существующем журнале.
// ABOUTME: Не удаляет ресурсы, не заменяет refs или manifest и не запускает завершённый workflow.
import {createHash,randomUUID} from 'node:crypto';
import {canonical} from './contracts.mjs';
import {verifyCleanupArchive,classifyCleanupArchiveError} from './cleanup-archive.mjs';
import {verifyFilesystemPreservation} from './filesystem-preservation.mjs';
import {verifyDisposition} from './disposition.mjs';
import {recheckPublication} from './publication.mjs';
import {executionContext,withExecutionContext} from './execution-context.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const ownerExecutor='codeworks_owner';
const fail=code=>{throw Error(code);};
const equal=(a,b)=>canonical(a)===canonical(b);
/** Закрепляет всё сохранённое разрешение очистки, включая исходный этап, но без изменяемого retry-состояния. */
export function cleanupEvidenceDigest(item){
  return hash(canonical({subject_key:item.subject_key,workspace_id:item.workspace_id,outcome:item.outcome,step:item.step,expected:item.expected,evidence:item.evidence}));
}

function unchangedResources(current,expected,branchOnly){
  if(!current||current.remote?.known!==true)fail('GIT_SNAPSHOT_UNKNOWN');
  for(const key of ['branch','remote','tracking','ownership']){
    if(!current[key]||!expected[key]||current[key].ref!==expected[key].ref||current[key].oid!==null&&current[key].oid!==expected[key].oid)fail('GIT_SNAPSHOT_CHANGED');
  }
  const w=current.worktree,e=expected.worktree;
  if(!w||!e||w.path!==e.path||typeof w.registered!=='boolean')fail('GIT_SNAPSHOT_CHANGED');
  if(branchOnly){
    if(w.registered||w.path!==null||current.ownership.oid!==null||current.index?.scope!=='not_allocated_by_codeworks')fail('OWNERSHIP_CONFLICT');
    return;
  }
  if(typeof w.pathExists!=='boolean'||w.pathExists&&!e.pathExists||w.registered&&(!e.registered||w.head!==e.head||w.lock!==e.lock||w.owned!==true)||w.pathExists&&(w.dirty!==false||!w.registered))fail('OWNERSHIP_CONFLICT');
  if(current.ownership.oid&&current.ownership.matches!==expected.ownership.matches)fail('OWNERSHIP_CONFLICT');
}

/** Проверяет прежний intent под workspace → registry → obligation locks и общим execution guard.
 * request содержит obligation_id, expected_epoch, evidence_sha256 и request_key.
 * Терминальный повтор возвращает сохранённый результат; технический повтор продолжает тот же repair ID.
 */
export async function resumeCleanup(pool,projectId,request,{git,codeIndex,flowGit,allowedRepositories=[],verifyArchive=verifyCleanupArchive,verifyFilesystem=verifyFilesystemPreservation,verifyTransfer=verifyDisposition,checkpoint=async()=>{}}={}){
  if(!request||Object.keys(request).sort().join(',')!=='evidence_sha256,expected_epoch,obligation_id,request_key'||typeof projectId!=='string'||!projectId||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(request.obligation_id??'')||!Number.isSafeInteger(request.expected_epoch)||request.expected_epoch<0||!/^[0-9a-f]{64}$/.test(request.evidence_sha256??'')||typeof request.request_key!=='string'||!request.request_key.length||request.request_key.length>200)fail('INVALID_ARGUMENT');
  const {request_key,...fields}=request,admitted={project_id:projectId,method:'cleanup-resume',...fields},digest=hash(canonical(admitted));
  const db=await pool.connect(),lost=new AbortController(),parent=executionContext()?.signal;
  const signal=parent?AbortSignal.any([parent,lost.signal]):lost.signal;
  const disconnect=()=>lost.abort(Error('EXECUTION_CONNECTION_LOST'));
  db.on?.('error',disconnect);
  let committed=false;
  try{return await withExecutionContext({signal},async()=>{
    await db.query('BEGIN');
    await db.query("SET LOCAL lock_timeout='1s'");
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['codeworks:cleanup-resume:'+projectId+':'+request_key]);
    const project=(await db.query('SELECT config FROM codeworks.projects WHERE id=$1 FOR SHARE',[projectId])).rows[0]?.config;
    if(!project||project.id!==projectId||!allowedRepositories.includes(project.repo_path))fail('CLEANUP_PROJECT_FORBIDDEN');
    const prior=(await db.query('SELECT r.payload_sha256,o.* FROM codeworks.requests r JOIN codeworks.operations o ON o.id=r.operation_id WHERE r.project_id=$1 AND r.executor_id=$2 AND r.idempotency_key=$3 FOR UPDATE OF o',[projectId,ownerExecutor,request_key])).rows[0];
    if(prior&&(prior.payload_sha256!==digest||prior.kind!=='repair'||!equal(prior.request,admitted)))fail('REQUEST_KEY_CONFLICT');
    if(prior&&['succeeded','failed'].includes(prior.status)){
      await db.query('COMMIT');committed=true;return {...prior.result,duplicate:true};
    }
    const operationId=prior?.id??randomUUID();
    if(prior)await db.query("UPDATE codeworks.operations SET status='running',step='cleanup-resume',updated_at=now() WHERE id=$1",[operationId]);
    else{
      await db.query("INSERT INTO codeworks.operations(id,project_id,workspace_id,executor_id,kind,status,step,request) VALUES($1,$2,NULL,$3,'repair','running','cleanup-resume',$4::jsonb)",[operationId,projectId,ownerExecutor,JSON.stringify(admitted)]);
      await db.query('INSERT INTO codeworks.requests(project_id,executor_id,idempotency_key,payload_sha256,operation_id) VALUES($1,$2,$3,$4,$5)',[projectId,ownerExecutor,request_key,digest,operationId]);
    }
    await db.query('SAVEPOINT cleanup_resume_validation');
    let item,result,status;
    const check=async step=>{signal.throwIfAborted();await checkpoint(step);signal.throwIfAborted();};
    try{
      await check('cleanup-resume-start');
      const first=(await db.query('SELECT * FROM codeworks.cleanup_obligations WHERE id=$1 AND project_id=$2',[request.obligation_id,projectId])).rows[0];
      if(!first)fail('CLEANUP_NOT_FOUND');
      const manifest=first.evidence?.manifest,synthetic=first.evidence?.workspace;
      const branchOnly=manifest?.subject_type==='branch',workspaceId=first.workspace_id??synthetic?.id??manifest?.workspace_id;
      const key=branchOnly?'execution:branch:'+projectId+':'+manifest.branch?.ref:'execution:workspace:'+workspaceId;
      if(!branchOnly&&!workspaceId)fail('WORKSPACE_REQUIRED');
      if(!(await db.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired',[key])).rows[0]?.acquired)fail('CLEANUP_BUSY');
      // AIDEV-NOTE: Порядок совпадает с write.finish и cleanup coordinator; obligation не берётся первым.
      const matches=(await db.query('SELECT * FROM codeworks.workspaces WHERE project_id=$1 AND (id=$2 OR branch=$3 OR path=$4) FOR UPDATE',[projectId,workspaceId??null,first.expected?.branch?.ref?.slice(11),first.expected?.worktree?.path??null])).rows;
      const registries=workspaceId?(await db.query('SELECT * FROM codeworks.workflow_registry WHERE workspace_id=$1 FOR UPDATE',[workspaceId])).rows:[];
      item=(await db.query('SELECT * FROM codeworks.cleanup_obligations WHERE id=$1 AND project_id=$2 FOR UPDATE',[request.obligation_id,projectId])).rows[0];
      if(!item||item.owner_workflow_id!==first.owner_workflow_id||Number(item.epoch)!==request.expected_epoch||item.workspace_id!==first.workspace_id||cleanupEvidenceDigest(item)!==request.evidence_sha256)fail('CLEANUP_FENCE_LOST');
      if(!['waiting_decision','retry'].includes(item.state))fail('CLEANUP_NOT_WAITING');
      const control=(await db.query('SELECT * FROM codeworks.execution_control WHERE project_id=$1 FOR SHARE',[projectId])).rows[0];
      if(control?.owner!=='temporal'||control.mutations_paused)fail('WORKFLOW_OWNER_REQUIRED');
      const registry=registries[0],reconciler='codeworks/'+control.instance_id+'/'+projectId+'/reconciler';
      if(!item.owner_workflow_id||registry&&registry.project_id!==projectId||item.owner_workflow_id!==reconciler&&(!registry||registry.owner!=='temporal'||registry.workflow_id!==item.owner_workflow_id||registry.state==='completed')||registry?.lifecycle==='active')fail('WORKFLOW_OWNER_REQUIRED');
      const workspace=first.workspace_id?matches.find(w=>w.id===first.workspace_id):synthetic;
      if(branchOnly?matches.length>0:!workspace||matches.some(w=>w.id!==workspace.id)||workspace.project_id!==projectId||workspace.id!==workspaceId||workspace.branch!==item.expected?.branch?.ref?.slice(11)||workspace.path!==item.expected?.worktree?.path)fail('WORKSPACE_CONFLICT');
      if(workspaceId&&(await db.query("SELECT 1 FROM codeworks.write_calls WHERE workspace_id=$1 AND state IN ('preparing','in_flight','uncertain') UNION ALL SELECT 1 FROM codeworks.operations WHERE workspace_id=$1 AND NOT archived AND kind<>'cleanup' AND status IN ('pending','running','awaiting_execution','awaiting_ci','awaiting_deployment','awaiting_reconciliation') UNION ALL SELECT 1 FROM codeworks.release_queue q JOIN codeworks.operations o ON o.id=q.operation_id WHERE o.workspace_id=$1 AND q.state IN ('held','queued') LIMIT 1",[workspaceId])).rowCount)fail('ACTIVE_OR_PENDING_WORK');
      const evidence=item.evidence,expected=item.expected;
      if(manifest){
        const {manifest_sha256,...payload}=manifest;
        if(manifest.manifestVersion!==1||manifest.reviewed!==true||manifest.project_id!==projectId||manifest.common_dir!==project.common_dir||hash(canonical(payload))!==manifest_sha256||manifest.protected_task_ids?.includes(workspaceId))fail('MANIFEST_DIGEST_MISMATCH');
        for(const field of ['branch','tracking'])if(!equal(expected[field],manifest[field]))fail('GIT_SNAPSHOT_CHANGED');
        if(expected.ownership?.ref!==manifest.ownership?.ref||expected.ownership?.oid!==manifest.ownership?.oid||expected.remote?.ref!==manifest.remote?.ref||expected.remote?.oid!==manifest.remote?.oid||expected.worktree?.path!==manifest.worktree?.path||!branchOnly&&manifest.workspace_id!==workspaceId)fail('GIT_SNAPSHOT_CHANGED');
      }
      await check('cleanup-resume-before-inspect');
      const current=branchOnly?await git.inspectBranchResources(project,{ref:manifest.branch.ref}):await git.inspectResources(project,workspace,{manifest});
      unchangedResources(current,expected,branchOnly);
      if(!branchOnly){
        if(Object.hasOwn(manifest??{},'filesystem_preservation'))await verifyFilesystem(project,workspace,manifest.filesystem_preservation,{phase:current.worktree.pathExists?'source':'archive'});
        const index=await codeIndex.inspect(project,workspace,{manifest,checkpointState:evidence.index_checkpoint});
        if(index?.complete!==true||typeof index.owner?.present!=='boolean'||!Array.isArray(index.resources?.collections)||!Array.isArray(index.resources?.metadataPoints))fail('INDEX_INSPECTION_INCOMPLETE');
        if(!manifest&&(index.owner.present?index.owner.tokenMatches!==true||index.owner.pathMatches!==true:index.resources.collections.length||index.resources.metadataPoints.length))fail('INDEX_OWNERSHIP_CONFLICT');
      }
      await check('cleanup-resume-before-proof');
      if(evidence.archive){
        if(!manifest||evidence.archive_authorized!==true||manifest.disposition?.type!=='archived'||!equal(evidence.archive,manifest.disposition.archive))fail('ARCHIVE_UNVERIFIED');
        await verifyArchive(project,expected,evidence.archive,{manifest});
      }else if(evidence.verified_disposition?.type==='retained'){
        const retained=evidence.verified_disposition,heads=[expected.branch?.oid,expected.remote?.oid,expected.worktree?.head];
        if(retained.target!=='dev'||!equal(heads,[retained.refs?.branch,retained.refs?.remote,retained.refs?.worktree])||!flowGit||await flowGit.remote(project,'dev')!==retained.target_sha)fail('DISPOSITION_PROOF_REQUIRED');
        for(const head of [...heads,expected.tracking?.oid].filter(Boolean))if(!await flowGit.ancestor(project,head,retained.target_sha))fail('DISPOSITION_PROOF_REQUIRED');
        if(await flowGit.remote(project,'dev')!==retained.target_sha)fail('TARGET_CHANGED');
      }else if(item.outcome==='released'&&evidence.publication){
        if(!equal(expected,evidence.publication.resources)||!await recheckPublication(db,project,workspace,evidence.publication,{ignoreOperationId:item.source_operation_id,lock:true})||!flowGit)fail('DELIVERY_PROOF_CHANGED');
        for(const head of [expected.branch?.oid,expected.remote?.oid,expected.tracking?.oid,expected.worktree?.head].filter(Boolean))if(!await flowGit.ancestor(project,head,evidence.publication.installed_commit))fail('DELIVERY_PROOF_CHANGED');
      }else if(item.outcome==='released'){
        const release=(await db.query("SELECT * FROM codeworks.releases WHERE workspace_id=$1 AND state='succeeded' ORDER BY created_at DESC LIMIT 1",[workspaceId])).rows[0];
        const legs=workspace.kind==='hotfix'?[release?.details?.primary,release?.details?.backport]:[release?.details?.primary];
        if(!release||[expected.branch?.oid,expected.remote?.oid,expected.tracking?.oid,expected.worktree?.head].filter(Boolean).some(head=>head!==release.requested_sha)||legs.some(leg=>!leg?.merged||!leg.merge_sha||!leg.deployment_evidence_id))fail('RELEASE_PROOF_MISMATCH');
        for(const leg of legs)if(!(await db.query('SELECT 1 FROM codeworks.deployment_evidence WHERE id=$1 AND project_id=$2 AND target=$3 AND commit_sha=$4',[leg.deployment_evidence_id,projectId,leg.target==='main'?'prod':'dev',leg.merge_sha])).rowCount)fail('RELEASE_PROOF_MISMATCH');
      }else if(item.outcome==='transferred'){
        if(!evidence.transfer||[expected.branch?.oid,expected.remote?.oid,expected.tracking?.oid,expected.worktree?.head].filter(Boolean).some(head=>head!==evidence.transfer.source_head))fail('DISPOSITION_PROOF_REQUIRED');
        await verifyTransfer(project,workspace,evidence.transfer,{allowedRepositories});
      }else if(!branchOnly&&['unused','cancelled'].includes(item.outcome)){
        if([expected.branch?.oid,expected.remote?.oid,expected.tracking?.oid,expected.worktree?.head].filter(Boolean).some(head=>head!==workspace.base_sha))fail('UNIQUE_CHANGES');
      }else fail('DISPOSITION_PROOF_REQUIRED');
      await check('cleanup-resume-before-save');
      const latest=(await db.query('SELECT * FROM codeworks.cleanup_obligations WHERE id=$1 AND project_id=$2 FOR UPDATE',[item.id,projectId])).rows[0];
      if(!latest||latest.owner_workflow_id!==item.owner_workflow_id||Number(latest.epoch)!==request.expected_epoch||cleanupEvidenceDigest(latest)!==request.evidence_sha256)fail('CLEANUP_FENCE_LOST');
      const updated=(await db.query("UPDATE codeworks.cleanup_obligations SET state='pending',blocker=NULL,next_attempt_at=NULL,epoch=epoch+1,updated_at=now() WHERE id=$1 AND epoch=$2 AND owner_workflow_id=$3 AND state IN ('waiting_decision','retry') RETURNING *",[item.id,request.expected_epoch,item.owner_workflow_id])).rows[0];
      if(!updated)fail('CLEANUP_FENCE_LOST');
      status='succeeded';result={operation_id:operationId,id:item.id,subject:item.subject_key,workspace_id:item.workspace_id,state:updated.state,blocker:null,epoch:Number(updated.epoch),resumed:true,status};
    }catch(error){
      signal.throwIfAborted();
      if(classifyCleanupArchiveError(error)==='propagate'&&['AbortError','CancelledFailure'].includes(error?.name))throw error;
      await db.query('ROLLBACK TO SAVEPOINT cleanup_resume_validation');
      const retry=classifyCleanupArchiveError(error)==='retry'||['55P03','40001','40P01','BUSY'].includes(error?.code)||['CLEANUP_BUSY','INDEX_INSPECTION_INCOMPLETE','GIT_SNAPSHOT_UNKNOWN','INDEX_DATABASE_DISCONNECTED'].includes(error?.message)||error?.message==='INDEX_ENGINE_FAILED'&&error?.indexCode!=='INDEX_OWNERSHIP_CONFLICT';
      status=retry?'awaiting_reconciliation':'failed';
      const reason=retry?'TECHNICAL_RETRY':/^[A-Z][A-Z0-9_]+$/.test(error?.message??'')?error.message:'CLEANUP_RECHECK_FAILED';
      result={operation_id:operationId,id:request.obligation_id,subject:item?.subject_key??null,workspace_id:item?.workspace_id??null,state:item?.state??null,blocker:reason,epoch:request.expected_epoch,resumed:false,status};
    }
    await check('cleanup-resume-journal');
    await db.query('UPDATE codeworks.operations SET status=$2,step=$3,result=$4::jsonb,updated_at=now() WHERE id=$1',[operationId,status,result.resumed?'cleanup-resumed':result.blocker,JSON.stringify(result)]);
    await db.query('COMMIT');committed=true;return {...result,duplicate:false};
  });}
  catch(error){if(!committed)await db.query('ROLLBACK').catch(()=>{});throw error;}
  finally{db.removeListener?.('error',disconnect);db.release(lost.signal.aborted?Error('EXECUTION_CONNECTION_LOST'):undefined);}
}
