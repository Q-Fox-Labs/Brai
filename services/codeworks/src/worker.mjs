// ABOUTME: Выполняет сохранённые операции деревьев, GitHub и выпуска.
// ABOUTME: Работает только со своими операциями под проектным lock; процессы и права агента не затрагивает.
import { Pool } from 'pg';
import { pathToFileURL } from 'node:url';
import { createGit } from './git.mjs';
import { createFlowGit } from './git-flow.mjs';
import { createGitHub } from './github.mjs';
import { advanceRelease, advanceSync } from './release.mjs';
import { Fault,safeFault } from './errors.mjs';
import {enqueueDeployment,advanceDeployment,createDeploymentAdapter} from './deployment.mjs';
import {createCIEvidence} from './ci-evidence.mjs';
/** Продолжает одну операцию; прерванные шаги сверяет по фактическому Git/GitHub. */
export async function runOperation(pool,operationId,git,{checkpoint=async()=>{},allowedRepositories=[],flowGit=createFlowGit(),github,deploymentAdapter=createDeploymentAdapter()}={}) {
  const db=await pool.connect();
  const verifierPool=process.env.CODEWORKS_VERIFIER_DATABASE_URL?new Pool({connectionString:process.env.CODEWORKS_VERIFIER_DATABASE_URL,max:1,connectionTimeoutMillis:3000}):null;
  let verifier=db,locked=false;
  try {
    if(verifierPool)verifier=await verifierPool.connect();
    github??=createGitHub({evidenceStore:createCIEvidence(verifier)});
    const first=(await db.query('SELECT * FROM codeworks.operations WHERE id=$1',[operationId])).rows[0];
    if(!first||first.archived||!['prepare','sync','release','rollout','cleanup'].includes(first.kind))return;
    await db.query('SELECT pg_advisory_lock(hashtextextended($1,0))',[first.project_id]);locked=true;
    const op=(await db.query('SELECT * FROM codeworks.operations WHERE id=$1',[operationId])).rows[0];
    if(op.archived||!['pending','running','awaiting_ci','awaiting_deployment','awaiting_reconciliation'].includes(op.status))return;
    const project=(await db.query('SELECT config FROM codeworks.projects WHERE id=$1',[op.project_id])).rows[0].config;
    const w=(await db.query('SELECT * FROM codeworks.workspaces WHERE id=$1',[op.workspace_id])).rows[0];
    await db.query("UPDATE codeworks.operations SET status='running',updated_at=now() WHERE id=$1",[op.id]);
    const finish=(status,step,result)=>db.query('UPDATE codeworks.operations SET status=$2,step=$3,result=$4,error=NULL,updated_at=now() WHERE id=$1',[op.id,status,step,result]);
    try {
      if(!allowedRepositories.includes(project.repo_path))throw new Fault('FORBIDDEN');
      if(op.kind==='rollout'){
        let outcome;
        try{outcome=await advanceDeployment(verifier,op,deploymentAdapter);}catch(error){
          if(error.code!=='GIT_FAILED')throw error;
          outcome={status:'awaiting_deployment',reason:'ANSIBLE_ROLLOUT_RECONCILIATION_REQUIRED'};
        }
        await finish(outcome.status,outcome.reason,outcome);return;
      }
      if(op.kind==='cleanup'){
        const release=(await db.query("SELECT r.* FROM codeworks.releases r JOIN codeworks.operations o ON o.id=r.operation_id WHERE r.workspace_id=$1 AND r.state='succeeded' AND NOT o.archived ORDER BY r.created_at DESC LIMIT 1",[w.id])).rows[0];
        if(!release)throw new Fault('CONFLICT','Cleanup requires a completed release.');
        const legs=w.kind==='hotfix'?[release.details.primary,release.details.backport]:[release.details.primary];
        if(legs.some(leg=>!leg?.merged||!leg.deployment_evidence_id))throw new Fault('CONFLICT');
        const removed=await git.cleanup(project,w,legs.map(l=>l.merge_sha));
        if(removed)await db.query('UPDATE codeworks.workspaces SET removed_at=COALESCE(removed_at,now()) WHERE id=$1',[w.id]);
        await finish('succeeded',removed?'removed':'preserved',{removed});return;
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
          outcome=await advanceRelease({project,workspace:w,operation:op,release},{git:flowGit,github,inspect:(...a)=>git.inspect(...a),save,evidence,checkpoint,deploy:deploymentAdapter?async(target,sha,proof,retryOf)=>{
            const operation_id=await enqueueDeployment(db,project,target,sha,proof,verifier,{retryOf});
            const deployment=(await db.query('SELECT status FROM codeworks.operations WHERE id=$1',[operation_id])).rows[0];
            return {operation_id,status:deployment.status};
          }:undefined});
        }catch(error){
          if(['GITHUB_UNAVAILABLE','GIT_FAILED'].includes(error?.code))outcome={status:'awaiting_reconciliation',reason:error.code};
          else throw error;
        }
        await db.query('BEGIN');
        try{
          await db.query('UPDATE codeworks.releases SET state=$2,details=$3 WHERE id=$1',[release.id,outcome.status,release.details]);
          await finish(outcome.status,outcome.reason,{release_id:release.id,state:outcome.status,details:release.details});
          await db.query('COMMIT');
        }catch(error){await db.query('ROLLBACK').catch(()=>{});throw error;}
        return;
      }
      // AIDEV-NOTE: Ready область после миграции может иметь старый архивный prepare.
      if(w.preparation_state!=='ready')for(const step of ['branch','checkout','dependencies']){
        await checkpoint('before-'+step);await git[step](project,w);await checkpoint('after-'+step);
        await db.query('UPDATE codeworks.workspaces SET preparation_state=$2 WHERE id=$1',[w.id,step]);
        await db.query('UPDATE codeworks.operations SET step=$2,updated_at=now() WHERE id=$1',[op.id,step]);
      }
      await git.inspect(project,w);await checkpoint('before-ready');
      await db.query("UPDATE codeworks.workspaces SET preparation_state='ready' WHERE id=$1",[w.id]);
      await finish('succeeded','ready',{workspace_id:w.id});
    }catch(error){
      if(error?.code==='TEST_INTERRUPTION')throw error;
      if(op.kind==='prepare')await db.query("UPDATE codeworks.workspaces SET preparation_state='failed' WHERE id=$1",[w.id]);
      if(op.kind==='release')await db.query("UPDATE codeworks.releases SET state='failed' WHERE operation_id=$1",[op.id]);
      await db.query("UPDATE codeworks.operations SET status='failed',error=$2,updated_at=now() WHERE id=$1",[op.id,safeFault(error).dto()]);
    }
  }finally{
    if(locked)await db.query('SELECT pg_advisory_unlock_all()').catch(()=>{});
    if(verifier!==db)verifier.release();
    await verifierPool?.end();db.release();
  }
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
