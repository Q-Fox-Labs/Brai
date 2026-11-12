// ABOUTME: Восстанавливает постобработку точно подтверждённого runtime и сохраняет исходные доказательства.
// ABOUTME: Использует фиксированный адаптер и прежний журнал; не устанавливает runtime и не возобновляет закрытые задачи.
import {randomUUID,createHash} from 'node:crypto';
import {readFileSync,lstatSync} from 'node:fs';
import path from 'node:path';
import {command} from './git.mjs';
import {canonical} from './ci-verifier.mjs';
import {advanceDeployment} from './deployment.mjs';
import {Fault} from './errors.mjs';
import {executionContext,withExecutionContext} from './execution-context.mjs';
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const equal=(a,b)=>JSON.stringify(canonical(JSON.parse(JSON.stringify(a))))===JSON.stringify(canonical(JSON.parse(JSON.stringify(b))));
const refuse=reason=>{throw new Fault('CONFLICT',reason);};
const reply=op=>({operation_id:op.id,deployment_id:op.request.deployment_id,status:op.status,step:op.step,result:op.result});
const terminal=op=>['succeeded','failed'].includes(op.status);

/** Читает фиксированную команду из конфигурации root; вызывающая сторона задаёт только проверенные ID и digests. */
export function createPostprocessRepairAdapter(configFile=process.env.CODEWORKS_DEPLOYMENT_CONFIG) {
  if(!configFile)return null;
  const info=lstatSync(configFile);
  if(!info.isFile()||info.isSymbolicLink()||info.uid!==0||(info.mode&0o022))throw Error('UNTRUSTED_POSTPROCESS_REPAIR_ADAPTER');
  const argv=JSON.parse(readFileSync(configFile,'utf8')).postprocess_repair_command;
  if(!Array.isArray(argv)||!argv.length||typeof argv[0]!=='string'||!path.isAbsolute(argv[0])||path.normalize(argv[0])!==argv[0]||argv[0]==='/'||argv.some(arg=>typeof arg!=='string'||arg.includes('\0')))throw Error('POSTPROCESS_REPAIR_ADAPTER_INVALID');
  const invoke=async(prefix,args)=>{
    const result=await command(argv[0],[...argv.slice(1),...prefix,...args],{timeout:120000});
    return JSON.parse(result.stdout);
  };
  const args=(deploymentId,repairId,requestKey,runtime,digest)=>{
    if(![deploymentId,repairId,requestKey].every(uuid)||!(/^[0-9a-f]{64}$/).test(runtime)||!(/^sha256:[0-9a-f]{64}$/).test(digest))throw Error('POSTPROCESS_REPAIR_IDENTITY_INVALID');
    return [deploymentId,repairId,requestKey,runtime,digest];
  };
  return {
    preflight:async id=>{if(!uuid(id))throw Error('POSTPROCESS_REPAIR_IDENTITY_INVALID');return invoke(['--preflight'],[id]);},
    invoke:(...values)=>invoke([],args(...values)),
    inspect:(...values)=>invoke(['--inspect'],args(...values)),
  };
}

/** Продолжает прежний ID ремонта по ключу повтора через порты adapter, verifierPool и checkpoint.
 * Исходную успешную квитанцию проверяет обычный advanceDeployment.
 * Потеря сессии отменяет внешнюю работу; неизвестный исход требует inspect с прежним ключом.
 */
