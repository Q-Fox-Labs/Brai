// ABOUTME: Учитывает native вызовы записи и допуск к подготовленной области.
// ABOUTME: Не исполняет инструменты и не считает намерение доказательством записи.
import {randomUUID, createHash} from 'node:crypto';
import {Fault} from './errors.mjs';

async function transaction(pool, work) {
  const db = await pool.connect();
  try { await db.query('BEGIN'); const value = await work(db); await db.query('COMMIT'); return value; }
  catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}

/** Создаёт durable учёт вызовов; prepare и Git inspection выполняются вне транзакции. */
export function createWriteAdmission(pool, {prepare, inspect, workspace}) {
  async function begin(args, executorId) {
    const row = await transaction(pool, async db => {
      // AIDEV-NOTE: Одна сессия выбирает область атомарно до обращения к внешнему prepare.
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['write-session:'+JSON.stringify([args.project_id,executorId,args.session_id])]);
      const identity=[args.project_id,executorId,args.session_id,args.turn_id,args.tool_use_id];
      let found=(await db.query('SELECT * FROM codeworks.write_calls WHERE project_id=$1 AND executor_id=$2 AND session_id=$3 AND turn_id=$4 AND tool_use_id=$5 FOR UPDATE',identity)).rows[0];
      if (!found) {
        let key=args.workspace_key, kind=args.kind;
        if (!key && !args.workspace_id) {
          const entries=(await db.query(`SELECT c.workspace_key,c.kind,c.workspace_id,w.removed_at,r.lifecycle,r.state AS workflow_state
            FROM codeworks.write_calls c LEFT JOIN codeworks.workspaces w ON w.id=c.workspace_id
            LEFT JOIN codeworks.workflow_registry r ON r.workspace_id=w.id
            WHERE c.project_id=$1 AND c.executor_id=$2 AND c.session_id=$3 AND
              ((c.workspace_id IS NULL AND c.state IN ('preparing','denied_pending')) OR (c.workspace_id IS NOT NULL AND w.removed_at IS NULL))`,identity.slice(0,3))).rows;
          if (entries.some(e=>e.workspace_id && (e.lifecycle && e.lifecycle!=='active' || e.workflow_state && e.workflow_state!=='open'))) throw new Fault('CONFLICT','Previous workspace is closing.');
          const choices=new Map(entries.map(e=>[e.workspace_key+'\0'+e.kind,e]));
          const workspaceIds=new Set(entries.map(e=>e.workspace_id).filter(Boolean));
          if (choices.size>1 || workspaceIds.size>1) throw new Fault('CONFLICT','Session has multiple live workspaces.');
          const previous=[...choices.values()][0];
          if (previous) {key=previous.workspace_key;kind=previous.kind;}
          else {
            const parts=(args.targets[0] ?? 'write').split('/').filter(Boolean).slice(-2).join('-').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,38).replace(/-+$/,'') || 'write';
            const suffix=createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0,10);
            key='write-'+parts+'-'+suffix;
          }
        }
        if (!key) throw new Fault('INVALID_ARGUMENT');
        kind ??= 'feature';
        const values=[randomUUID(),...identity,args.tool_name,args.payload_sha256,JSON.stringify(args.targets),key,kind,args.request_key];
        await db.query(`INSERT INTO codeworks.write_calls(id,project_id,executor_id,session_id,turn_id,tool_use_id,tool_name,payload_sha256,targets,workspace_key,kind,request_key,state)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,'preparing')`,values);
        found=(await db.query('SELECT * FROM codeworks.write_calls WHERE project_id=$1 AND executor_id=$2 AND session_id=$3 AND turn_id=$4 AND tool_use_id=$5 FOR UPDATE',identity)).rows[0];
      }
      if (!found || found.tool_name !== args.tool_name || found.payload_sha256 !== args.payload_sha256 || JSON.stringify(found.targets) !== JSON.stringify(args.targets) || (args.workspace_key && found.workspace_key !== args.workspace_key) || (args.kind && found.kind !== args.kind) || found.request_key !== args.request_key) throw new Fault('WRITE_CALL_MISMATCH');
      return found;
    });
    if (row.workspace_id) {
      if (args.workspace_id && args.workspace_id !== row.workspace_id) throw new Fault('WRITE_CALL_MISMATCH');
      const found = await workspace(args.project_id, row.workspace_id);
      if (!found?.workspace || found.workspace.removed_at) throw new Fault('CONFLICT','Workspace was removed.');
      return {write_call_id:row.id, state:row.state, workspace_key:row.workspace_key,kind:row.kind,workspace_id:row.workspace_id, ...(row.operation_id ? {operation_id:row.operation_id} : {}), path:found.workspace.path, branch:found.workspace.branch};
    }
    if (row.state !== 'preparing') throw new Fault('CONFLICT','Write call was already stopped.');
    let accepted;
    if (args.workspace_id) {
      const found = await workspace(args.project_id,args.workspace_id);
      if (!found?.workspace || found.workspace.workspace_key !== row.workspace_key || found.workspace.kind !== row.kind || found.workspace.removed_at) throw new Fault('CONFLICT');
      accepted = {workspace_id:found.workspace.id,path:found.workspace.path,branch:found.workspace.branch};
    } else accepted = await prepare({project_id:args.project_id, workspace_key:row.workspace_key, kind:row.kind, request_key:args.request_key}, executorId, row.id);
    const updated = await pool.query(`UPDATE codeworks.write_calls SET workspace_id=$2,operation_id=$3,updated_at=now() WHERE id=$1 AND (workspace_id IS NULL OR workspace_id=$2) AND (operation_id IS NULL OR operation_id=$3) RETURNING *`, [row.id,accepted.workspace_id,accepted.operation_id ?? null]);
    if (!updated.rowCount) throw new Fault('WRITE_CALL_MISMATCH');
    return {...accepted,write_call_id:row.id,state:updated.rows[0].state,workspace_key:row.workspace_key,kind:row.kind};
  }
  async function admit(args, executorId) {
    return transaction(pool, async db => {
      const call = (await db.query('SELECT * FROM codeworks.write_calls WHERE id=$1 AND project_id=$2 AND executor_id=$3', [args.write_call_id,args.project_id,executorId])).rows[0];
      if (!call?.workspace_id) throw new Fault('NOT_FOUND');
      const w = (await db.query('SELECT * FROM codeworks.workspaces WHERE id=$1 AND project_id=$2 FOR UPDATE', [call.workspace_id,args.project_id])).rows[0];
      if (!w || w.removed_at || w.preparation_state !== 'ready') throw new Fault('PREPARE_PENDING');
      const registry = (await db.query('SELECT * FROM codeworks.workflow_registry WHERE workspace_id=$1 FOR UPDATE', [w.id])).rows[0];
      if (registry && (registry.lifecycle !== 'active' || registry.state !== 'open')) throw new Fault('CONFLICT');
      if ((await db.query("SELECT 1 FROM codeworks.cleanup_obligations WHERE workspace_id=$1 AND state<>'done' LIMIT 1",[w.id])).rowCount) throw new Fault('CLEANUP_ALREADY_STARTED');
      const locked = (await db.query('SELECT * FROM codeworks.write_calls WHERE id=$1 FOR UPDATE',[call.id])).rows[0];
      if (locked.rewritten_sha256 && locked.rewritten_sha256 !== args.rewritten_sha256) throw new Fault('WRITE_CALL_MISMATCH');
      if (!['preparing','in_flight'].includes(locked.state)) throw new Fault('CONFLICT');
      await db.query("UPDATE codeworks.write_calls SET state='in_flight',rewritten_sha256=$2,admitted_at=COALESCE(admitted_at,now()),updated_at=now() WHERE id=$1",[call.id,args.rewritten_sha256]);
      return {write_call_id:call.id,state:'in_flight'};
    });
  }
  async function finish(args, executorId) {
    const call = (await pool.query('SELECT * FROM codeworks.write_calls WHERE project_id=$1 AND executor_id=$2 AND session_id=$3 AND turn_id=$4 AND tool_use_id=$5',[args.project_id,executorId,args.session_id,args.turn_id,args.tool_use_id])).rows[0];
    if (!call) throw new Fault('NOT_FOUND');
    if (call.state === 'finished') return {write_call_id:call.id,state:'finished',changed:!!call.tool_result?.changed};
    if (!['in_flight','uncertain'].includes(call.state) || !call.workspace_id) throw new Fault('CONFLICT');
    const found = await workspace(args.project_id,call.workspace_id);
    const current = await inspect(found.project,found.workspace);
    const changed = !!current.dirty || current.head !== found.workspace.base_sha;
    return transaction(pool, async db => {
      const w = (await db.query('SELECT * FROM codeworks.workspaces WHERE id=$1 AND project_id=$2 FOR UPDATE',[call.workspace_id,args.project_id])).rows[0];
      if (!w || w.removed_at) throw new Fault('CONFLICT');
      const locked = (await db.query('SELECT * FROM codeworks.write_calls WHERE id=$1 FOR UPDATE',[call.id])).rows[0];
      if (locked.state === 'finished') return {write_call_id:call.id,state:'finished',changed:!!locked.tool_result?.changed};
      if (!['in_flight','uncertain'].includes(locked.state)) throw new Fault('CONFLICT');
      if (changed) await db.query("UPDATE codeworks.workspaces SET activation_state='active',first_write_at=COALESCE(first_write_at,now()) WHERE id=$1",[w.id]);
      await db.query("UPDATE codeworks.write_calls SET state='finished',tool_result=$2::jsonb,finished_at=now(),updated_at=now() WHERE id=$1",[call.id,JSON.stringify({outcome:args.outcome,changed})]);
      return {write_call_id:call.id,state:'finished',changed};
    });
  }
  async function stop(args, executorId) {
    return transaction(pool, async db => {
      const result = await db.query(`UPDATE codeworks.write_calls SET state=CASE WHEN state='in_flight' THEN 'uncertain' ELSE 'denied_pending' END,tool_result=CASE WHEN state IN ('preparing','denied_pending') THEN jsonb_strip_nulls(jsonb_build_object('stop_event',CASE WHEN $8::text='prepare_pending' THEN NULL ELSE $7::text END,'stop_reason',$8::text)) ELSE tool_result END,updated_at=now()
        WHERE project_id=$1 AND executor_id=$2 AND session_id=$3 AND turn_id=$4 AND state IN ('preparing','in_flight','denied_pending') AND ($5::uuid IS NULL OR (id=$5 AND state IN ('preparing','denied_pending'))) AND ($6::text IS NULL OR (tool_use_id=$6 AND state IN ('preparing','denied_pending'))) RETURNING state`,[args.project_id,executorId,args.session_id,args.turn_id,args.write_call_id ?? null,args.tool_use_id ?? null,args.event,args.reason ?? 'turn_stopped']);
      return {closed:result.rows.filter(r=>r.state==='denied_pending').length,uncertain:result.rows.filter(r=>r.state==='uncertain').length};
    });
  }
  return {begin,admit,finish,stop};
}
