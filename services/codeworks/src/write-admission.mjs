// ABOUTME: Учитывает native вызовы записи и допуск к подготовленной области.
// ABOUTME: Не исполняет инструменты и не считает намерение доказательством записи.
import {randomUUID, createHash} from 'node:crypto';
import {Fault} from './errors.mjs';
import {canonical} from './contracts.mjs';

async function transaction(pool, work) {
  const db = await pool.connect();
  try { await db.query('BEGIN'); const value = await work(db); await db.query('COMMIT'); return value; }
  catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}

function validateNativeCompletion(call,args,executorId,proof) {
  if(!proof)return;
  const same=['project_id','session_id','turn_id','tool_use_id'].every(key=>proof[key]===args[key]&&call[key]===proof[key]);
  if(!same||proof.executor_id!==executorId||call.executor_id!==executorId||proof.write_call_id!==call.id||proof.tool_name!==call.tool_name||proof.payload_sha256!==call.payload_sha256||!call.rewritten_sha256||proof.rewritten_sha256!==call.rewritten_sha256||!call.admitted_at||!/^([a-f0-9]{64})$/.test(proof.receipt_sha256??''))throw new Fault('WRITE_CALL_MISMATCH');
  if(proof.version===3){
    const {receipt_sha256,...metadata}=proof;
    if(proof.provenance!=='executor_api'||proof.workspace_id!==call.workspace_id||proof.outcome!==args.outcome||!['success','error'].includes(proof.outcome)||!/^([a-f0-9]{64})$/.test(proof.observation_sha256??'')||createHash('sha256').update(canonical(metadata)).digest('hex')!==receipt_sha256)throw new Fault('WRITE_CALL_MISMATCH');
    if(call.state==='finished'&&(call.tool_result?.outcome!==args.outcome||call.tool_result?.executor_completion?.receipt_sha256!==receipt_sha256))throw new Fault('WRITE_CALL_MISMATCH');
    return;
  }
  if(proof.version===2){
    if(proof.workspace_id!==call.workspace_id||proof.provenance!=='operator_reviewed_nested_patch'||proof.tool_name!=='apply_patch'||proof.outcome!=='error'||args.outcome!=='error'||proof.reviewer!=='owner'||!Number.isFinite(Date.parse(proof.reviewed_at))||Date.parse(proof.reviewed_at)<Date.parse(call.admitted_at)||Object.hasOwn(proof,'exit_code')||Object.hasOwn(proof,'native_event_sha256')||!/^([a-f0-9]{64})$/.test(proof.review_manifest_sha256??''))throw new Fault('WRITE_CALL_MISMATCH');
    if(call.state==='finished'&&(call.tool_result?.outcome!=='error'||!call.tool_result.operator_completion||canonical(call.tool_result.operator_completion)!==canonical(ownerCompletionMetadata(proof))))throw new Fault('WRITE_CALL_MISMATCH');
    return;
  }
  if(proof.version!==1||!Number.isSafeInteger(proof.exit_code)||!/^([a-f0-9]{64})$/.test(proof.native_event_sha256??'')||args.outcome!==(proof.exit_code===0?'success':'error'))throw new Fault('WRITE_CALL_MISMATCH');
  if(call.state==='finished'){
    const saved=call.tool_result?.native_completion;
    if(!saved||saved.receipt_sha256!==proof.receipt_sha256||saved.native_event_sha256!==proof.native_event_sha256||saved.exit_code!==proof.exit_code||call.tool_result?.outcome!==args.outcome)throw new Fault('WRITE_CALL_MISMATCH');
  }
}

function ownerCompletionMetadata(proof){
  return {receipt_sha256:proof.receipt_sha256,provenance:proof.provenance,review_manifest_sha256:proof.review_manifest_sha256,outer_tool_use_id:proof.outer_tool_use_id,source_prefix_sha256:proof.source_prefix_sha256,source_prefix_bytes:proof.source_prefix_bytes,input_line_sha256:proof.input_line_sha256,output_line_sha256:proof.output_line_sha256,reviewer:proof.reviewer,reviewed_at:proof.reviewed_at};
}

/** Подтверждённый API/owner исход команды сильнее generic успешного возврата Bash-инструмента. */
export function terminalBashEvidence(call,executionStatus='completed') {
  const evidence=call.tool_result?.executor_completion??call.tool_result?.native_completion;
  return call.state==='finished'&&call.tool_name==='Bash'&&executionStatus==='completed'&&/^[a-f0-9]{64}$/.test(evidence?.receipt_sha256??'');
}

