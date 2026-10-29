// ABOUTME: Находит безопасные неиспользованные области и незакрытые исторические обязательства проекта.
// ABOUTME: Не удаляет ресурсы и не считает неизвестный исход записи завершённым.
import {randomUUID} from 'node:crypto';

// AIDEV-NOTE: Старый prepare_pending мог ошибочно иметь stop_event; он не доказывает конец хода.
const unusedEligibility=`w.activation_state='awaiting_first_write' AND EXISTS(
  SELECT 1 FROM codeworks.write_calls c WHERE c.workspace_id=w.id AND (
    (c.state='denied_pending' AND c.tool_result->>'stop_event' IS NOT NULL
      AND COALESCE(c.tool_result->>'stop_reason','')<>'prepare_pending'
      AND (w.preparation_state='ready' OR (w.preparation_state='failed' AND EXISTS(
        SELECT 1 FROM codeworks.operations f WHERE f.workspace_id=w.id AND f.kind='prepare' AND NOT f.archived AND f.status='failed'))))
    OR (w.preparation_state='ready' AND (c.state='denied_pending' OR (c.state='finished' AND c.tool_result->>'changed'='false'))
      AND EXISTS(SELECT 1 FROM codeworks.operations p WHERE p.workspace_id=w.id AND p.kind='prepare' AND NOT p.archived AND p.status='succeeded')
      AND GREATEST(c.updated_at,(SELECT max(p.updated_at) FROM codeworks.operations p WHERE p.workspace_id=w.id AND p.kind='prepare' AND NOT p.archived AND p.status='succeeded'))<now()-interval '5 minutes')
  ))`;

// Историческая отметка удаления не доказывает фактическое отсутствие ресурсов.
// Этот отбор используется только для проверки, без права удаления или восстановления root.
const historicalRemovedEligibility=`w.removed_at IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM codeworks.workflow_registry r WHERE r.workspace_id=w.id)
  AND EXISTS (SELECT 1 FROM codeworks.releases r JOIN codeworks.operations op
    ON op.id=r.operation_id AND op.workspace_id=r.workspace_id AND op.project_id=w.project_id
    WHERE r.workspace_id=w.id AND r.state='succeeded' AND op.status='succeeded')
  AND NOT EXISTS (SELECT 1 FROM codeworks.cleanup_obligations o
    WHERE o.project_id=w.project_id AND (o.workspace_id=w.id
      OR o.subject_key='workspace:'||w.id::text
      OR o.evidence->'manifest'->>'workspace_id'=w.id::text
      OR o.evidence->'workspace'->>'id'=w.id::text))`;