export async function repairPostprocess(pool,projectId,request,{adapter=createPostprocessRepairAdapter(),verifierPool,checkpoint=async()=>{}}={}) {
  if(!request||Object.keys(request).sort().join(',')!=='deployment_id,expected_composition_digest,expected_runtime_sha256,request_key'||!uuid(request.deployment_id)||!uuid(request.request_key)||!(/^[0-9a-f]{64}$/).test(request.expected_runtime_sha256)||!(/^sha256:[0-9a-f]{64}$/).test(request.expected_composition_digest))throw new Fault('INVALID_ARGUMENT');
  const db=await pool.connect(),lost=new AbortController(),parent=executionContext()?.signal,locks=[];
  const signal=parent?AbortSignal.any([parent,lost.signal]):lost.signal;
  const disconnected=()=>lost.abort(new Fault('GIT_FAILED','Execution database connection lost; reconcile the admitted repair.'));
  db.on('error',disconnected);
  const checked=async stage=>{signal.throwIfAborted();await checkpoint(stage);signal.throwIfAborted();};
  const lock=async key=>{if(!(await db.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired',[key])).rows[0]?.acquired)throw new Fault('BUSY');locks.push(key);};
  const digest=createHash('sha256').update(JSON.stringify(canonical({method:'postprocess-repair',project_id:projectId,...request}))).digest('hex');
  try{return await withExecutionContext({signal},async()=>{
    await lock('repair-request:'+projectId+':'+request.request_key);
    let repair=(await db.query("SELECT o.*,r.payload_sha256 FROM codeworks.requests r JOIN codeworks.operations o ON o.id=r.operation_id WHERE r.project_id=$1 AND r.executor_id='codeworks_owner' AND r.idempotency_key=$2",[projectId,request.request_key])).rows[0];
    if(repair&&(repair.payload_sha256!==digest||repair.kind!=='repair'||repair.archived))refuse('POSTPROCESS_REPAIR_REQUEST_CONFLICT');
    if(repair&&terminal(repair))return reply(repair);
    if(!adapter)refuse('POSTPROCESS_REPAIR_ADAPTER_REQUIRED');
    const initial=(await db.query('SELECT * FROM codeworks.deployments WHERE operation_id=$1 AND project_id=$2',[request.deployment_id,projectId])).rows[0];
    if(!initial)throw new Fault('NOT_FOUND');
    const parentRelease=initial.release_operation_id?(await db.query('SELECT * FROM codeworks.releases WHERE operation_id=$1',[initial.release_operation_id])).rows[0]:null;
    if(parentRelease)await lock('execution:workspace:'+parentRelease.workspace_id);
    await lock('execution:rollout:'+request.deployment_id);
    await lock('lane:'+projectId+':'+initial.target);
    const load=async()=>{
      const deployment=(await db.query('SELECT * FROM codeworks.deployments WHERE operation_id=$1 AND project_id=$2',[request.deployment_id,projectId])).rows[0];
      const operation=(await db.query('SELECT *,updated_at::text AS updated_at_token FROM codeworks.operations WHERE id=$1',[request.deployment_id])).rows[0];
      const release=deployment?.release_operation_id?(await db.query('SELECT * FROM codeworks.releases WHERE operation_id=$1',[deployment.release_operation_id])).rows[0]:null;
      const parentOperation=release?(await db.query('SELECT *,updated_at::text AS updated_at_token FROM codeworks.operations WHERE id=$1',[release.operation_id])).rows[0]:null;
      const workspace=release?(await db.query('SELECT * FROM codeworks.workspaces WHERE id=$1 AND project_id=$2',[release.workspace_id,projectId])).rows[0]:null;
      const ledger=(await db.query(release?'SELECT * FROM codeworks.workflow_registry WHERE workspace_id=$1':'SELECT * FROM codeworks.workflow_registry WHERE operation_id=$1',[release?release.workspace_id:request.deployment_id])).rows[0];
      const lane=(await db.query("SELECT * FROM codeworks.release_queue WHERE project_id=$1 AND target=$2 AND state='held'",[projectId,deployment?.target])).rows[0];
      return {deployment,operation,parent_release:release,parent_operation:parentOperation,workspace,ledger,lane};
    };
    const eligible=state=>{
      const {deployment:d,operation:o,parent_release:r,parent_operation:p,workspace,ledger,lane}=state;
      if(!d||!o||d.archived||o.archived||o.project_id!==projectId||o.kind!=='rollout'||o.status!=='failed'||o.request.target!==d.target||o.request.commit_sha!==d.commit_sha||d.composition_digest!==request.expected_composition_digest)refuse('POSTPROCESS_REPAIR_SOURCE_CHANGED');
      if(r&&(!workspace||workspace.removed_at))refuse('POSTPROCESS_REPAIR_TASK_CLOSED');
      if(!ledger||ledger.owner!=='temporal'||ledger.state!=='open'||ledger.lifecycle!=='active'||ledger.completed_at)refuse('POSTPROCESS_REPAIR_TASK_CLOSED');
      if(lane?.operation_id!==(r?.operation_id??o.id))refuse('POSTPROCESS_REPAIR_LANE_REQUIRED');
      if(d.release_operation_id&&!r)refuse('POSTPROCESS_REPAIR_PARENT_MISSING');
      if(r){
        const leg=Object.values(r.details??{}).find(value=>value?.deployment_operation_id===o.id&&value.merge_sha===d.commit_sha);
        if(r.closed_at||r.state!=='failed'||!p||p.archived||p.project_id!==projectId||p.workspace_id!==r.workspace_id||p.status!=='failed'||p.step!=='DEPLOYMENT_FAILED'||!leg)refuse('POSTPROCESS_REPAIR_PARENT_CHANGED');
      }
      if(repair){
        const old=repair.request.original;
        if(!old||!equal({...old.deployment,receipt:null},{...d,receipt:null})||!equal(old.operation,o)||!equal(old.parent_release,r)||!equal(old.parent_operation,p))refuse('POSTPROCESS_REPAIR_SOURCE_CHANGED');
      }else if(d.receipt?.runtime_status!=='succeeded'||!['RUNBOOK_POSTPROCESSING_FAILED','RUNBOOK_COMPLETION_MISSING'].includes(d.receipt?.code))refuse('POSTPROCESS_REPAIR_RUNTIME_REQUIRED');
      return state;
    };
    let state=eligible(await load()),fresh=!repair;
    if(fresh){
      await checked('postprocess-preflight');
      const preflight=await adapter.preflight(request.deployment_id);
      if(preflight?.eligible!==true||preflight.operation_id!==request.deployment_id||preflight.runtime_sha256!==request.expected_runtime_sha256||preflight.composition_digest!==request.expected_composition_digest||preflight.target!==state.deployment.target)refuse('POSTPROCESS_REPAIR_PREFLIGHT_MISMATCH');
      state=eligible(await load());
      const original={deployment:state.deployment,operation:state.operation,parent_release:state.parent_release,parent_operation:state.parent_operation};
      const admitted={method:'postprocess-repair',...request,original},id=randomUUID();
      await db.query('BEGIN');
      try{
        await db.query("INSERT INTO codeworks.operations(id,project_id,executor_id,kind,status,step,request) VALUES($1,$2,'codeworks_owner','repair','pending','POSTPROCESS_REPAIR_ADMITTED',$3)",[id,projectId,admitted]);
        await db.query("INSERT INTO codeworks.requests(project_id,executor_id,idempotency_key,payload_sha256,operation_id) VALUES($1,'codeworks_owner',$2,$3,$4)",[projectId,request.request_key,digest,id]);
        await db.query('COMMIT');
      }catch(error){await db.query('ROLLBACK').catch(()=>{});throw error;}
      repair={id,project_id:projectId,kind:'repair',status:'pending',step:'POSTPROCESS_REPAIR_ADMITTED',request:admitted,result:null};
    }
    const save=async(status,step,result)=>{
      const row=(await db.query('UPDATE codeworks.operations SET status=$2,step=$3,result=$4,error=NULL,updated_at=now() WHERE id=$1 AND status NOT IN (\'succeeded\',\'failed\') RETURNING *',[repair.id,status,step,result])).rows[0];
      if(!row)refuse('POSTPROCESS_REPAIR_JOURNAL_CHANGED');
      repair=row;return reply(row);
    };
    await checked('postprocess-before-external');
    await save('running','POSTPROCESS_REPAIR_INSPECTING',repair.result);
    const values=[request.deployment_id,repair.id,request.request_key,request.expected_runtime_sha256,request.expected_composition_digest];
    let result;
    try{
      result=await (fresh?adapter.invoke(...values):adapter.inspect(...values));
      if(!fresh&&result?.status==='unstarted'){
        if(result.operation_id!==request.deployment_id||result.repair_id!==repair.id||result.request_key!==request.request_key)refuse('POSTPROCESS_REPAIR_PROOF_MISMATCH');
        await checked('postprocess-before-unstarted-invoke');
        eligible(await load());
        result=await adapter.invoke(...values);
      }
    }
    catch(error){
      signal.throwIfAborted();
      return save('awaiting_reconciliation','POSTPROCESS_REPAIR_RESULT_UNKNOWN',{repair_id:repair.id,code:'POSTPROCESS_REPAIR_RESULT_UNKNOWN'});
    }
    await checked('postprocess-after-external');
    if(result?.operation_id!==request.deployment_id||result.repair_id!==repair.id||result.request_key!==request.request_key )return save('failed','POSTPROCESS_REPAIR_PROOF_MISMATCH',{code:'POSTPROCESS_REPAIR_PROOF_MISMATCH'});
    if(['unknown','unavailable'].includes(result.status))return save('awaiting_reconciliation','POSTPROCESS_REPAIR_RESULT_UNKNOWN',{repair_id:repair.id,code:'POSTPROCESS_REPAIR_RESULT_UNKNOWN'});
    if(result.runtime_status!=='succeeded')return save('failed','POSTPROCESS_REPAIR_PROOF_MISMATCH',{code:'POSTPROCESS_REPAIR_PROOF_MISMATCH'});
    if(result.status==='running')return save('awaiting_reconciliation','POSTPROCESS_REPAIR_RUNNING',{repair_id:repair.id,status:'running'});
    if(result.status==='failed')return save('failed','POSTPROCESS_REPAIR_FAILED',result);
    const proof=result.postprocess_repair;
    if(repair.request.original.deployment.receipt?.receipt&&!equal(result.receipt,repair.request.original.deployment.receipt.receipt))return save('failed','POSTPROCESS_REPAIR_PROOF_MISMATCH',{code:'POSTPROCESS_REPAIR_PROOF_MISMATCH'});
    if(result.status!=='succeeded'||proof?.repair_id!==repair.id||proof.request_key!==request.request_key||proof.runtime_sha256!==request.expected_runtime_sha256||proof.composition_digest!==request.expected_composition_digest||proof.phase!=='export'||proof.status!=='succeeded')return save('failed','POSTPROCESS_REPAIR_PROOF_MISMATCH',{code:'POSTPROCESS_REPAIR_PROOF_MISMATCH'});
    const runtimeHash=createHash('sha256').update(JSON.stringify(canonical({status:'succeeded',receipt:result.receipt}))).digest('hex');
    if(runtimeHash!==request.expected_runtime_sha256)return save('failed','POSTPROCESS_REPAIR_PROOF_MISMATCH',{code:'POSTPROCESS_REPAIR_PROOF_MISMATCH'});
    await save('running','POSTPROCESS_REPAIR_VERIFYING',result);
    state=eligible(await load());
    await checked('postprocess-before-verification');
    const verifier=verifierPool?await verifierPool.connect():db;
    try{
      // AIDEV-NOTE: Отдельное verifier-соединение не должно продолжать запись после потери execution guard.
      const guardedVerifier={query:async(sql,args)=>{
        if(sql!=='ROLLBACK')signal.throwIfAborted();
        const answer=await verifier.query(sql,args);
        if(sql!=='ROLLBACK')signal.throwIfAborted();
        return answer;
      }};
      const outcome=await advanceDeployment(guardedVerifier,state.operation,async()=>{signal.throwIfAborted();return result;});
      if(outcome.status!=='succeeded')refuse('POSTPROCESS_REPAIR_VERIFICATION_FAILED');
    }finally{if(verifier!==db)verifier.release();}
    await checked('postprocess-before-resume');
    state=eligible(await load());
    await db.query('BEGIN');
    try{
      const original=repair.request.original;
      const updated=await db.query("UPDATE codeworks.operations SET status='succeeded',step='ANSIBLE_ROLLOUT_VERIFIED',result=$3,error=NULL,updated_at=now() WHERE id=$1 AND status='failed' AND updated_at=$2 RETURNING id",[request.deployment_id,original.operation.updated_at_token,{status:'succeeded',reason:'ANSIBLE_ROLLOUT_VERIFIED',postprocess_repair_id:repair.id}]);
      if(updated.rowCount!==1)refuse('POSTPROCESS_REPAIR_SOURCE_CHANGED');
      if(state.parent_release){
        const parentId=state.parent_release.operation_id;
        const parentUpdate=await db.query("UPDATE codeworks.operations SET status='awaiting_reconciliation',step='POSTPROCESS_REPAIR_VERIFIED',error=NULL,updated_at=now() WHERE id=$1 AND status='failed' AND updated_at=$2 RETURNING id",[parentId,original.parent_operation.updated_at_token]);
        if(parentUpdate.rowCount!==1)refuse('POSTPROCESS_REPAIR_PARENT_CHANGED');
        const resumed=await db.query("UPDATE codeworks.commands SET state='pending',delivered_at=NULL,retry_at=NULL,technical_attempts=0,updated_at=now() WHERE operation_id=$1 AND workflow_id=$2 AND generation=$3 RETURNING operation_id",[parentId,state.ledger.workflow_id,state.ledger.generation]);
        if(resumed.rowCount!==1)refuse('POSTPROCESS_REPAIR_COMMAND_CHANGED');
        await db.query("UPDATE codeworks.releases SET state='awaiting_execution' WHERE operation_id=$1 AND closed_at IS NULL",[parentId]);
      }else await db.query("UPDATE codeworks.release_queue SET state='released',updated_at=now() WHERE operation_id=$1 AND target=$2 AND state='held'",[request.deployment_id,state.deployment.target]);
      await db.query("UPDATE codeworks.commands SET state='done',retry_at=NULL,updated_at=now() WHERE operation_id=$1",[request.deployment_id]);
      const completed=await save('succeeded','POSTPROCESS_REPAIR_VERIFIED',result);
      await db.query('COMMIT');return completed;
    }catch(error){await db.query('ROLLBACK').catch(()=>{});throw error;}
  });}
  finally{
    if(!lost.signal.aborted)for(const key of locks.reverse())await db.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[key]).catch(()=>{lost.abort();});
    db.removeListener('error',disconnected);db.release(lost.signal.aborted?new Error('EXECUTION_CONNECTION_LOST'):undefined);
  }
}
