// ABOUTME: Восстанавливает открытый root по доверенным Temporal и ledger checkpoints.
// ABOUTME: Операторское намерение не создаёт бизнес-операций и не воскрешает tombstone.
import {randomUUID,createHash} from 'node:crypto';
import {Connection,Client,WorkflowNotFoundError} from '@temporalio/client';
import {Worker} from '@temporalio/worker';
import proto from '@temporalio/proto';
import {canonical} from './contracts.mjs';
import {createGit,command} from './git.mjs';
import {createFlowGit} from './git-flow.mjs';
import {createGitHub} from './github.mjs';
const digest=value=>createHash('sha256').update(canonical(value)).digest('hex');
const terminal=new Set(['COMPLETED','FAILED','TIMED_OUT','TERMINATED','CANCELLED']);
const fail=code=>{throw Error(code);};

/** Принимает только идентичность root, CAS поколения и ключ повтора, без произвольного reset point. */
export function validateRepairRequest(request){
  if(!request||Object.keys(request).sort().join(',')!=='expected_generation,request_key,workflow_id'||typeof request.workflow_id!=='string'||!request.workflow_id.startsWith('codeworks/')||request.workflow_id.length>512||!Number.isSafeInteger(request.expected_generation)||request.expected_generation<1||typeof request.request_key!=='string'||!request.request_key.length||request.request_key.length>256)fail('INVALID_ARGUMENT');
  return request;
}
/** Непрерывный command ledger обязан точно соответствовать прежним операциям, а не новому поручению. */
export function verifyRepairLedger(registry,commands){
  if(registry.state==='completed'||registry.completed_at||registry.lifecycle==='removed')fail('WORKFLOW_COMPLETED');
  if(!['open','draining'].includes(registry.state)||!['active','closing','cancelled'].includes(registry.lifecycle)||commands.length!==Number(registry.next_sequence)||Number(registry.position)>Number(registry.next_sequence))fail('WORKFLOW_LEDGER_INCOMPLETE');
  for(let i=0;i<commands.length;i++){
    const c=commands[i];
    if(Number(c.sequence)!==i+1||c.workflow_id!==registry.workflow_id||(c.state==='pending'?Number(c.generation)!==Number(registry.generation):Number(c.generation)>Number(registry.generation))||c.operation_project_id!==registry.project_id||c.operation_workspace_id!==registry.workspace_id||c.archived||c.kind!==c.operation_kind||canonical(c.admitted_request)!==canonical(c.operation_request)||!['pending','done'].includes(c.state)||(c.state==='done'&&!['succeeded','failed'].includes(c.operation_status)))fail('WORKFLOW_LEDGER_INCOMPLETE');
  }
  return {command_count:commands.length,ledger_sha256:digest(commands)};
}

