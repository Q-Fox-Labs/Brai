// ABOUTME: Находит безопасные неиспользованные области и незакрытые исторические обязательства проекта.
// ABOUTME: Не удаляет ресурсы и не считает неизвестный исход записи завершённым.
import {randomUUID} from 'node:crypto';

/** Создаёт обязательство только для заведомо отклонённой записи или terminal legacy root. */
export async function reconcileProjectLedger(pool,projectId,owner,{cursor=null}={}) {
  const candidates=(await pool.query(`SELECT w.id FROM codeworks.workspaces w JOIN codeworks.workflow_registry r ON r.workspace_id=w.id
    WHERE w.project_id=$1 AND ((r.state='completed' AND r.lifecycle IN ('cancelled','removed')) OR
      (r.state='open' AND r.lifecycle='active' AND w.activation_state='awaiting_first_write' AND w.preparation_state='ready'
       AND EXISTS(SELECT 1 FROM codeworks.write_calls c WHERE c.workspace_id=w.id AND ((c.state='denied_pending' AND (c.tool_result->>'stop_event' IS NOT NULL OR c.updated_at<now()-interval '5 minutes')) OR (c.state='finished' AND c.tool_result->>'changed'='false' AND c.updated_at<now()-interval '5 minutes'))))
      ) AND NOT EXISTS(SELECT 1 FROM codeworks.cleanup_obligations o WHERE o.workspace_id=w.id)
    ORDER BY w.created_at LIMIT 32`,[projectId])).rows;
  for(const candidate of candidates){
    const db=await pool.connect();
    try{
      await db.query('BEGIN');
      const w=(await db.query('SELECT * FROM codeworks.workspaces WHERE id=$1 FOR UPDATE',[candidate.id])).rows[0];
      const r=(await db.query('SELECT * FROM codeworks.workflow_registry WHERE workspace_id=$1 FOR UPDATE',[candidate.id])).rows[0];
      if(!w||!r){await db.query('COMMIT');continue;}
      const existing=(await db.query('SELECT 1 FROM codeworks.cleanup_obligations WHERE workspace_id=$1',[w.id])).rowCount;
      const writers=(await db.query("SELECT 1 FROM codeworks.write_calls WHERE workspace_id=$1 AND state IN ('preparing','in_flight','uncertain')",[w.id])).rowCount;
      const pending=(await db.query("SELECT 1 FROM codeworks.commands WHERE workflow_id=$1 AND state<>'done'",[r.workflow_id])).rowCount;
      const unused=r.state==='open'&&r.lifecycle==='active'&&w.activation_state==='awaiting_first_write'&&w.preparation_state==='ready'&&!writers&&!pending;
      const orphan=r.state==='completed'&&['cancelled','removed'].includes(r.lifecycle);
      if(!existing&&(unused||orphan)){
        const outcome=unused?'unused':r.lifecycle==='cancelled'?'cancelled':'released';
        await db.query("INSERT INTO codeworks.cleanup_obligations(id,project_id,workspace_id,subject_key,outcome,step,state,owner_workflow_id,epoch) VALUES($1,$2,$3,$4,$5,'inspect','pending',$6,1)",[randomUUID(),projectId,w.id,'workspace:'+w.id,outcome,unused?r.workflow_id:owner]);
        if(unused)await db.query("UPDATE codeworks.workflow_registry SET state='draining',lifecycle='closing',outcome='unused',updated_at=now() WHERE workflow_id=$1",[r.workflow_id]);
      }
      await db.query('COMMIT');
    }catch(error){await db.query('ROLLBACK').catch(()=>{});throw error;}finally{db.release();}
  }
  const adopt=(await pool.query(`SELECT o.id,o.workspace_id,o.evidence,o.owner_workflow_id,o.epoch FROM codeworks.cleanup_obligations o
    LEFT JOIN codeworks.workflow_registry r ON r.workflow_id=o.owner_workflow_id
    WHERE o.project_id=$1 AND o.state IN ('pending','retry') AND (o.owner_workflow_id IS NULL OR r.state='completed')
      AND ($2::uuid IS NULL OR o.id>$2::uuid)
      AND NOT EXISTS(SELECT 1 FROM codeworks.workflow_registry live WHERE live.workspace_id=o.workspace_id AND live.lifecycle='active') ORDER BY o.id LIMIT 32`,[projectId,cursor])).rows;
  for(const candidate of adopt){
    const db=await pool.connect();
    try{
      await db.query('BEGIN');
      const workspaceId=candidate.workspace_id??candidate.evidence?.workspace?.id;
      if(!workspaceId){await db.query('COMMIT');continue;}
      await db.query('SELECT id FROM codeworks.workspaces WHERE id=$1 FOR UPDATE',[workspaceId]);
      await db.query('SELECT workflow_id FROM codeworks.workflow_registry WHERE workspace_id=$1 FOR UPDATE',[workspaceId]);
      const guard=(await db.query("SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired",['execution:workspace:'+workspaceId])).rows[0].acquired;
      if(guard)await db.query(`UPDATE codeworks.cleanup_obligations o SET owner_workflow_id=$2,epoch=epoch+1,updated_at=now()
        WHERE o.id=$1 AND o.epoch=$3 AND o.owner_workflow_id IS NOT DISTINCT FROM $4 AND o.state IN ('pending','retry')
          AND (o.owner_workflow_id IS NULL OR EXISTS(SELECT 1 FROM codeworks.workflow_registry old WHERE old.workflow_id=o.owner_workflow_id AND old.state='completed'))
          AND NOT EXISTS(SELECT 1 FROM codeworks.workflow_registry live WHERE live.workspace_id=o.workspace_id AND live.lifecycle='active')`,[candidate.id,owner,candidate.epoch,candidate.owner_workflow_id]);
      await db.query('COMMIT');
    }catch(error){await db.query('ROLLBACK').catch(()=>{});throw error;}finally{db.release();}
  }
  const item=(await pool.query("SELECT id FROM codeworks.cleanup_obligations WHERE project_id=$1 AND owner_workflow_id=$2 AND state IN ('pending','running','retry') AND (next_attempt_at IS NULL OR next_attempt_at<=now()) ORDER BY created_at LIMIT 1",[projectId,owner])).rows[0];
  return {...item,nextCursor:adopt.length===32?adopt.at(-1).id:null,hasMore:adopt.length===32};
}