/** Создаёт обязательство только для заведомо отклонённой записи или terminal legacy root. */
export async function reconcileProjectLedger(pool,projectId,owner,{cursor=null,historicalCursor=null}={}) {
  const candidates=(await pool.query(`SELECT w.id FROM codeworks.workspaces w JOIN codeworks.workflow_registry r ON r.workspace_id=w.id
    WHERE w.project_id=$1 AND ((r.state='completed' AND r.lifecycle IN ('cancelled','removed')) OR
      (r.state='open' AND r.lifecycle='active' AND ${unusedEligibility}
       AND NOT EXISTS(SELECT 1 FROM codeworks.write_calls x WHERE x.workspace_id=w.id AND x.state IN ('preparing','in_flight','uncertain'))
       AND NOT EXISTS(SELECT 1 FROM codeworks.commands q WHERE q.workflow_id=r.workflow_id AND q.state<>'done'))
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
      const eligible=r.state==='open'&&r.lifecycle==='active'&&(await db.query(`SELECT 1 FROM codeworks.workspaces w WHERE w.id=$1 AND ${unusedEligibility}`,[w.id])).rowCount;
      const unused=!!eligible&&!writers&&!pending;
      const orphan=r.state==='completed'&&['cancelled','removed'].includes(r.lifecycle);
      if(!existing&&(unused||orphan)){
        const outcome=unused?'unused':r.lifecycle==='cancelled'?'cancelled':'released';
        await db.query("INSERT INTO codeworks.cleanup_obligations(id,project_id,workspace_id,subject_key,outcome,step,state,owner_workflow_id,epoch) VALUES($1,$2,$3,$4,$5,'inspect','pending',$6,1)",[randomUUID(),projectId,w.id,'workspace:'+w.id,outcome,unused?r.workflow_id:owner]);
        if(unused)await db.query("UPDATE codeworks.workflow_registry SET state='draining',lifecycle='closing',outcome='unused',updated_at=now() WHERE workflow_id=$1",[r.workflow_id]);
      }
      await db.query('COMMIT');
    }catch(error){await db.query('ROLLBACK').catch(()=>{});throw error;}finally{db.release();}
  }
  // Removed before the Temporal cutover: only schedule observations, never a workspace root.
  const historical=(await pool.query(`SELECT w.id FROM codeworks.workspaces w WHERE w.project_id=$1 AND ($2::uuid IS NULL OR w.id>$2::uuid) AND ${historicalRemovedEligibility} ORDER BY w.id LIMIT 32`,[projectId,historicalCursor])).rows;
  for(const candidate of historical){
    const db=await pool.connect();
    try{
      await db.query('BEGIN');
      await db.query('SELECT id FROM codeworks.workspaces WHERE id=$1 FOR UPDATE',[candidate.id]);
      const guard=(await db.query("SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired",['execution:workspace:'+candidate.id])).rows[0].acquired;
      const eligible=guard&&(await db.query(`SELECT 1 FROM codeworks.workspaces w WHERE w.id=$1 AND w.project_id=$2 AND ${historicalRemovedEligibility}`,[candidate.id,projectId])).rowCount;
      if(eligible){
        const release=(await db.query("SELECT r.operation_id FROM codeworks.releases r JOIN codeworks.operations o ON o.id=r.operation_id AND o.workspace_id=r.workspace_id WHERE r.workspace_id=$1 AND o.project_id=$2 AND r.state='succeeded' AND o.status='succeeded' ORDER BY r.created_at DESC,r.operation_id LIMIT 1",[candidate.id,projectId])).rows[0];
        if(release){
          const evidence={historical_zero:{version:1,mode:'inspect_only',release_operation_id:release.operation_id,workspace_id:candidate.id}};
          await db.query("INSERT INTO codeworks.cleanup_obligations(id,project_id,workspace_id,subject_key,outcome,step,state,owner_workflow_id,epoch,evidence) VALUES($1,$2,$3,$4,'released','inspect','pending',$5,1,$6::jsonb)",[randomUUID(),projectId,candidate.id,'workspace:'+candidate.id,owner,JSON.stringify(evidence)]);
        }
      }
      await db.query('COMMIT');
    }catch(error){await db.query('ROLLBACK').catch(()=>{});throw error;}finally{db.release();}
  }
  const adopt=(await pool.query(`SELECT o.id,o.workspace_id,o.subject_key,o.evidence,o.owner_workflow_id,o.epoch FROM codeworks.cleanup_obligations o
    LEFT JOIN codeworks.workflow_registry r ON r.workflow_id=o.owner_workflow_id
    WHERE o.project_id=$1 AND o.state IN ('pending','retry') AND (o.owner_workflow_id IS NULL OR r.state='completed')
      AND ($2::uuid IS NULL OR o.id>$2::uuid)
      AND NOT EXISTS(SELECT 1 FROM codeworks.workflow_registry live WHERE live.workspace_id=o.workspace_id AND live.lifecycle='active') ORDER BY o.id LIMIT 32`,[projectId,cursor])).rows;
  for(const candidate of adopt){
    const db=await pool.connect();
    try{
      await db.query('BEGIN');
      const workspaceId=candidate.workspace_id??candidate.evidence?.workspace?.id;
      const branch=candidate.evidence?.manifest?.subject_type==='branch'&&candidate.subject_key?.startsWith('branch:')?candidate.subject_key.slice(7):null;
      if(!workspaceId&&!branch){await db.query('COMMIT');continue;}
      if(workspaceId){
        await db.query('SELECT id FROM codeworks.workspaces WHERE id=$1 FOR UPDATE',[workspaceId]);
        await db.query('SELECT workflow_id FROM codeworks.workflow_registry WHERE workspace_id=$1 FOR UPDATE',[workspaceId]);
      }
      const guardKey=workspaceId?'execution:workspace:'+workspaceId:'execution:branch:'+projectId+':'+branch;
      const guard=(await db.query("SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired",[guardKey])).rows[0].acquired;
      if(guard)await db.query(`UPDATE codeworks.cleanup_obligations o SET owner_workflow_id=$2,epoch=epoch+1,updated_at=now()
        WHERE o.id=$1 AND o.epoch=$3 AND o.owner_workflow_id IS NOT DISTINCT FROM $4 AND o.state IN ('pending','retry')
          AND (o.owner_workflow_id IS NULL OR EXISTS(SELECT 1 FROM codeworks.workflow_registry old WHERE old.workflow_id=o.owner_workflow_id AND old.state='completed'))
          AND NOT EXISTS(SELECT 1 FROM codeworks.workflow_registry live WHERE live.workspace_id=o.workspace_id AND live.lifecycle='active')`,[candidate.id,owner,candidate.epoch,candidate.owner_workflow_id]);
      await db.query('COMMIT');
    }catch(error){await db.query('ROLLBACK').catch(()=>{});throw error;}finally{db.release();}
  }
  const item=(await pool.query("SELECT id FROM codeworks.cleanup_obligations WHERE project_id=$1 AND owner_workflow_id=$2 AND state IN ('pending','running','retry') AND (next_attempt_at IS NULL OR next_attempt_at<=now()) ORDER BY created_at LIMIT 1",[projectId,owner])).rows[0];
  return {...item,nextCursor:adopt.length===32?adopt.at(-1).id:null,hasMore:adopt.length===32,nextHistoricalCursor:historical.length===32?historical.at(-1).id:null,historicalHasMore:historical.length===32};
}