/** Доверенный CLI удерживает execution guard до сверки и записи нового run; неизвестный ответ повторяется тем же ключом. */
export async function repairWorkflow(pool,projectId,request,ports){
  validateRepairRequest(request);
  if(!ports?.assertOwner||!ports.inspectTemporal||!ports.inspectExternal||!ports.replay||!ports.reset||!ports.start||!ports.historyDigest)fail('REPAIR_PORTS_REQUIRED');
  await ports.assertOwner();
  const db=await pool.connect();let locked=false,lost=false,operation;
  const onError=()=>{lost=true;};db.on('error',onError);
  const alive=()=>{if(lost)fail('EXECUTION_GUARD_LOST');};
  let guard;
  const transact=async work=>{await db.query('BEGIN');try{const value=await work();await db.query('COMMIT');return value;}catch(error){await db.query('ROLLBACK').catch(()=>{});throw error;}};
  try{
    const control=(await db.query("SELECT * FROM codeworks.execution_control WHERE project_id=$1 AND owner='temporal'",[projectId])).rows[0];
    const project=(await db.query('SELECT config FROM codeworks.projects WHERE id=$1',[projectId])).rows[0]?.config;
    if(!control||control.mutations_paused||!project||!ports.allowedRepositories?.includes(project.repo_path))fail('REPAIR_PROJECT_FORBIDDEN');
    let registry=(await db.query('SELECT * FROM codeworks.workflow_registry WHERE workflow_id=$1 AND project_id=$2 AND owner=\'temporal\'',[request.workflow_id,projectId])).rows[0];
    if(!registry)fail('WORKFLOW_NOT_REGISTERED');
    guard=registry.workspace_id?'execution:workspace:'+registry.workspace_id:'execution:rollout:'+registry.operation_id;
    locked=!!(await db.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired',[guard])).rows[0]?.acquired;
    if(!locked)fail('EXECUTION_BUSY');
    const payload={project_id:projectId,method:'workflow-repair',workflow_id:request.workflow_id,expected_generation:request.expected_generation},payloadHash=digest(payload);
    operation=await transact(async()=>{
      await db.query('SELECT workflow_id FROM codeworks.workflow_registry WHERE workflow_id=$1 FOR UPDATE',[request.workflow_id]);
      registry=(await db.query('SELECT * FROM codeworks.workflow_registry WHERE workflow_id=$1',[request.workflow_id])).rows[0];
      const prior=(await db.query('SELECT o.*,r.payload_sha256 FROM codeworks.requests r JOIN codeworks.operations o ON o.id=r.operation_id WHERE r.project_id=$1 AND r.executor_id=\'codeworks_owner\' AND r.idempotency_key=$2 FOR UPDATE OF o',[projectId,request.request_key])).rows[0];
      if(prior){if(prior.payload_sha256!==payloadHash||prior.kind!=='repair')fail('REQUEST_KEY_CONFLICT');return prior;}
      if(registry.state==='completed'||registry.completed_at||registry.lifecycle==='removed')fail('WORKFLOW_COMPLETED');
      if(Number(registry.generation)!==request.expected_generation)fail('WORKFLOW_GENERATION_CHANGED');
      const id=randomUUID(),intent={...payload,request_key:request.request_key};
      await db.query("INSERT INTO codeworks.operations(id,project_id,workspace_id,executor_id,kind,status,step,request,result) VALUES($1,$2,NULL,'codeworks_owner','repair','pending','inspect',$3::jsonb,'{}')",[id,projectId,JSON.stringify(intent)]);
      await db.query("INSERT INTO codeworks.requests(project_id,executor_id,idempotency_key,payload_sha256,operation_id) VALUES($1,'codeworks_owner',$2,$3,$4)",[projectId,request.request_key,payloadHash,id]);
      return {id,status:'pending',result:{}};
    });
    if(operation.status==='succeeded')return {operation_id:operation.id,...operation.result,duplicate:true};
    if(operation.status==='failed')fail(operation.error?.code??'WORKFLOW_REPAIR_REFUSED');
    if(registry.state==='completed'||registry.completed_at||registry.lifecycle==='removed')fail('WORKFLOW_COMPLETED');
    let plan=operation.result?.plan;
    if(!plan){
      if(Number(registry.generation)!==request.expected_generation)fail('WORKFLOW_GENERATION_CHANGED');
      const commands=(await db.query(`SELECT c.*,o.project_id AS operation_project_id,o.workspace_id AS operation_workspace_id,o.kind AS operation_kind,
        o.status AS operation_status,o.request AS operation_request,o.step AS operation_step,o.result AS operation_result,o.archived
        FROM codeworks.commands c JOIN codeworks.operations o ON o.id=c.operation_id WHERE c.workflow_id=$1 ORDER BY c.sequence`,[registry.workflow_id])).rows;
      const ledger=verifyRepairLedger(registry,commands);
      const writer=(await db.query("SELECT 1 FROM codeworks.write_calls WHERE workspace_id=$1 AND state IN ('preparing','in_flight','uncertain') LIMIT 1",[registry.workspace_id])).rowCount;
      if(writer)fail('WRITER_OUTCOME_UNKNOWN');
      const observation=await ports.inspectTemporal(registry.workflow_id);alive();
      if(observation.status==='RUNNING')fail('WORKFLOW_RUNNING');
      if(observation.status!=='NOT_FOUND'&&!terminal.has(observation.status))fail('WORKFLOW_TERMINAL_UNSUPPORTED');
      if(observation.status==='NOT_FOUND'&&observation.authenticNotFound!==true)fail('TEMPORAL_NOT_FOUND_UNVERIFIED');
      const external=await ports.inspectExternal(db,project,registry,commands);alive();
      if(external?.complete!==true)fail(external?.reason_code??'WORKFLOW_CHECKPOINTS_INCOMPLETE');
      let eventId=null;
      if(observation.status!=='NOT_FOUND'){
        if(!observation.runId||!observation.history?.events?.length)fail('WORKFLOW_HISTORY_REQUIRED');
        const replay=await ports.replay(observation.history,registry.workflow_id);alive();
        if(replay?.verified!==true)fail('WORKFLOW_REPLAY_REQUIRED');
        const events=observation.history.events.filter(event=>event.workflowTaskCompletedEventAttributes);
        eventId=events.at(-1)?.eventId?.toString();
        if(!eventId||!/^\d+$/.test(eventId))fail('WORKFLOW_RESET_POINT_REQUIRED');
      }
      plan={action:eventId?'reset':'restart',source_run_id:observation.runId??null,reset_event_id:eventId,
        generation:request.expected_generation+(eventId?0:1),ledger,external_sha256:digest(external),
        history_sha256:observation.history?ports.historyDigest(observation.history):null};
      await transact(async()=>{
        const result=await db.query("UPDATE codeworks.workflow_registry SET generation=$3,execution_run_id=$4,executor_state='repairing',blocked_reason='OWNER_REPAIR',updated_at=now() WHERE workflow_id=$1 AND generation=$2 AND state<>'completed' AND completed_at IS NULL AND lifecycle<>'removed' AND next_sequence=$5 AND position=$6 RETURNING workflow_id",[registry.workflow_id,request.expected_generation,plan.generation,'repair:'+operation.id,registry.next_sequence,registry.position]);
        if(!result.rowCount)fail('WORKFLOW_GENERATION_CHANGED');
        if(plan.action==='restart')await db.query("UPDATE codeworks.commands SET generation=$2,delivered_at=NULL,updated_at=now() WHERE workflow_id=$1 AND state='pending'",[registry.workflow_id,plan.generation]);
        await db.query("UPDATE codeworks.operations SET status='running',step='execute',result=$2::jsonb,updated_at=now() WHERE id=$1",[operation.id,JSON.stringify({plan})]);
      });
    }else if(Number(registry.generation)!==plan.generation||registry.execution_run_id!=='repair:'+operation.id)fail('WORKFLOW_GENERATION_CHANGED');
    alive();
    const started=plan.action==='reset'
      ?await ports.reset({workflowId:registry.workflow_id,runId:plan.source_run_id,eventId:plan.reset_event_id,requestId:operation.id})
      :await ports.start({workflowId:registry.workflow_id,generation:plan.generation,requestId:operation.id});
    alive();if(typeof started?.runId!=='string'||!started.runId.length)fail('WORKFLOW_RUN_REQUIRED');
    const result={plan,workflow_id:registry.workflow_id,generation:plan.generation,run_id:started.runId};
    await transact(async()=>{
      const updated=await db.query("UPDATE codeworks.workflow_registry SET execution_run_id=$3,started_at=now(),executor_state='waiting',blocked_reason=NULL,updated_at=now() WHERE workflow_id=$1 AND generation=$2 AND execution_run_id=$4 AND state<>'completed' AND completed_at IS NULL RETURNING workflow_id",[registry.workflow_id,plan.generation,started.runId,'repair:'+operation.id]);
      if(!updated.rowCount)fail('WORKFLOW_GENERATION_CHANGED');
      await db.query("UPDATE codeworks.operations SET status='succeeded',step='done',result=$2::jsonb,error=NULL,updated_at=now() WHERE id=$1",[operation.id,JSON.stringify(result)]);
    });
    return {operation_id:operation.id,...result,duplicate:false};
  }catch(error){
    const refused=['WORKFLOW_COMPLETED','WORKFLOW_GENERATION_CHANGED','WORKFLOW_RUNNING','WORKFLOW_TERMINAL_UNSUPPORTED','TEMPORAL_NOT_FOUND_UNVERIFIED','WORKFLOW_LEDGER_INCOMPLETE','WRITER_OUTCOME_UNKNOWN','WORKFLOW_HISTORY_REQUIRED','WORKFLOW_REPLAY_REQUIRED','WORKFLOW_RESET_POINT_REQUIRED','WORKFLOW_CHECKPOINTS_INCOMPLETE','EXTERNAL_EFFECT_UNKNOWN','EXTERNAL_CHECKPOINT_CHANGED','ROLLOUT_RESULT_UNKNOWN'].includes(error.message);
    if(operation?.id&&!lost)await db.query("UPDATE codeworks.operations SET status=CASE WHEN step='execute' OR NOT $3::boolean THEN 'awaiting_reconciliation' ELSE 'failed' END,error=jsonb_build_object('code',$2::text),updated_at=now() WHERE id=$1 AND status<>'succeeded'",[operation.id,/^[A-Z_]+$/.test(error.message)?error.message:'WORKFLOW_REPAIR_UNAVAILABLE',refused]).catch(()=>{});
    throw error;
  }finally{
    if(locked&&!lost)await db.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[guard]).catch(()=>{});
    db.removeListener('error',onError);db.release(lost?Error('EXECUTION_GUARD_LOST'):undefined);
  }
}