function validatePostProof(call,args,executorId,proof) {
  if(!proof)return;
  const {receipt_sha256,...notice}=proof;
  const same=['project_id','session_id','turn_id','tool_use_id','tool_name','outcome','input_sha256','canonical_input_sha256','execution_status'].every(key=>notice[key]===args[key]);
  const notStarted=proof.execution_status==='not_started'&&args.outcome==='error';
  const rewrittenMatches=call.completion_input_sha256?call.completion_input_sha256===proof.canonical_input_sha256:call.rewritten_sha256===proof.input_sha256;
  const inputMatches=rewrittenMatches||(notStarted&&!!call.original_input_sha256&&call.original_input_sha256===proof.canonical_input_sha256);
  if(!same||proof.executor_id!==executorId||call.executor_id!==executorId||(!notStarted&&!call.admitted_at)||!inputMatches||(proof.execution_status==='not_started'&&!notStarted)||['project_id','session_id','turn_id','tool_use_id','tool_name'].some(key=>call[key]!==proof[key])||receipt_sha256!==createHash('sha256').update(canonical(notice)).digest('hex'))throw new Fault('WRITE_CALL_MISMATCH');
  if(call.state==='finished'&&((call.tool_result?.outcome!==args.outcome&&!terminalBashEvidence(call,proof.execution_status))||(call.tool_result?.post_completion&&call.tool_result.post_completion.receipt_sha256!==receipt_sha256)))throw new Fault('WRITE_CALL_MISMATCH');
}

