// ABOUTME: Возобновляет durable подготовку из БД под наследуемым проектным flock.
// ABOUTME: Каждый внешний шаг повторно доказывает владение; ошибка сохраняет intent и ресурсы.
import { Pool } from 'pg';
import { pathToFileURL } from 'node:url';
import { createGit } from './git.mjs';
import { Fault,safeFault } from './errors.mjs';
/** Исполняет одну незавершённую подготовку; checkpoint нужен также для fault-injection теста. */
export async function runOperation(pool,operationId,git,{checkpoint=async()=>{},allowedRepositories=[]}={}) {
  const db=await pool.connect();
  let locked=false;
  try {
    const operation=(await db.query('SELECT * FROM codeworks.operations WHERE id=$1',[operationId])).rows[0];
    if(!operation||operation.kind!=='prepare-write')return;
    await db.query('SELECT pg_advisory_lock(hashtextextended($1,0))',[operation.project_id]);locked=true;
    const op=(await db.query('SELECT * FROM codeworks.operations WHERE id=$1',[operationId])).rows[0];
    if(!['pending','running'].includes(op.status))return;
    const project=(await db.query('SELECT config FROM codeworks.projects WHERE id=$1',[op.project_id])).rows[0].config;
    const w=(await db.query('SELECT * FROM codeworks.workspaces WHERE id=$1',[op.workspace_id])).rows[0];
    await db.query("UPDATE codeworks.operations SET status='running',updated_at=now() WHERE id=$1",[op.id]);
    try {
      if(!allowedRepositories.includes(project.repo_path))throw new Fault('FORBIDDEN');
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
        await db.query("UPDATE codeworks.workspaces SET preparation_state='failed' WHERE id=$1",[w.id]);
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