/** Проверяет только имеющиеся immutable объекты и свежий remote ref; fetch требует отдельного project lock. */
export async function verifyRepairMerge(project,leg,{flowGit=createFlowGit(),run=command}={}){
  if(!['dev','main'].includes(leg?.target)||!['merge_sha','target_sha','head'].every(key=>/^[0-9a-f]{40}$/.test(leg?.[key]??'')))return false;
  const current=await flowGit.remote(project,leg.target);
  if(!current)return false;
  const git=(args)=>run('git',['-C',project.repo_path,...args],{allowFailure:true});
  for(const sha of [leg.merge_sha,current])if((await git(['cat-file','-e',sha+'^{commit}'])).code!==0)return false;
  const parents=await git(['rev-list','--parents','-n','1',leg.merge_sha]);
  if(parents.code!==0||parents.stdout.trim()!==[leg.merge_sha,leg.target_sha,leg.head].join(' '))return false;
  if((await git(['merge-base','--is-ancestor',leg.merge_sha,current])).code!==0)return false;
  // AIDEV-NOTE: Новый remote ref после локального чтения не входит в проверенный checkpoint.
  return await flowGit.remote(project,leg.target)===current;
}

/** Сверяет известные внешние checkpoints; неоднозначные старые эффекты требуют отдельного штатного восстановления. */
export async function inspectRepairCheckpoints(db,project,registry,commands,{git=createGit(),flowGit=createFlowGit(),github=createGitHub()}={}){
  let resources=null;
  if(registry.workspace_id){
    const workspace=(await db.query('SELECT * FROM codeworks.workspaces WHERE id=$1',[registry.workspace_id])).rows[0];
    if(!workspace||workspace.removed_at)return {complete:false,reason_code:'WORKFLOW_COMPLETED'};
    resources=await git.inspectResources(project,workspace);
    if((resources.ownership.oid&&!resources.ownership.matches)||(resources.branch.oid&&!resources.ownership.matches)||(resources.worktree.pathExists&&(!resources.worktree.owned||!resources.worktree.registered))||(workspace.preparation_state==='ready'&&(!resources.branch.oid||!resources.ownership.matches||!resources.worktree.pathExists)))return {complete:false,reason_code:'EXTERNAL_CHECKPOINT_CHANGED'};
  }
  const checkpoints=[];
  for(const c of commands){
    if(c.kind==='release'){
      const release=(await db.query('SELECT * FROM codeworks.releases WHERE operation_id=$1',[c.operation_id])).rows[0];
      if(!release)return {complete:false,reason_code:'WORKFLOW_CHECKPOINTS_INCOMPLETE'};
      for(const leg of [release.details.primary,release.details.backport].filter(Boolean)){
        if((leg.pr_attempted&&!leg.pr_number)||(leg.merge_push_attempted&&!leg.merged))return {complete:false,reason_code:'EXTERNAL_EFFECT_UNKNOWN'};
        if(leg.pr_number){const pr=await github.get(project,leg.pr_number);if(!pr||leg.merged&&(!pr.merged||pr.merge_commit_sha!==leg.merge_sha))return {complete:false,reason_code:'EXTERNAL_CHECKPOINT_CHANGED'};}
        if(leg.merged&&!await verifyRepairMerge(project,leg,{flowGit}))return {complete:false,reason_code:'EXTERNAL_CHECKPOINT_CHANGED'};
        if(leg.deployment_operation_id){
          const d=(await db.query('SELECT o.status,d.receipt FROM codeworks.operations o JOIN codeworks.deployments d ON d.operation_id=o.id WHERE o.id=$1',[leg.deployment_operation_id])).rows[0];
          if(!d||!['succeeded','failed'].includes(d.status)||(d.status==='succeeded'&&d.receipt?.verified!==true)||(d.status==='failed'&&d.receipt?.status!=='failed'))return {complete:false,reason_code:'ROLLOUT_RESULT_UNKNOWN'};
        }
      }
      checkpoints.push({operation_id:c.operation_id,release_sha256:digest(release)});
    }else if(c.kind==='rollout'){
      const d=(await db.query('SELECT * FROM codeworks.deployments WHERE operation_id=$1',[c.operation_id])).rows[0];
      if(!d||c.operation_status!=='pending'&&(!['succeeded','failed'].includes(c.operation_status)||!d.receipt))return {complete:false,reason_code:'ROLLOUT_RESULT_UNKNOWN'};
      checkpoints.push({operation_id:c.operation_id,deployment_sha256:digest(d)});
    }else if(!['prepare','sync','cleanup','release.close','workspace.cancel','workspace.transfer'].includes(c.kind))return {complete:false,reason_code:'WORKFLOW_CHECKPOINTS_INCOMPLETE'};
  }
  return {complete:true,resources,checkpoints};
}