/** Создаёт durable учёт вызовов; prepare и Git inspection выполняются вне транзакции. */
export function createWriteAdmission(pool, {prepare, inspect, workspace}) {
  async function begin(args, executorId) {
    const row = await transaction(pool, async db => {
      // AIDEV-NOTE: Одна сессия выбирает область атомарно до обращения к внешнему prepare.
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['write-session:'+JSON.stringify([args.project_id,executorId,args.session_id])]);
      const identity=[args.project_id,executorId,args.session_id,args.turn_id,args.tool_use_id];
      const fence=(await db.query('SELECT * FROM codeworks.write_call_fences WHERE project_id=$1 AND executor_id=$2 AND session_id=$3 AND turn_id=$4 AND tool_use_id=$5',identity)).rows[0];
      if(fence){
        if(fence.tool_name!==args.tool_name||fence.original_input_sha256!==args.original_input_sha256)throw new Fault('WRITE_CALL_MISMATCH');
        throw new Fault('CONFLICT','Native invocation already ended before dispatch.');
      }
      // AIDEV-NOTE: Сначала блокируем незакреплённые вызовы: private prepare проверяет ту же строку.
      await db.query('SELECT id FROM codeworks.write_calls WHERE project_id=$1 AND executor_id=$2 AND session_id=$3 AND workspace_id IS NULL FOR UPDATE',identity.slice(0,3));
      await db.query(`UPDATE codeworks.write_calls c SET workspace_id=o.workspace_id,operation_id=o.id,updated_at=now()
        FROM codeworks.requests r JOIN codeworks.operations o ON o.id=r.operation_id
        WHERE c.project_id=$1 AND c.executor_id=$2 AND c.session_id=$3 AND c.workspace_id IS NULL
          AND r.project_id=c.project_id AND r.executor_id=c.executor_id AND r.idempotency_key=c.request_key
          AND o.project_id=c.project_id AND o.kind='prepare' AND o.workspace_id IS NOT NULL
          AND o.request->>'workspace_key'=c.workspace_key AND COALESCE(o.request->>'kind','feature')=c.kind`,identity.slice(0,3));
      // AIDEV-NOTE: Истечение относится только к вызову без принятого prepare; оно не доказывает остановку писателя.
      await db.query(`UPDATE codeworks.write_calls c SET state='denied_pending',updated_at=now()
        WHERE c.project_id=$1 AND c.executor_id=$2 AND c.session_id=$3 AND c.workspace_id IS NULL
          AND c.state='preparing' AND c.created_at<now()-interval '2 minutes'
          AND NOT EXISTS (SELECT 1 FROM codeworks.requests r WHERE r.project_id=c.project_id AND r.executor_id=c.executor_id AND r.idempotency_key=c.request_key)`,identity.slice(0,3));
      let found=(await db.query('SELECT * FROM codeworks.write_calls WHERE project_id=$1 AND executor_id=$2 AND session_id=$3 AND turn_id=$4 AND tool_use_id=$5 FOR UPDATE',identity)).rows[0];
      if (!found) {
        let key=args.workspace_key, kind=args.kind;
        if (args.workspace_id) {
          const selected=(await db.query('SELECT workspace_key,kind,removed_at FROM codeworks.workspaces WHERE project_id=$1 AND id=$2',[args.project_id,args.workspace_id])).rows[0];
          if (!selected || selected.removed_at || (key && key!==selected.workspace_key) || (kind && kind!==selected.kind)) throw new Fault('CONFLICT');
          key=selected.workspace_key;kind=selected.kind;
        }
        if (!key && !args.workspace_id) {
          const entries=(await db.query(`SELECT c.workspace_key,c.kind,c.workspace_id,w.removed_at,r.lifecycle,r.state AS workflow_state
            FROM codeworks.write_calls c LEFT JOIN codeworks.workspaces w ON w.id=c.workspace_id
            LEFT JOIN codeworks.workflow_registry r ON r.workspace_id=w.id
            WHERE c.project_id=$1 AND c.executor_id=$2 AND c.session_id=$3 AND
              ((c.workspace_id IS NULL AND c.state='preparing') OR (c.workspace_id IS NOT NULL AND w.removed_at IS NULL))`,identity.slice(0,3))).rows;
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
        const values=[randomUUID(),...identity,args.tool_name,args.payload_sha256,JSON.stringify(args.targets),key,kind,args.request_key,args.original_input_sha256??null];
        await db.query(`INSERT INTO codeworks.write_calls(id,project_id,executor_id,session_id,turn_id,tool_use_id,tool_name,payload_sha256,targets,workspace_key,kind,request_key,state,original_input_sha256)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,'preparing',$13)`,values);
        if(args.executor_thread_id)await db.query("UPDATE codeworks.write_calls SET tool_result=jsonb_build_object('executor_thread_id',$2::text) WHERE id=$1",[values[0],args.executor_thread_id]);
        found=(await db.query('SELECT * FROM codeworks.write_calls WHERE project_id=$1 AND executor_id=$2 AND session_id=$3 AND turn_id=$4 AND tool_use_id=$5 FOR UPDATE',identity)).rows[0];
      }
      if (!found || found.tool_name !== args.tool_name || found.payload_sha256 !== args.payload_sha256 || (found.original_input_sha256??null)!==(args.original_input_sha256??null) || JSON.stringify(found.targets) !== JSON.stringify(args.targets) || (args.workspace_key && found.workspace_key !== args.workspace_key) || (args.kind && found.kind !== args.kind) || found.request_key !== args.request_key) throw new Fault('WRITE_CALL_MISMATCH');
      if(found.tool_result?.executor_thread_id&&found.tool_result.executor_thread_id!==args.executor_thread_id)throw new Fault('WRITE_CALL_MISMATCH');
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
      if (locked.completion_input_sha256 && locked.completion_input_sha256 !== args.completion_input_sha256) throw new Fault('WRITE_CALL_MISMATCH');
      if (!['preparing','in_flight'].includes(locked.state)) throw new Fault('CONFLICT');
      await db.query("UPDATE codeworks.write_calls SET state='in_flight',rewritten_sha256=$2,completion_input_sha256=$3,admitted_at=COALESCE(admitted_at,now()),updated_at=now() WHERE id=$1",[call.id,args.rewritten_sha256,args.completion_input_sha256??null]);
      return {write_call_id:call.id,state:'in_flight'};
    });
  }
  /** Подтверждает Post либо уже проверенный owner receipt; не принимает доказательства из API payload. */
  async function finish(args, executorId, {completionProof,postProof,expectedWorkspaceId}={}) {
    const call = (await pool.query('SELECT * FROM codeworks.write_calls WHERE project_id=$1 AND executor_id=$2 AND session_id=$3 AND turn_id=$4 AND tool_use_id=$5',[args.project_id,executorId,args.session_id,args.turn_id,args.tool_use_id])).rows[0];
    if (!call) throw new Fault('NOT_FOUND');
    validateNativeCompletion(call,args,executorId,completionProof);
    validatePostProof(call,args,executorId,postProof);
    if(expectedWorkspaceId!==undefined&&call.workspace_id!==expectedWorkspaceId)throw Error('WRITE_CALL_BINDING_CHANGED');
    if (call.state === 'finished') return {write_call_id:call.id,state:'finished',changed:!!call.tool_result?.changed};
    if(postProof?.execution_status==='not_started'){
      return transaction(pool,async db=>{
        if(call.workspace_id){
          await db.query('SELECT id FROM codeworks.workspaces WHERE id=$1 FOR UPDATE',[call.workspace_id]);
          await db.query('SELECT workflow_id FROM codeworks.workflow_registry WHERE workspace_id=$1 FOR UPDATE',[call.workspace_id]);
        }
        const locked=(await db.query('SELECT * FROM codeworks.write_calls WHERE id=$1 AND workspace_id IS NOT DISTINCT FROM $2::uuid FOR UPDATE',[call.id,call.workspace_id])).rows[0];
        if(!locked)throw Error('WRITE_CALL_BINDING_CHANGED');
        validatePostProof(locked,args,executorId,postProof);
        if(locked.state==='finished')return {write_call_id:call.id,state:'finished',changed:!!locked.tool_result?.changed};
        if(!['preparing','denied_pending','in_flight','uncertain'].includes(locked.state))throw new Fault('CONFLICT');
        // AIDEV-NOTE: Typed native not_started доказывает отсутствие исполнения этого вызова; чужое дерево не активируем.
        const result={outcome:'error',changed:false,post_completion:{receipt_sha256:postProof.receipt_sha256,tool_name:postProof.tool_name,input_sha256:postProof.input_sha256,canonical_input_sha256:postProof.canonical_input_sha256,execution_status:'not_started'}};
        await db.query("UPDATE codeworks.write_calls SET state='finished',tool_result=$2::jsonb,finished_at=now(),updated_at=now() WHERE id=$1",[call.id,JSON.stringify(result)]);
        if(call.workspace_id)await db.query(`UPDATE codeworks.cleanup_obligations o SET state='pending',blocker=NULL,next_attempt_at=NULL,updated_at=now()
          WHERE o.workspace_id=$1 AND o.state='waiting_decision' AND o.blocker='WRITER_OUTCOME_UNKNOWN'
          AND NOT EXISTS(SELECT 1 FROM codeworks.write_calls c WHERE c.workspace_id=o.workspace_id AND c.state IN ('preparing','in_flight','uncertain'))`,[call.workspace_id]);
        return {write_call_id:call.id,state:'finished',changed:false};
      });
    }
    if (!['in_flight','uncertain'].includes(call.state) || !call.workspace_id) throw new Fault('CONFLICT');
    const found = await workspace(args.project_id,call.workspace_id);
    const current = await inspect(found.project,found.workspace);
    const changed = !!current.dirty || current.head !== found.workspace.base_sha;
    return transaction(pool, async db => {
      const w = (await db.query('SELECT * FROM codeworks.workspaces WHERE id=$1 AND project_id=$2 FOR UPDATE',[call.workspace_id,args.project_id])).rows[0];
      if (!w || w.removed_at) throw new Fault('CONFLICT');
      // AIDEV-NOTE: Общий порядок с допуском и очисткой исключает гонку последнего писателя с закрытием.
      await db.query('SELECT workflow_id FROM codeworks.workflow_registry WHERE workspace_id=$1 FOR UPDATE',[w.id]);
      await db.query("SELECT id FROM codeworks.cleanup_obligations WHERE workspace_id=$1 AND state='waiting_decision' AND blocker='WRITER_OUTCOME_UNKNOWN' FOR UPDATE",[w.id]);
      const locked = (await db.query('SELECT * FROM codeworks.write_calls WHERE id=$1 FOR UPDATE',[call.id])).rows[0];
      validateNativeCompletion(locked,args,executorId,completionProof);
      validatePostProof(locked,args,executorId,postProof);
      if (locked.state === 'finished') return {write_call_id:call.id,state:'finished',changed:!!locked.tool_result?.changed};
      if (!['in_flight','uncertain'].includes(locked.state)) throw new Fault('CONFLICT');
      if (changed) await db.query("UPDATE codeworks.workspaces SET activation_state='active',first_write_at=COALESCE(first_write_at,now()) WHERE id=$1",[w.id]);
      const toolResult={outcome:args.outcome,changed,...(completionProof?.version===3?{executor_completion:{receipt_sha256:completionProof.receipt_sha256,observation_sha256:completionProof.observation_sha256,item_type:completionProof.item_type,item_status:completionProof.item_status}}:completionProof?.version===2?{operator_completion:ownerCompletionMetadata(completionProof)}:completionProof?{native_completion:{receipt_sha256:completionProof.receipt_sha256,native_event_sha256:completionProof.native_event_sha256,exit_code:completionProof.exit_code}}:{}),...(postProof?{post_completion:{receipt_sha256:postProof.receipt_sha256,tool_name:postProof.tool_name,input_sha256:postProof.input_sha256,canonical_input_sha256:postProof.canonical_input_sha256,execution_status:postProof.execution_status??'completed'}}:{})};
      await db.query("UPDATE codeworks.write_calls SET state='finished',tool_result=$2::jsonb,finished_at=now(),updated_at=now() WHERE id=$1",[call.id,JSON.stringify(toolResult)]);
      await db.query(`UPDATE codeworks.cleanup_obligations o SET state='pending',blocker=NULL,next_attempt_at=NULL,updated_at=now()
        WHERE o.workspace_id=$1 AND o.state='waiting_decision' AND o.blocker='WRITER_OUTCOME_UNKNOWN'
          AND NOT EXISTS(SELECT 1 FROM codeworks.write_calls c WHERE c.workspace_id=o.workspace_id AND c.state IN ('preparing','in_flight','uncertain'))`,[w.id]);
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
