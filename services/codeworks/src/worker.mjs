// ABOUTME: Возобновляет durable подготовку из БД под наследуемым проектным flock.
// ABOUTME: Каждый внешний шаг повторно доказывает владение; ошибка сохраняет intent и ресурсы.
import { Pool } from 'pg';
import { pathToFileURL } from 'node:url';
import { createGit } from './git.mjs';
import { createFlowGit } from './git-flow.mjs';
import { createGitHub } from './github.mjs';
import { advanceRelease } from './release.mjs';
import { Fault,safeFault } from './errors.mjs';
import {createCIEvidence} from './ci-evidence.mjs';
/** Исполняет одну незавершённую подготовку; checkpoint нужен также для fault-injection теста. */
export async function runOperation(pool,operationId,git,{checkpoint=async()=>{},allowedRepositories=[],flowGit=createFlowGit(),github}={}) {
  const db=await pool.connect();
  github??=createGitHub({evidenceStore:createCIEvidence(db)});
  let locked=false;
  try {
    const operation=(await db.query('SELECT * FROM codeworks.operations WHERE id=$1',[operationId])).rows[0];
    if(!operation||!['prepare-write','request-release'].includes(operation.kind))return;
    await db.query('SELECT pg_advisory_lock(hashtextextended($1,0))',[operation.project_id]);locked=true;
    const op=(await db.query('SELECT * FROM codeworks.operations WHERE id=$1',[operationId])).rows[0];
    if(!['pending','running',...(op.kind==='request-release'?['awaiting_ci','awaiting_deployment','awaiting_reconciliation']:[])].includes(op.status))return;
    const project=(await db.query('SELECT config FROM codeworks.projects WHERE id=$1',[op.project_id])).rows[0].config;
    const w=(await db.query('SELECT * FROM codeworks.workspaces WHERE id=$1',[op.workspace_id])).rows[0];
    await db.query("UPDATE codeworks.operations SET status='running',updated_at=now() WHERE id=$1",[op.id]);
    try {
      if(!allowedRepositories.includes(project.repo_path))throw new Fault('FORBIDDEN');
      if(op.kind==='request-release') {
        const release=(await db.query('SELECT * FROM codeworks.releases WHERE operation_id=$1',[op.id])).rows[0];
        const save=async details=>{
          await db.query('BEGIN');
          try{
            await db.query('UPDATE codeworks.releases SET details=$2 WHERE id=$1',[release.id,details]);
            await db.query('UPDATE codeworks.operations SET result=$2,updated_at=now() WHERE id=$1',[op.id,{release_id:release.id,state:'running',details}]);
            await db.query('COMMIT');
          }catch(error){await db.query('ROLLBACK').catch(()=>{});throw error;}
        };
        const evidence=async(target,sha)=>{
          const record=(await db.query('SELECT * FROM codeworks.deployment_evidence WHERE project_id=$1 AND target=$2 ORDER BY created_at DESC,id DESC LIMIT 1',[project.id,target])).rows[0];
          return record&&(!sha||record.commit_sha===sha)?record:null;
        };
        let outcome;
        try{
          outcome=await advanceRelease({project,workspace:w,operation:op,release},{git:flowGit,github,inspect:(...args)=>git.inspect(...args),save,evidence,checkpoint});
        }catch(error){
          if(error?.code==='TEST_INTERRUPTION')throw error;
          if(['GITHUB_UNAVAILABLE','GIT_FAILED'].includes(error?.code))outcome={status:'awaiting_reconciliation',reason:error.code};
          else throw error;
        }
        await db.query('BEGIN');
        try{
          await db.query('UPDATE codeworks.releases SET state=$2,details=$3 WHERE id=$1',[release.id,outcome.status,release.details]);
          await db.query('UPDATE codeworks.operations SET status=$2,step=$3,result=$4,error=NULL,updated_at=now() WHERE id=$1',[op.id,outcome.status,outcome.reason,{release_id:release.id,state:outcome.status,details:release.details}]);
          await db.query('COMMIT');
        }catch(error){await db.query('ROLLBACK').catch(()=>{});throw error;}
        return;
      }
      // Каждый шаг идемпотентен по реальному Git, а не только по последнему флагу в БД.
      for(const step of ['branch','checkout','dependencies']) {
        await checkpoint('before-'+step);
        await git[step](project,w);
        await checkpoint('after-'+step);
        await db.query('BEGIN');
        try {
          await db.query('UPDATE codeworks.workspaces SET preparation_state=$2 WHERE id=$1',[w.id,step]);
          await db.query('UPDATE codeworks.operations SET step=$2,updated_at=now() WHERE id=$1',[op.id,step]);
          await db.query('COMMIT');
        } catch(error) {await db.query('ROLLBACK').catch(()=>{});throw error;}
      }
      await checkpoint('before-ready');
      await db.query('BEGIN');
      try {
        await db.query("UPDATE codeworks.workspaces SET preparation_state='ready' WHERE id=$1",[w.id]);
        await db.query("UPDATE codeworks.operations SET status='succeeded',step='ready',error=NULL,result=$2,updated_at=now() WHERE id=$1",[op.id,{workspace_id:w.id}]);
        await db.query('COMMIT');
      } catch(error) {await db.query('ROLLBACK').catch(()=>{});throw error;}
    } catch(error) {
      if(error?.code==='TEST_INTERRUPTION')throw error;
      const fault=safeFault(error);
      await db.query('BEGIN');
      try {
        if(op.kind==='prepare-write')await db.query("UPDATE codeworks.workspaces SET preparation_state='failed' WHERE id=$1",[w.id]);
        else {
          const failed=(await db.query("UPDATE codeworks.releases SET state='failed' WHERE operation_id=$1 RETURNING id,details",[op.id])).rows[0];
          if(failed)await db.query('UPDATE codeworks.operations SET result=$2 WHERE id=$1',[op.id,{release_id:failed.id,state:'failed',details:failed.details}]);
        }
        await db.query("UPDATE codeworks.operations SET status='failed',error=$2,updated_at=now() WHERE id=$1",[op.id,fault.dto()]);
        await db.query('COMMIT');
      }catch(failure){await db.query('ROLLBACK').catch(()=>{});throw failure;}
    }
  } finally {
    if(locked)await db.query('SELECT pg_advisory_unlock_all()').catch(()=>{});
    db.release();
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  if(process.env.CODEWORKS_LOCK_HELD!=='1'||!process.env.CODEWORKS_DATABASE_URL)throw new Error('LOCKED_WORKER_REQUIRED');
  const pool=new Pool({connectionString:process.env.CODEWORKS_DATABASE_URL,max:1,connectionTimeoutMillis:3000});
  pool.on('error',()=>{});
  try {
    await runOperation(pool,process.argv[2],createGit(),{allowedRepositories:JSON.parse(process.env.CODEWORKS_ALLOWED_REPOSITORIES??'[]'),checkpoint:async step=>{
      // AIDEV-NOTE: Только явно включённый fixture может принудительно оборвать процесс.
      if(process.env.CODEWORKS_TEST_CRASH_AFTER===step&&process.env.CODEWORKS_TEST_MODE==='1')process.kill(process.pid,'SIGKILL');
    }});
  } catch {console.error('codeworks worker interrupted; durable intent retained');process.exitCode=1;}
  finally {await pool.end();}
}
