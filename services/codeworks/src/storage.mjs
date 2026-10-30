// ABOUTME: Хранит реестр областей и этапы Git/CI/выпуска в существующей PostgreSQL.
// ABOUTME: Короткие транзакции защищают операции проекта, а не права или процессы агента.
import { Fault } from './errors.mjs';
function session(db) {
  const one=async(sql,args)=>(await db.query(sql,args)).rows[0];
  return {
    query:(sql,args)=>db.query(sql,args),
    executionControl:id=>one('SELECT * FROM codeworks.execution_control WHERE project_id=$1',[id]),
    lifecycle:id=>one('SELECT * FROM codeworks.workflow_registry WHERE workspace_id=$1',[id]),
    uncertainWriter:id=>one("SELECT EXISTS(SELECT 1 FROM codeworks.write_calls WHERE workspace_id=$1 AND state='uncertain') AS present",[id]).then(r=>r.present),
    cleanupObligation:id=>one("SELECT * FROM codeworks.cleanup_obligations WHERE workspace_id=$1 ORDER BY (state<>'done') DESC,created_at DESC,id DESC LIMIT 1",[id]),
    releaseOperation:(id,w)=>one('SELECT * FROM codeworks.releases WHERE operation_id=$1 AND workspace_id=$2',[id,w]),
    blockers:id=>db.query("SELECT target,operation_id,state FROM codeworks.release_queue WHERE operation_id IN(SELECT id FROM codeworks.operations WHERE workspace_id=$1) AND state IN ('queued','held') ORDER BY ticket",[id]).then(r=>r.rows),
    project:id=>one('SELECT config FROM codeworks.projects WHERE id=$1',[id]).then(r=>r?.config),
    conflictingProject:p=>one("SELECT id FROM codeworks.projects WHERE id<>$1 AND (config->>'common_dir'=$2 OR config->>'workspace_root'=$3)",[p.id,p.common_dir,p.workspace_root]),
    insertProject:p=>db.query('INSERT INTO codeworks.projects(id,config) VALUES($1,$2)',[p.id,p]),
    workspace:(p,id)=>one('SELECT * FROM codeworks.workspaces WHERE project_id=$1 AND id=$2',[p,id]),
    workspaceByKey:(p,key)=>one('SELECT * FROM codeworks.workspaces WHERE project_id=$1 AND workspace_key=$2 ORDER BY (removed_at IS NULL) DESC,created_at DESC,id DESC LIMIT 1',[p,key]),
    workspaces:(p,limit=100,offset=0)=>db.query('SELECT * FROM codeworks.workspaces WHERE project_id=$1 ORDER BY created_at DESC,id DESC LIMIT $2 OFFSET $3',[p,limit,offset]).then(r=>r.rows),
    insertWorkspace:w=>db.query('INSERT INTO codeworks.workspaces(id,project_id,workspace_key,kind,base_ref,base_sha,branch,path,ownership_token,activation_state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[w.id,w.project_id,w.workspace_key,w.kind,w.base_ref,w.base_sha,w.branch,w.path,w.ownership_token,w.activation_state??'awaiting_first_write']),
    operation:(p,id)=>one('SELECT * FROM codeworks.operations WHERE project_id=$1 AND id=$2',[p,id]),
    latestOperation:id=>one('SELECT * FROM codeworks.operations WHERE workspace_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1',[id]),
    latestPreparation:id=>one("SELECT id,status FROM codeworks.operations WHERE workspace_id=$1 AND kind='prepare' AND NOT archived ORDER BY created_at DESC,id DESC LIMIT 1",[id]),
    insertOperation:o=>db.query('INSERT INTO codeworks.operations(id,project_id,workspace_id,executor_id,kind,status,step,request,result) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[o.id,o.project_id,o.workspace_id,o.executor_id,o.kind,o.status,o.step,o.request,o.result]),
    request:(p,e,key)=>one('SELECT r.payload_sha256,r.operation_id,o.workspace_id,o.archived FROM codeworks.requests r JOIN codeworks.operations o ON o.id=r.operation_id WHERE r.project_id=$1 AND r.executor_id=$2 AND r.idempotency_key=$3',[p,e,key]),
    insertRequest:r=>db.query('INSERT INTO codeworks.requests(project_id,executor_id,idempotency_key,payload_sha256,operation_id) VALUES($1,$2,$3,$4,$5)',[r.project_id,r.executor_id,r.key,r.digest,r.operation_id]),
    currentEvidence:(p,target)=>one("SELECT * FROM codeworks.deployment_evidence WHERE project_id=$1 AND target=$2 AND NOT EXISTS (SELECT 1 FROM codeworks.deployments d JOIN codeworks.operations o ON o.id=d.operation_id WHERE d.project_id=$1 AND d.target=$2 AND NOT o.archived AND d.created_at>codeworks.deployment_evidence.created_at AND (d.receipt->>'verified') IS DISTINCT FROM 'true') ORDER BY created_at DESC,id DESC LIMIT 1",[p,target]),
    activeRelease:id=>one("SELECT id FROM codeworks.operations WHERE workspace_id=$1 AND kind='release' AND NOT archived AND status IN ('pending','running','awaiting_execution','awaiting_ci','awaiting_deployment','awaiting_reconciliation')",[id]),
    latestRelease:id=>one("SELECT r.* FROM codeworks.releases r JOIN codeworks.operations o ON o.id=r.operation_id WHERE r.workspace_id=$1 AND NOT o.archived ORDER BY r.created_at DESC,r.id DESC LIMIT 1",[id]),
    failedDeployment:id=>one("SELECT d.operation_id FROM codeworks.deployments d JOIN codeworks.operations o ON o.id=d.operation_id WHERE d.operation_id=$1 AND NOT d.archived AND NOT o.archived AND o.status='failed'",[id]),
    successfulRelease:id=>one("SELECT r.* FROM codeworks.releases r JOIN codeworks.operations o ON o.id=r.operation_id WHERE r.workspace_id=$1 AND r.state='succeeded' AND NOT o.archived ORDER BY r.created_at DESC LIMIT 1",[id]),
    release:r=>db.query('INSERT INTO codeworks.releases(id,workspace_id,operation_id,target,requested_sha,state,details,retry_of) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[r.id,r.workspace_id,r.operation_id,r.target,r.requested_sha,r.state,r.details??{},r.retry_of??null]),
  };
}
/** Подключает SQL без доступа к данным других сервисов. */
export function createStore(pool) {
  return {
    pool,
    async transaction(projectId,work) {
      const db=await pool.connect();
      try{
        await db.query('BEGIN');await db.query("SET LOCAL lock_timeout='1s'");
        await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[projectId]);
        const result=await work(session(db));await db.query('COMMIT');return result;
      }catch(error){
        await db.query('ROLLBACK').catch(()=>{});
        if(error.code==='55P03')throw new Fault('BUSY');
        if(error.code==='23505')throw new Fault('CONFLICT');
        throw error;
      }finally{db.release();}
    },
    async read(_,work){const db=await pool.connect();try{return await work(session(db));}finally{db.release();}},
    async pending(limit=4){return (await pool.query("SELECT o.id,p.config->>'common_dir' AS common_dir FROM codeworks.operations o JOIN codeworks.projects p ON p.id=o.project_id WHERE NOT o.archived AND NOT EXISTS(SELECT 1 FROM codeworks.commands c WHERE c.operation_id=o.id) AND NOT EXISTS(SELECT 1 FROM codeworks.workflow_registry r WHERE r.workspace_id=o.workspace_id AND r.owner='temporal') AND o.kind IN ('prepare','sync','release','rollout','cleanup') AND (o.status IN ('pending','running') OR (o.status IN ('awaiting_ci','awaiting_deployment','awaiting_reconciliation') AND o.updated_at<now()-interval '30 seconds')) ORDER BY o.created_at LIMIT $1",[limit])).rows;},
  };
}
