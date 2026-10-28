// ABOUTME: Выполняет сохранённые операции деревьев, GitHub и выпуска.
// ABOUTME: Temporal Activities проверяют поручение и исключают повтор одной области; legacy путь сохраняется для восстановления.
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createGit } from './git.mjs';
import { createFlowGit } from './git-flow.mjs';
import { createGitHub } from './github.mjs';
import { advanceRelease, advanceSync } from './release.mjs';
import { Fault,safeFault } from './errors.mjs';
import {enqueueDeployment,advanceDeployment,createDeploymentAdapter} from './deployment.mjs';
import {createCIEvidence} from './ci-evidence.mjs';
import {executionContext,withExecutionContext} from './execution-context.mjs';
import {authorizeCommand,acquireTarget,releaseTarget,closeRelease,cancelWorkspace} from './lifecycle.mjs';
import {advanceCleanup} from './cleanup-coordinator.mjs';
import {verifyDisposition} from './disposition.mjs';
import {advanceBranchCleanup} from './branch-coordinator.mjs';

/** Продвигает сохранённую обязанность под общим guard области и проверкой owner/epoch. */
export async function runCleanupObligation(pool,id,owner,{git,flowGit,codeIndex,allowedRepositories,verifyTransfer=verifyDisposition,checkpoint=async()=>{}}) {
  return executionSession(pool,async(db,signal)=>{
    const item=(await db.query('SELECT * FROM codeworks.cleanup_obligations WHERE id=$1 AND owner_workflow_id=$2',[id,owner])).rows[0];
    if(!item||!['pending','retry','running'].includes(item.state))return;
    const synthetic=item.evidence?.workspace;
    const branch=item.evidence?.manifest?.subject_type==='branch'&&item.subject_key?.startsWith('branch:')?item.subject_key.slice(7):null;
    if(!item.workspace_id&&!synthetic?.id&&!branch)return;
    const key=branch?'execution:branch:'+item.project_id+':'+branch:'execution:workspace:'+(item.workspace_id??synthetic.id);
    if(!(await db.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired',[key])).rows[0].acquired)return;
    try{
      const workspace=item.workspace_id?(await db.query('SELECT * FROM codeworks.workspaces WHERE id=$1',[item.workspace_id])).rows[0]:synthetic;
      const project=(await db.query('SELECT config FROM codeworks.projects WHERE id=$1',[item.project_id])).rows[0]?.config;
      if((!workspace&&!branch)||!project||!allowedRepositories.includes(project.repo_path))throw Error('CLEANUP_PROJECT_FORBIDDEN');
      const guardedCheckpoint=async step=>{signal.throwIfAborted();await checkpoint(step);};
      try{return branch?await advanceBranchCleanup(db,item,project,{git,checkpoint:guardedCheckpoint}):await advanceCleanup(db,item,project,workspace,{git,flowGit,codeIndex,allowedRepositories,verifyTransfer,checkpoint:guardedCheckpoint});}
      catch(error){
        const blocker=error.code??error.message;
        if(!signal.aborted&&['TARGET_CHANGED','OWNERSHIP_CONFLICT','TRANSFER_UNVERIFIED','BRANCH_LIVE_TASK','BRANCH_SUBJECT_INVALID','INVALID_ARGUMENT'].includes(blocker)){
          return (await db.query("UPDATE codeworks.cleanup_obligations SET state='waiting_decision',blocker=$4,updated_at=now() WHERE id=$1 AND owner_workflow_id=$2 AND epoch=$3 AND state IN ('pending','running','retry') RETURNING *",[id,owner,item.epoch,blocker])).rows[0];
        }
        throw error;
      }
    }finally{await db.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[key]).catch(()=>{});}
  });
}
/** Потеря сессии отменяет её внешние процессы: потерянный guard больше не разрешает продолжение. */
async function executionSession(pool,work){
  const db=await pool.connect(),lost=new AbortController(),parent=executionContext()?.signal;
  const signal=parent?AbortSignal.any([parent,lost.signal]):lost.signal;
  const disconnect=()=>lost.abort(new Fault('GIT_FAILED','Execution database connection lost; reconcile the admitted command.'));
  db.on('error',disconnect);
  try{return await withExecutionContext({signal},()=>work(db,signal));}
  finally{db.removeListener('error',disconnect);db.release(lost.signal.aborted?new Error('EXECUTION_CONNECTION_LOST'):undefined);}
}
/** Продолжает одну операцию; прерванные шаги сверяет по фактическому Git/GitHub. */
export async function runOperation(pool,operationId,git,{checkpoint=async()=>{},allowedRepositories=[],flowGit=createFlowGit(),github,deploymentAdapter=createDeploymentAdapter(),workflowId=process.env.CODEWORKS_WORKFLOW_ID,generation=process.env.CODEWORKS_WORKFLOW_GENERATION,scoped=false,expectedKind,prepareStep,codeIndex,verifyTransfer=verifyDisposition}={}) {
  return executionSession(pool,async(db,signal)=>{
  const originalSignalCheckpoint=checkpoint;
  checkpoint=async step=>{signal.throwIfAborted();await originalSignalCheckpoint(step);};
  const verifierPool=process.env.CODEWORKS_VERIFIER_DATABASE_URL?new Pool({connectionString:process.env.CODEWORKS_VERIFIER_DATABASE_URL,max:1,connectionTimeoutMillis:3000}):null;
  let verifier=db,locked=false,executionKey;
  try {
    if(verifierPool)verifier=await verifierPool.connect();
    github??=createGitHub({evidenceStore:createCIEvidence(verifier)});
    const first=(await db.query('SELECT * FROM codeworks.operations WHERE id=$1',[operationId])).rows[0];
    if(!first||first.archived||!['prepare','sync','release','rollout','cleanup','release.close','workspace.cancel','workspace.transfer'].includes(first.kind))return;
    if(expectedKind&&first.kind!==expectedKind)throw new Fault('FORBIDDEN');
    executionKey=scoped?'execution:'+(first.workspace_id?'workspace:'+first.workspace_id:'rollout:'+first.id):first.project_id;
    if(scoped){
      // AIDEV-NOTE: Повтор Activity не ждёт прежний проход. Ключ не пересекается с приёмом команд или другими областями.
      if(!(await db.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired',[executionKey])).rows[0].acquired)return;
    }else await db.query('SELECT pg_advisory_lock(hashtextextended($1,0))',[executionKey]);
    locked=true;
    const op=(await db.query('SELECT * FROM codeworks.operations WHERE id=$1',[operationId])).rows[0];
    const admission=(await db.query('SELECT * FROM codeworks.commands WHERE operation_id=$1',[operationId])).rows[0];
    const ownership=(await db.query("SELECT owner FROM codeworks.workflow_registry WHERE workspace_id=$1",[op.workspace_id])).rows[0];
    if(scoped&&!admission)throw new Fault('FORBIDDEN');
    if(admission){
      const saved=await authorizeCommand(db,op.id,workflowId,generation);
      if(saved.state!=='pending')return;
      const originalCheckpoint=checkpoint;
      checkpoint=async step=>{const current=await authorizeCommand(db,op.id,workflowId,generation);if(current.state!=='pending')throw new Fault('FORBIDDEN');await originalCheckpoint(step);};
    }else if(ownership?.owner==='temporal')throw new Fault('FORBIDDEN');

    if(scoped){
      const guarded=port=>Object.fromEntries(Object.entries(port).map(([name,work])=>[name,typeof work==='function'?async(...args)=>{await checkpoint('before-'+name);return work.apply(port,args);}:work]));
      git=guarded(git);flowGit=guarded(flowGit);github=guarded(github);
      if(deploymentAdapter){
        const adapter=deploymentAdapter;
        deploymentAdapter=async id=>{await checkpoint('before-rollout');return adapter(id);};
        if(adapter.inspect)deploymentAdapter.inspect=async id=>{await checkpoint('before-rollout-inspect');return adapter.inspect(id);};
      }
    }

    if(op.archived||!['pending','running','awaiting_execution','awaiting_ci','awaiting_deployment','awaiting_reconciliation'].includes(op.status))return;
    const project=(await db.query('SELECT config FROM codeworks.projects WHERE id=$1',[op.project_id])).rows[0].config;
    const w=(await db.query('SELECT * FROM codeworks.workspaces WHERE id=$1',[op.workspace_id])).rows[0];
    await db.query("UPDATE codeworks.operations SET status='running',updated_at=now() WHERE id=$1",[op.id]);
    const finish=(status,step,result)=>db.query('UPDATE codeworks.operations SET status=$2,step=$3,result=$4,error=NULL,updated_at=now() WHERE id=$1',[op.id,status,step,result]);
    const reconcileDeployment=async id=>{
      const deployment=(await db.query('SELECT * FROM codeworks.operations WHERE id=$1',[id])).rows[0];
      if(deployment&&!['failed','succeeded'].includes(deployment.status)&&deploymentAdapter?.inspect){
        const key='execution:rollout:'+id;
        if(scoped&&!(await db.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired',[key])).rows[0].acquired)return;
        try{
          let outcome=await advanceDeployment(verifier,deployment,deploymentAdapter.inspect);
          if(outcome.reason==='ANSIBLE_ROLLOUT_UNSTARTED'){
            await db.query('BEGIN');
            try{
              await db.query('UPDATE codeworks.deployments SET receipt=$2 WHERE operation_id=$1',[id,{status:'failed',operation_id:id,code:'RELEASE_CLOSED_BEFORE_INSTALLATION'}]);
              await db.query("UPDATE codeworks.operations SET status='failed',step='RELEASE_CLOSED_BEFORE_INSTALLATION',updated_at=now() WHERE id=$1",[id]);
              await db.query("UPDATE codeworks.commands SET state='done',updated_at=now() WHERE operation_id=$1",[id]);
              await db.query('COMMIT');
            }catch(error){await db.query('ROLLBACK').catch(()=>{});throw error;}
            outcome={status:'failed',reason:'RELEASE_CLOSED_BEFORE_INSTALLATION'};
          }
          await db.query('UPDATE codeworks.operations SET status=$2,step=$3,updated_at=now() WHERE id=$1',[id,outcome.status,outcome.reason]);
        }finally{if(scoped)await db.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[key]);}
      }
    };
    try {
      if(!allowedRepositories.includes(project.repo_path))throw new Fault('FORBIDDEN');
      if(['workspace.cancel','workspace.transfer'].includes(op.kind)){
        const attempts=(await db.query("SELECT operation_id FROM codeworks.releases WHERE workspace_id=$1 AND state<>'succeeded' AND closed_at IS NULL ORDER BY created_at",[w.id])).rows;
        for(const attempt of attempts){
          const result=await closeRelease(db,{request:{release_operation_id:attempt.operation_id,reason:'workspace-finalization'}},project,w,{flowGit,github,reconcileDeployment});
          if(result.status!=='succeeded'){await finish('awaiting_reconciliation',result.reason,result);return;}
        }
      }
      if(op.kind==='workspace.cancel'){
        const outcome=await cancelWorkspace(db,op);await finish(outcome.status,outcome.reason,outcome);return;
      }
      if(op.kind==='workspace.transfer'){
        await checkpoint('before-transfer-proof');
        await verifyTransfer(project,w,op.request.evidence,{allowedRepositories});
        const outcome=await cancelWorkspace(db,op,{outcome:'transferred',evidence:{transfer:op.request.evidence}});
        await finish(outcome.status,'TRANSFER_CLEANUP_PENDING',outcome);return;
      }
      if(op.kind==='release.close'){
        const outcome=await closeRelease(db,op,project,w,{flowGit,github,reconcileDeployment});
        await finish(outcome.status,outcome.reason,outcome);return;
      }
      if(op.kind==='rollout'){
        const d=(await db.query('SELECT * FROM codeworks.deployments WHERE operation_id=$1',[op.id])).rows[0];
        if(admission){
          if(d.release_operation_id){
            const permitted=(await db.query("SELECT 1 FROM codeworks.release_queue q JOIN codeworks.releases r ON r.operation_id=q.operation_id WHERE q.operation_id=$1 AND q.target=$2 AND q.state='held' AND r.closed_at IS NULL AND (r.details->'primary'->>'merge_sha'=$3 OR r.details->'backport'->>'merge_sha'=$3)",[d.release_operation_id,d.target,d.commit_sha])).rowCount;
            if(!permitted){await finish('awaiting_reconciliation','RELEASE_LANE_REQUIRED',op.result);return;}
          }else if(!await acquireTarget(db,project.id,d.target,op.id,d.retry_of)){await finish('awaiting_deployment','TARGET_QUEUE',op.result);return;}
        }
        let outcome;
        try{outcome=await advanceDeployment(verifier,op,deploymentAdapter);}catch(error){
          if(admission||error.code!=='GIT_FAILED')throw error;
          outcome={status:'awaiting_deployment',reason:'ANSIBLE_ROLLOUT_RECONCILIATION_REQUIRED'};
        }
        if(admission&&!d.release_operation_id&&outcome.status==='succeeded')await releaseTarget(db,op.id,d.target);
        await finish(outcome.status,outcome.reason,outcome);return;
      }
      if(op.kind==='cleanup'){
        if(admission){
          const obligation=(await db.query("SELECT id FROM codeworks.cleanup_obligations WHERE workspace_id=$1 AND state<>'done'",[w.id])).rows[0];
          if(!obligation)throw new Fault('CONFLICT','Cleanup requires a durable obligation.');
          await finish('awaiting_reconciliation','cleanup_scheduled',{obligation_id:obligation.id});return;
        }
        const release=(await db.query("SELECT r.* FROM codeworks.releases r JOIN codeworks.operations o ON o.id=r.operation_id WHERE r.workspace_id=$1 AND r.state='succeeded' AND NOT o.archived ORDER BY r.created_at DESC LIMIT 1",[w.id])).rows[0];
        if(!release)throw new Fault('CONFLICT','Cleanup requires a completed release.');
        const legs=w.kind==='hotfix'?[release.details.primary,release.details.backport]:[release.details.primary];
        if(legs.some(leg=>!leg?.merged||!leg.deployment_evidence_id))throw new Fault('CONFLICT');
        const removed=await git.cleanup(project,w,legs.map(l=>l.merge_sha),release.requested_sha);
        if(!removed)throw new Fault('CONFLICT','Cleanup preserved the workspace: check uncommitted or unmerged changes, then retry cleanup with a new request key.');
        if(w.code_index){
          if(!codeIndex)throw Error('INDEX_CLEANUP_ADAPTER_REQUIRED');
          await checkpoint('before-index-cleanup');
          await codeIndex.remove(project,w);
        }
        await db.query('UPDATE codeworks.workspaces SET removed_at=COALESCE(removed_at,now()) WHERE id=$1',[w.id]);
        await finish('succeeded','removed',{removed});return;
      }
      if(op.kind==='sync'){
        const details=op.result??{};
        const save=async value=>db.query('UPDATE codeworks.operations SET result=$2,updated_at=now() WHERE id=$1',[op.id,value]);
        const outcome=await advanceSync({project,workspace:w,operation:op,details},{git:flowGit,github,inspect:(...a)=>git.inspect(...a),save,checkpoint});
        await finish(outcome.status,outcome.reason,details);return;
      }
      if(op.kind==='release'){
        const release=(await db.query('SELECT * FROM codeworks.releases WHERE operation_id=$1',[op.id])).rows[0];
        const save=async details=>db.query('UPDATE codeworks.releases SET details=$2 WHERE id=$1',[release.id,details]);
        const evidence=async(target,sha)=>{
          const record=(await db.query("SELECT * FROM codeworks.deployment_evidence WHERE project_id=$1 AND target=$2 AND NOT EXISTS (SELECT 1 FROM codeworks.deployments d JOIN codeworks.operations o ON o.id=d.operation_id WHERE d.project_id=$1 AND d.target=$2 AND NOT o.archived AND d.created_at>codeworks.deployment_evidence.created_at AND (d.receipt->>'verified') IS DISTINCT FROM 'true') ORDER BY created_at DESC,id DESC LIMIT 1",[project.id,target])).rows[0];
          return record&&(!sha||record.commit_sha===sha)?record:null;
        };
        let outcome;
        try {
          outcome=await advanceRelease({project,workspace:w,operation:op,release},{git:flowGit,github,inspect:(...a)=>git.inspect(...a),save,evidence,checkpoint,...(admission?{acquire:target=>acquireTarget(db,project.id,target,op.id,release.retry_of),releaseLane:target=>releaseTarget(db,op.id,target),verifyEvidence:async(id,target,sha)=>(await db.query('SELECT 1 FROM codeworks.deployment_evidence WHERE id=$1 AND project_id=$2 AND target=$3 AND commit_sha=$4',[id,project.id,target,sha])).rowCount===1}:{}),deploy:deploymentAdapter?async(target,sha,proof,retryOf)=>{
            const operation_id=await enqueueDeployment(db,project,target,sha,proof,verifier,{retryOf,releaseOperationId:admission?op.id:null});
            const deployment=(await db.query('SELECT status FROM codeworks.operations WHERE id=$1',[operation_id])).rows[0];
            return {operation_id,status:deployment.status};
          }:undefined});
        }catch(error){
          if(admission&&['GITHUB_UNAVAILABLE','GIT_FAILED'].includes(error?.code))throw error;
          if(['GITHUB_UNAVAILABLE','GIT_FAILED'].includes(error?.code))outcome={status:'awaiting_reconciliation',reason:error.code};
          else throw error;
        }
        const cleanupId=outcome.status==='succeeded'?randomUUID():null;
        await db.query('BEGIN');
        try{
          await db.query('UPDATE codeworks.releases SET state=$2,details=$3 WHERE id=$1',[release.id,outcome.status,release.details]);
          // AIDEV-NOTE: Выпуск и намерение очистки фиксируются вместе; существующий worker продолжит очистку после сбоя.
          if(cleanupId)await db.query("INSERT INTO codeworks.operations(id,project_id,workspace_id,executor_id,kind,status,step,request) VALUES($1,$2,$3,$4,'cleanup','pending','intent',$5)",[cleanupId,op.project_id,w.id,op.executor_id,{project_id:op.project_id,workspace_id:w.id,request_key:'release-cleanup-'+op.id}]);
          if(cleanupId&&admission){
            await db.query("UPDATE codeworks.workflow_registry SET state='draining',lifecycle='closing',outcome='released',updated_at=now() WHERE workspace_id=$1",[w.id]);
            await db.query("INSERT INTO codeworks.cleanup_obligations(id,project_id,workspace_id,subject_key,source_operation_id,outcome,step,state,evidence,expected,owner_workflow_id,epoch,attempts) VALUES($1,$2,$3,$4,$5,'released','inspect','pending','{}'::jsonb,'{}'::jsonb,$6,1,0)",[randomUUID(),op.project_id,w.id,'workspace:'+w.id,op.id,workflowId]);
          }
          await finish(outcome.status,outcome.reason,{release_id:release.id,state:outcome.status,details:release.details,...(cleanupId?{cleanup_operation_id:cleanupId}:{})});
          if(cleanupId)await checkpoint('before-release-completed');
          await db.query('COMMIT');
        }catch(error){await db.query('ROLLBACK').catch(()=>{});throw error;}
        return;
      }
      if(prepareStep){
        const stages=['branch','checkout','dependencies','ready'],previous=stages.indexOf(w.preparation_state),requested=stages.indexOf(prepareStep);
        if(requested>previous+1)return;
      }
      // AIDEV-NOTE: Ready область после миграции может иметь старый архивный prepare.
      if(prepareStep&&['branch','checkout','dependencies','ready'].indexOf(w.preparation_state)>=['branch','checkout','dependencies','ready'].indexOf(prepareStep)&&prepareStep!=='ready')return;
      if(w.preparation_state!=='ready')for(const step of ['branch','checkout','dependencies'].filter(step=>!prepareStep||prepareStep===step)){
        await checkpoint('before-'+step);await git[step](project,w);await checkpoint('after-'+step);
        await db.query('UPDATE codeworks.workspaces SET preparation_state=$2 WHERE id=$1',[w.id,step]);
        await db.query('UPDATE codeworks.operations SET step=$2,updated_at=now() WHERE id=$1',[op.id,step]);
      }
      if(prepareStep&&prepareStep!=='ready')return;
      await git.inspect(project,w);await checkpoint('before-ready');
      await db.query("UPDATE codeworks.workspaces SET preparation_state='ready' WHERE id=$1",[w.id]);
      await finish('succeeded','ready',{workspace_id:w.id});
    }catch(error){
      if(signal.aborted)throw error;
      if(scoped&&error?.code==='BUSY')return;
      if(error?.code==='TEST_INTERRUPTION'||(admission&&(!error?.code||['GIT_FAILED','GITHUB_UNAVAILABLE'].includes(error.code)||/^08|^57/.test(error.code))))throw error;
      if(admission&&op.kind==='release'){
        const r=(await db.query('SELECT details FROM codeworks.releases WHERE operation_id=$1',[op.id])).rows[0];
        if(!r?.details.primary&&!r?.details.backport)await db.query("UPDATE codeworks.release_queue SET state='closed',updated_at=now() WHERE operation_id=$1 AND state IN ('held','queued')",[op.id]);
        for(const leg of [r?.details.primary,r?.details.backport].filter(Boolean))if(!leg.merge_push_attempted)await releaseTarget(db,op.id,leg.target==='main'?'prod':'dev','closed');
      }
      if(op.kind==='prepare')await db.query("UPDATE codeworks.workspaces SET preparation_state='failed' WHERE id=$1",[w.id]);
      if(op.kind==='release')await db.query("UPDATE codeworks.releases SET state='failed' WHERE operation_id=$1",[op.id]);
      await db.query("UPDATE codeworks.operations SET status='failed',error=$2,updated_at=now() WHERE id=$1",[op.id,safeFault(error).dto()]);
    }
  }finally{
    if(locked)await db.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[executionKey]).catch(()=>{});
    if(verifier!==db)verifier.release();
    await verifierPool?.end();
  }
  });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  if(process.env.CODEWORKS_LOCK_HELD!=='1'||!process.env.CODEWORKS_DATABASE_URL)throw new Error('LOCKED_WORKER_REQUIRED');
  const pool=new Pool({connectionString:process.env.CODEWORKS_DATABASE_URL,max:1,connectionTimeoutMillis:3000});
  pool.on('error',()=>{});
  try{await runOperation(pool,process.argv[2],createGit(),{allowedRepositories:JSON.parse(process.env.CODEWORKS_ALLOWED_REPOSITORIES??'[]'),checkpoint:async step=>{
    if(process.env.CODEWORKS_TEST_CRASH_AFTER===step&&process.env.CODEWORKS_TEST_MODE==='1')process.kill(process.pid,'SIGKILL');
  }});}catch{console.error('codeworks worker interrupted; intent retained');process.exitCode=1;}
  finally{await pool.end();}
}