/** Настоящие SDK ошибки отличают отсутствие retention от недоступного Temporal; reset point принимает только ядро. */
export async function createNativeRepairPorts({address,namespace,taskQueue,bundlePath,allowedRepositories,continueAfter=500,...adapters}){
  if(!address||!namespace||!taskQueue||!bundlePath)fail('TEMPORAL_CONFIGURATION_REQUIRED');
  const connection=await Connection.connect({address,connectTimeout:'5 seconds'}),client=new Client({connection,namespace});
  return {
    allowedRepositories,
    assertOwner:async()=>{if(process.geteuid?.()!==0)fail('OWNER_REQUIRED');},
    inspectTemporal:async workflowId=>{
      try{const handle=client.workflow.getHandle(workflowId),d=await handle.describe();
        return {status:d.status.name,runId:d.runId,...(terminal.has(d.status.name)?{history:await client.workflow.getHandle(workflowId,d.runId).fetchHistory()}: {})};
      }catch(error){if(error instanceof WorkflowNotFoundError)return {status:'NOT_FOUND',authenticNotFound:true};throw error;}
    },
    historyDigest:history=>digest(JSON.parse(JSON.stringify(history))),
    replay:async(history,id)=>{await Worker.runReplayHistory({workflowBundle:{codePath:bundlePath}},history,id);return {verified:true};},
    inspectExternal:(db,project,registry,commands)=>inspectRepairCheckpoints(db,project,registry,commands,adapters),
    reset:async({workflowId,runId,eventId,requestId})=>client.workflowService.resetWorkflowExecution(proto.temporal.api.workflowservice.v1.ResetWorkflowExecutionRequest.fromObject({namespace,workflowExecution:{workflowId,runId},workflowTaskFinishEventId:eventId,requestId,reason:'Codeworks owner ledger repair'})),
    start:async({workflowId,generation})=>{
      try{const handle=await client.workflow.start('codeworksWorkspace',{workflowId,taskQueue,args:[{generation,position:0,continueAfter}],workflowIdReusePolicy:'REJECT_DUPLICATE'});return {runId:handle.firstExecutionRunId};}
      catch(error){
        // AIDEV-NOTE: Потерянный ответ start не создаёт новый root; принимаем только его точные аргументы.
        if(error.name!=='WorkflowExecutionAlreadyStartedError')throw error;
        const handle=client.workflow.getHandle(workflowId),description=await handle.describe(),history=await handle.fetchHistory();
        const input=history.events?.[0]?.workflowExecutionStartedEventAttributes?.input?.payloads?.[0];
        let state;try{state=JSON.parse(Buffer.from(input.data).toString());}catch{fail('WORKFLOW_START_CONFLICT');}
        if(description.status.name!=='RUNNING'||description.type!=='codeworksWorkspace'||state.generation!==generation)fail('WORKFLOW_START_CONFLICT');
        return {runId:description.runId};
      }
    },
    close:()=>connection.close(),
  };
}
