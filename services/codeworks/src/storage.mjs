// ABOUTME: Реализует минимальные предметные порты реестра через PostgreSQL.
// ABOUTME: SQL и advisory locks изолированы от ядра; только собственная БД Codeworks.
import { Fault } from './errors.mjs';
function session(db) {
  const one=async(sql,args)=>(await db.query(sql,args)).rows[0];
  return {
    project:id=>one('SELECT config FROM codeworks.projects WHERE id=$1',[id]).then(r=>r?.config),
    conflictingProject:project=>one("SELECT id FROM codeworks.projects WHERE id<>$1 AND (config->>'common_dir'=$2 OR config->>'workspace_root'=$3)",[project.id,project.common_dir,project.workspace_root]),
    insertProject:project=>db.query('INSERT INTO codeworks.projects(id,config) VALUES($1,$2)',[project.id,project]),
    workspace:(projectId,id)=>one('SELECT * FROM codeworks.workspaces WHERE project_id=$1 AND id=$2',[projectId,id]),
    workspaceByKey:(projectId,key)=>one('SELECT * FROM codeworks.workspaces WHERE project_id=$1 AND workspace_key=$2',[projectId,key]),
    insertWorkspace:w=>db.query('INSERT INTO codeworks.workspaces(id,project_id,workspace_key,element_id,kind,base_ref,base_sha,branch,path,ownership_token,writer) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[w.id,w.project_id,w.workspace_key,w.element_id,w.kind,w.base_ref,w.base_sha,w.branch,w.path,w.ownership_token,w.writer]),
    updateWriter:w=>db.query('UPDATE codeworks.workspaces SET writer=$2 WHERE id=$1',[w.id,w.writer]),
    operation:(projectId,id)=>one('SELECT * FROM codeworks.operations WHERE project_id=$1 AND id=$2',[projectId,id]),
    latestPreparation:id=>one("SELECT id,status FROM codeworks.operations WHERE workspace_id=$1 AND kind='prepare-write' ORDER BY created_at DESC,id DESC LIMIT 1",[id]),
    insertOperation:op=>db.query('INSERT INTO codeworks.operations(id,project_id,workspace_id,executor_id,actor_id,kind,status,step,request,result) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[op.id,op.project_id,op.workspace_id,op.executor_id,op.actor_id,op.kind,op.status,op.step,op.request,op.result]),
    request:(projectId,executorId,key)=>one('SELECT r.payload_sha256,r.operation_id,o.workspace_id FROM codeworks.requests r JOIN codeworks.operations o ON o.id=r.operation_id WHERE r.project_id=$1 AND r.executor_id=$2 AND r.idempotency_key=$3',[projectId,executorId,key]),
    insertRequest:r=>db.query('INSERT INTO codeworks.requests(project_id,executor_id,idempotency_key,payload_sha256,operation_id) VALUES($1,$2,$3,$4,$5)',[r.project_id,r.executor_id,r.key,r.digest,r.operation_id]),
    attach:a=>db.query('INSERT INTO codeworks.attachments(id,workspace_id,executor_id,session_id,move_id,attempt_id,writer_epoch) VALUES($1,$2,$3,$4,$5,$6,$7)',[a.id,a.workspace_id,a.executor_id,a.session_id,a.move_id,a.attempt_id,a.writer_epoch]),
    attachments:id=>db.query('SELECT * FROM codeworks.attachments WHERE workspace_id=$1 ORDER BY created_at DESC,id LIMIT 100',[id]).then(r=>r.rows),
    release:r=>db.query('INSERT INTO codeworks.releases(id,workspace_id,operation_id,target,requested_sha) VALUES($1,$2,$3,$4,$5)',[r.id,r.workspace_id,r.operation_id,r.target,r.requested_sha]),
  };
}
/** Подключает короткие транзакции и read-only чтение к предметным портам ядра. */
export function createStore(pool) {
  return {
    /** Сериализует изменения одного проекта; BUSY не означает отмену прежнего intent. */
    async transaction(projectId,work) {
      const db=await pool.connect();
      try {
        await db.query('BEGIN');await db.query("SET LOCAL lock_timeout='1s'");
        await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[projectId]);
        const result=await work(session(db));await db.query('COMMIT');return result;
      } catch(error) {
        await db.query('ROLLBACK').catch(()=>{});
        if(error.code==='55P03')throw new Fault('BUSY');
        if(error.code==='23505')throw new Fault('CONFLICT');
        throw error;
      } finally {db.release();}
    },
    /** Читает состояние без ожидания Git worker и без мутаций. */
    async read(projectId,work) {const db=await pool.connect();try{return await work(session(db));}finally{db.release();}},
    /** Читает ограниченный набор незавершённых операций для восстановления. */
    async pending(limit=4) {return (await pool.query("SELECT o.id,p.config->>'common_dir' AS common_dir FROM codeworks.operations o JOIN codeworks.projects p ON p.id=o.project_id WHERE o.kind='prepare-write' AND o.status IN ('pending','running') ORDER BY o.created_at LIMIT $1",[limit])).rows;},
  };
}
