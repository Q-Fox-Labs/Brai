// ABOUTME: Публикует производный catalog из сохранённых CI proofs ограниченными проходами проекта.
// ABOUTME: Работает в прежнем проектном исполнителе Temporal; публикация не изменяет CI proofs.
import {createHash} from 'node:crypto';
import {canonical} from './ci-verifier.mjs';
import {ciFailure} from './errors.mjs';
import {executionContext,withExecutionContext} from './execution-context.mjs';

/** Публикует не более одного catalog за проход; pending переживает сбои и перезапуск worker.
 * github.publishCatalog(project) подписывает и публикует catalog; now возвращает текущую Date.
 * Сессионный guard исключает параллельную публикацию проекта без долгой транзакции.
 */
export async function reconcileCatalogPublication(pool,projectId,{github,now=()=>new Date()}={}) {
  const db=await pool.connect(),key='execution:catalog:'+projectId;
  let locked=false,lost=false;
  const cancelled=new AbortController(),parent=executionContext()?.signal;
  const signal=parent?AbortSignal.any([parent,cancelled.signal]):cancelled.signal;
  const onError=()=>{lost=true;cancelled.abort(Error('CATALOG_GUARD_LOST'));};db.on?.('error',onError);
  const stamp=()=>new Date(now());
  try {return await withExecutionContext({signal},async()=>{
    signal.throwIfAborted();
    locked=!!(await db.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired',[key])).rows[0]?.acquired;
    if(!locked)return {state:'waiting',reason_code:'CATALOG_PUBLICATION_BUSY'};
    const project=(await db.query('SELECT config FROM codeworks.projects WHERE id=$1',[projectId])).rows[0]?.config;
    if(!project?.github?.ci?.reuse_public_key)return {state:'idle'};
    const control=(await db.query('SELECT owner,mutations_paused,github_retry_at,github_reason_code FROM codeworks.execution_control WHERE project_id=$1',[projectId])).rows[0];
    if(!control||control.owner!=='temporal'||control.mutations_paused)return {state:'waiting',reason_code:'EXECUTION_PAUSED'};
    const current=stamp();
    if(control.github_retry_at&&new Date(control.github_retry_at)>current)return {state:'waiting',reason_code:'GITHUB_RATE_LIMITED',next_attempt_at:new Date(control.github_retry_at).toISOString()};
    const policy=createHash('sha256').update(JSON.stringify(canonical(project.github.ci))).digest('hex');
    const pending=(await db.query("SELECT run_id,attempt,policy_sha256,catalog_attempts,catalog_next_attempt_at FROM codeworks.verified_ci WHERE project_id=$1 AND policy_sha256=$2 AND catalog_state='pending' ORDER BY created_at,run_id,attempt LIMIT 256",[projectId,policy])).rows;
    if(!pending.length)return {state:'idle'};
    const due=pending.filter(row=>!row.catalog_next_attempt_at||new Date(row.catalog_next_attempt_at)<=current);
    if(!due.length)return {state:'waiting',next_attempt_at:new Date(Math.min(...pending.map(row=>new Date(row.catalog_next_attempt_at).getTime()))).toISOString()};
    const identities=JSON.stringify(due.map(({run_id,attempt,policy_sha256})=>({run_id,attempt,policy_sha256})));
    const where="project_id=$1 AND catalog_state='pending' AND (run_id,attempt,policy_sha256) IN (SELECT run_id,attempt,policy_sha256 FROM jsonb_to_recordset($2::jsonb) AS x(run_id text,attempt text,policy_sha256 text))";
    // AIDEV-NOTE: Срок повтора сохраняется до I/O, чтобы перезапуск Activity не создавал цикл запросов.
    const lease=new Date(current.getTime()+120000).toISOString();
    await db.query("UPDATE codeworks.verified_ci SET catalog_attempts=catalog_attempts+1,catalog_next_attempt_at=$3,catalog_reason_code='CATALOG_PUBLICATION_PENDING' WHERE "+where,[projectId,identities,lease]);
    try {
      executionContext()?.signal?.throwIfAborted();
      const result=await github.publishCatalog(project);
      executionContext()?.signal?.throwIfAborted();
      if(lost)throw Error('CATALOG_GUARD_LOST');
      if(!result||!/^sha256:[0-9a-f]{64}$/.test(result.digest)||typeof result.reference!=='string')throw Error('CI_CATALOG_PUBLICATION_INVALID');
      const published={reference:result.reference,digest:result.digest};
      await db.query("UPDATE codeworks.verified_ci SET catalog_state='published',catalog_next_attempt_at=NULL,catalog_reason_code=NULL,catalog_result=$3,catalog_published_at=$4 WHERE "+where,[projectId,identities,published,stamp().toISOString()]);
      return {state:'published',published};
    }catch(error) {
      executionContext()?.signal?.throwIfAborted();
      if(lost)throw error;
      const fault=ciFailure(error),at=stamp();
      const backoff=Math.min(900000,30000*2**Math.min(5,Math.max(...due.map(row=>row.catalog_attempts))));
      const next=fault.retryAt??new Date(at.getTime()+backoff).toISOString();
      if(fault.code==='GITHUB_RATE_LIMITED')await db.query("UPDATE codeworks.execution_control SET github_retry_at=GREATEST(github_retry_at,$2::timestamptz),github_reason_code='GITHUB_RATE_LIMITED' WHERE project_id=$1",[projectId,next]);
      await db.query("UPDATE codeworks.verified_ci SET catalog_next_attempt_at=$3,catalog_reason_code=$4 WHERE "+where,[projectId,identities,next,fault.code]);
      return {state:'pending',reason_code:fault.code,next_attempt_at:next};
    }
  });}finally {
    if(locked&&!lost)await db.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[key]).catch(()=>{lost=true;});
    db.removeListener?.('error',onError);db.release(lost?new Error('CATALOG_GUARD_LOST'):undefined);
  }
}
