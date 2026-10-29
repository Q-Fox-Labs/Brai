// ABOUTME: Соединяет transactional outbox, Temporal worker и проверенные проходы Activities.
// ABOUTME: Временная потеря Temporal не останавливает NATS API и не теряет сохранённые команды.
import {Connection,Client,WorkflowExecutionAlreadyStartedError} from '@temporalio/client';
import {NativeConnection,Worker} from '@temporalio/worker';
import {Pool} from 'pg';
import {Context} from '@temporalio/activity';
import {fileURLToPath} from 'node:url';
import {authorizeCommand} from './lifecycle.mjs';
import {runOperation,runCleanupObligation} from './worker.mjs';
import {createActivityGit} from './git-steps.mjs';
import {withExecutionContext} from './execution-context.mjs';
import {createCodeIndex} from './code-index.mjs';
import {reconcileProjectLedger} from './reconciler.mjs';
import {processProjectCompletions} from './completion-inbox.mjs';
import {verifyDisposition} from './disposition.mjs';
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
/** Создаёт Activities; identity берётся из SDK, а не из переданного пользователем payload. */
export function createActivities(pool,{allowedRepositories,execute=runOperation,adapters=createActivityGit(),codeIndex=createCodeIndex(pool),verifyTransfer=verifyDisposition,completionSpoolDirectory=process.env.CODEWORKS_COMPLETION_SPOOL,identity=()=>{const info=Context.current().info;if(!['codeworksWorkspace','codeworksProjectReconciler'].includes(info.workflowType))throw Error('ADMITTED_WORKFLOW_TYPE_REQUIRED');return info.workflowExecution.workflowId;}}={}) {
  const session=async work=>{const db=await pool.connect();try{return await work(db,identity());}finally{db.release();}};
  const registry=async(db,id,generation)=>{
    const r=(await db.query("SELECT * FROM codeworks.workflow_registry WHERE workflow_id=$1 AND generation=$2 AND owner='temporal'",[id,generation])).rows[0];
    if(!r)throw Error('WORKFLOW_OWNER_REQUIRED');return r;
  };
  const executeCommand=(expectedKind,prepareStep)=>async(operationId,generation)=>{
    const id=identity();let heartbeat;
    let context;try{context=Context.current();}catch{/* Только явный тестовый identity работает без SDK context. */}
    const checkpoint=async()=>{context?.cancellationSignal.throwIfAborted();};
    try{
      try{const context=Context.current();context.heartbeat({operation_id:operationId});heartbeat=setInterval(()=>context.heartbeat({operation_id:operationId}),2000);heartbeat.unref();}catch{/* Явный identity доступен из изолированных тестов. */}
      await withExecutionContext({signal:context?.cancellationSignal},()=>execute(pool,operationId,adapters.git,{...adapters,codeIndex,allowedRepositories,verifyTransfer,workflowId:id,generation,scoped:true,expectedKind,prepareStep,checkpoint}));
      return await session(async db=>{
        await authorizeCommand(db,operationId,id,generation);
        const o=(await db.query('SELECT o.status,o.step,o.error,w.preparation_state FROM codeworks.operations o LEFT JOIN codeworks.workspaces w ON w.id=o.workspace_id WHERE o.id=$1',[operationId])).rows[0];
        await db.query("UPDATE codeworks.commands SET state=CASE WHEN $2 IN ('succeeded','failed') THEN 'done' ELSE state END,technical_attempts=0,retry_at=NULL,updated_at=now() WHERE operation_id=$1",[operationId,o.status]);
        await db.query("UPDATE codeworks.workflow_registry SET last_stage=$2,blocked_reason=$3,executor_state='waiting',updated_at=now() WHERE workflow_id=$1",[id,o.step,o.status==='succeeded'?null:o.error?.code??o.step]);
        return {status:o.status,preparation_state:o.preparation_state};
      });
    }finally{if(heartbeat)clearInterval(heartbeat);}
  };
  return {
    /** Проектный singleton сверяет ledger, а затем исполняет только собственную обязанность. */
    reconcileProject:async (projectId,cursor=null,historicalCursor=null)=>{
      const id=identity();
      const control=(await pool.query("SELECT instance_id FROM codeworks.execution_control WHERE project_id=$1 AND owner='temporal'",[projectId])).rows[0];
      if(!control||id!==`codeworks/${control.instance_id}/${projectId}/reconciler`)throw Error('RECONCILER_OWNER_REQUIRED');
      await processProjectCompletions(pool,projectId,{allowedRepositories,git:adapters.git,spoolDirectory:completionSpoolDirectory});
      const item=await reconcileProjectLedger(pool,projectId,id,{cursor,historicalCursor});
      const cursors={nextCursor:item.nextCursor,hasMore:item.hasMore,nextHistoricalCursor:item.nextHistoricalCursor,historicalHasMore:item.historicalHasMore};
      if(!item.id)return cursors;
      let context;try{context=Context.current();}catch{}
      const beat=setInterval(()=>context?.heartbeat({obligation_id:item.id}),2000);beat.unref();
      try{const result=await withExecutionContext({signal:context?.cancellationSignal},()=>runCleanupObligation(pool,item.id,id,{git:adapters.git,flowGit:adapters.flowGit,codeIndex,allowedRepositories,verifyTransfer,checkpoint:async()=>context?.cancellationSignal.throwIfAborted()}));
        const ready=!!result&&(await pool.query("SELECT 1 FROM codeworks.cleanup_obligations WHERE project_id=$1 AND owner_workflow_id=$2 AND state IN ('pending','running','retry') AND (next_attempt_at IS NULL OR next_attempt_at<=now()) LIMIT 1",[projectId,id])).rowCount>0;
        return {...result,...cursors,ready};}
      catch(error){
        await pool.query("UPDATE codeworks.cleanup_obligations SET state='retry',attempts=attempts+1,next_attempt_at=now()+interval '60 seconds',blocker='TECHNICAL_RETRY',updated_at=now() WHERE id=$1 AND owner_workflow_id=$2 AND state IN ('pending','running','retry')",[item.id,id]);
        throw error;
      }finally{clearInterval(beat);}
    },
    /** Продвигает только обязанность, закреплённую за текущим root. */
    advanceCleanupObligation:async generation=>{
      const item=await session(async(db,id)=>{
        const r=await registry(db,id,generation);
        return (await db.query("SELECT id FROM codeworks.cleanup_obligations WHERE workspace_id=$1 AND owner_workflow_id=$2 AND state IN ('pending','running','retry') AND (next_attempt_at IS NULL OR next_attempt_at<=now()) ORDER BY created_at LIMIT 1",[r.workspace_id,id])).rows[0];
      });
      if(!item)return;
      const id=identity();let context;try{context=Context.current();}catch{}
      const beat=setInterval(()=>context?.heartbeat({obligation_id:item.id}),2000);beat.unref();
      try{return await withExecutionContext({signal:context?.cancellationSignal},()=>runCleanupObligation(pool,item.id,id,{git:adapters.git,flowGit:adapters.flowGit,codeIndex,allowedRepositories,verifyTransfer,checkpoint:async()=>context?.cancellationSignal.throwIfAborted()}));}
      finally{clearInterval(beat);}
    },
    /** Ограниченные попытки SDK образуют повторяемые durable раунды. */
    deferCleanupObligation:generation=>session(async(db,id)=>{
      const r=await registry(db,id,generation);
      await db.query("UPDATE codeworks.cleanup_obligations SET state='retry',attempts=attempts+1,next_attempt_at=now()+interval '60 seconds',blocker='TECHNICAL_RETRY',updated_at=now() WHERE workspace_id=$1 AND owner_workflow_id=$2 AND state IN ('pending','running','retry')",[r.workspace_id,id]);
    }),
    /** Фоновый проход не входит в ledger команд и не переводит выпуск в reconciliation. */
    maintainIndex:async generation=>{
      const item=await session(async(db,id)=>{
        const r=await registry(db,id,generation);
        if(r.state==='completed'||r.lifecycle!=='active'||!r.workspace_id)return null;
        if((await db.query("SELECT 1 FROM codeworks.commands WHERE workflow_id=$1 AND kind IN ('cleanup','workspace.cancel') AND state<>'done' LIMIT 1",[id])).rowCount)return null;
        const w=(await db.query('SELECT * FROM codeworks.workspaces WHERE id=$1',[r.workspace_id])).rows[0];
        if(!w||w.removed_at||w.preparation_state!=='ready'||w.activation_state==='awaiting_first_write')return null;
        const p=(await db.query('SELECT config FROM codeworks.projects WHERE id=$1',[w.project_id])).rows[0]?.config;
        if(!p||!allowedRepositories.includes(p.repo_path))throw Error('INDEX_PROJECT_FORBIDDEN');
        return {project:p,workspace:w};
      });
      if(!item)return;
      let context;try{context=Context.current();}catch{/* Только fixture identity. */}
      const beat=setInterval(()=>context?.heartbeat({stage:'index-maintenance'}),2000);beat.unref();
      try{await withExecutionContext({signal:context?.cancellationSignal},async()=>{
        await adapters.git.inspect(item.project,item.workspace);
        await codeIndex.maintain(item.project,item.workspace);
      });}finally{clearInterval(beat);}
    },
    /** Загружает ограниченную порцию в порядке БД; в историю не попадают credentials и параметры адаптеров. */
    loadCommands:generation=>session(async(db,id)=>{
      const r=await registry(db,id,generation);
      if(r.state==='completed')return {completed:true,commands:[]};
      await db.query("UPDATE codeworks.workflow_registry SET executor_state='running',updated_at=now() WHERE workflow_id=$1",[id]);
      const release=r.workspace_id?(await db.query('SELECT operation_id,requested_sha,details FROM codeworks.releases WHERE workspace_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1',[r.workspace_id])).rows[0]:null;
      const checkpoint={workflow_id:id,workspace_id:r.workspace_id,rollout_operation_id:r.operation_id,position:Number(r.position),...(release?{release_operation_id:release.operation_id,sha:release.requested_sha,evidence_ids:[release.details.primary,release.details.backport].filter(Boolean).flatMap(leg=>leg.deployment_evidence_id?[leg.deployment_evidence_id]:[])}:{})};
      return {completed:false,checkpoint,closing:r.lifecycle==='closing',commands:(await db.query("SELECT operation_id,sequence,kind FROM codeworks.commands WHERE workflow_id=$1 AND generation=$2 AND state='pending' AND (retry_at IS NULL OR retry_at<=now()) AND NOT(kind='release' AND EXISTS(SELECT 1 FROM codeworks.commands control WHERE control.workflow_id=codeworks.commands.workflow_id AND control.state<>'done' AND ((control.kind='release.close' AND control.admitted_request->>'release_operation_id'=codeworks.commands.operation_id::text) OR control.kind IN ('workspace.cancel','workspace.transfer')))) ORDER BY sequence LIMIT 32",[id,generation])).rows};
    }),
    // AIDEV-NOTE: Имя executeCommand остаётся для Activity, уже записанных в старых историях.
    executeCommand:executeCommand(),
    prepareBranch:executeCommand('prepare','branch'),
    prepareCheckout:executeCommand('prepare','checkout'),
    prepareDependencies:executeCommand('prepare','dependencies'),
    confirmWorkspace:executeCommand('prepare','ready'),
    synchronizeBranch:executeCommand('sync'),
    advanceRelease:executeCommand('release'),
    reconcileRollout:executeCommand('rollout'),
    cleanupWorkspace:executeCommand('cleanup'),
    closeRelease:executeCommand('release.close'),
    cancelWorkspace:executeCommand('workspace.cancel'),
    transferWorkspace:executeCommand('workspace.transfer'),
    /** Исчерпание коротких попыток откладывает прежнюю команду без изменения её данных. */
    requireReconciliation:(operationId,generation)=>session(async(db,id)=>{
      await authorizeCommand(db,operationId,id,generation);
      await db.query("UPDATE codeworks.commands SET state='pending',technical_attempts=technical_attempts+1,retry_at=now()+(LEAST(300,30*power(2,LEAST(technical_attempts,4))) * interval '1 second'),updated_at=now() WHERE operation_id=$1 AND state<>'done' AND EXISTS(SELECT 1 FROM codeworks.operations o WHERE o.id=operation_id AND o.status NOT IN ('succeeded','failed'))",[operationId]);
      await db.query("UPDATE codeworks.commands SET state='done',retry_at=NULL,updated_at=now() WHERE operation_id=$1 AND state<>'done' AND EXISTS(SELECT 1 FROM codeworks.operations o WHERE o.id=operation_id AND o.status IN ('succeeded','failed'))",[operationId]);
      await db.query("UPDATE codeworks.operations SET status='awaiting_reconciliation',updated_at=now() WHERE id=$1 AND status NOT IN ('succeeded','failed')",[operationId]);
      await db.query("UPDATE codeworks.workflow_registry SET blocked_reason='TECHNICAL_RETRIES_EXHAUSTED',executor_state='waiting',updated_at=now() WHERE workflow_id=$1",[id]);
    }),
    /** Закрывает приём атомарно с проверкой уже принятых команд; tombstone не зависит от Temporal retention. */
    finishWorkflow:generation=>session(async(db,id)=>{
      await db.query('BEGIN');
      try{
        await db.query('SELECT workflow_id FROM codeworks.workflow_registry WHERE workflow_id=$1 FOR UPDATE',[id]);
        const r=await registry(db,id,generation);
        const pending=(await db.query("SELECT 1 FROM codeworks.commands WHERE workflow_id=$1 AND state<>'done' LIMIT 1",[id])).rowCount;
        if(!pending){
          const removed=r.workspace_id&&(await db.query('SELECT removed_at FROM codeworks.workspaces WHERE id=$1',[r.workspace_id])).rows[0]?.removed_at;
          const obligation=r.workspace_id&&(await db.query("SELECT 1 FROM codeworks.cleanup_obligations WHERE workspace_id=$1 AND state<>'done' LIMIT 1",[r.workspace_id])).rowCount;
          if(!obligation&&(removed||r.operation_id)){
            await db.query("UPDATE codeworks.workflow_registry SET state='completed',lifecycle=CASE WHEN $2 THEN 'removed' ELSE lifecycle END,completed_at=COALESCE(completed_at,now()),executor_state='completed',position=next_sequence,updated_at=now() WHERE workflow_id=$1",[id,!!removed]);
            await db.query('COMMIT');return true;
          }
        }
        await db.query("UPDATE codeworks.workflow_registry SET executor_state='waiting',updated_at=now(),position=COALESCE((SELECT min(sequence)-1 FROM codeworks.commands WHERE workflow_id=$1 AND state<>'done'),next_sequence) WHERE workflow_id=$1",[id]);
        await db.query('COMMIT');return r.state==='completed';
      }catch(error){await db.query('ROLLBACK');throw error;}
    }),
  };
}
/** Доставляет только пробуждения. REJECT_DUPLICATE запрещает воскрешение завершённого Workflow ID. */
export async function deliverCommands(pool,client,{taskQueue,limit=16,continueAfter=500,shouldStop=()=>false}={}) {
  const rows=(await pool.query(`SELECT r.workflow_id,r.generation,r.started_at FROM codeworks.workflow_registry r
    WHERE r.owner='temporal' AND r.state<>'completed' AND (r.started_at IS NULL OR EXISTS(SELECT 1 FROM codeworks.commands c WHERE c.workflow_id=r.workflow_id AND c.delivered_at IS NULL AND c.state<>'done')) ORDER BY r.workflow_id LIMIT $1`,[limit])).rows;
  for(const r of rows){
    if(shouldStop())break;
    try{
      if(!r.started_at){
        try{await client.workflow.start('codeworksWorkspace',{workflowId:r.workflow_id,taskQueue,args:[{generation:Number(r.generation),position:0,continueAfter}],workflowIdReusePolicy:'REJECT_DUPLICATE'});}
        catch(error){if(!(error instanceof WorkflowExecutionAlreadyStartedError))throw error;}
        await pool.query('UPDATE codeworks.workflow_registry SET started_at=COALESCE(started_at,now()) WHERE workflow_id=$1',[r.workflow_id]);
      }
      await client.workflow.getHandle(r.workflow_id).signal('commandsAvailable');
      // AIDEV-NOTE: Новые команды тоже можно отметить: workflow читает БД, а периодический timer закрывает race с текущим чтением.
      await pool.query("UPDATE codeworks.commands SET delivered_at=now() WHERE workflow_id=$1 AND delivered_at IS NULL",[r.workflow_id]);
    }catch{
      await pool.query("UPDATE codeworks.workflow_registry SET executor_state='unavailable',updated_at=now() WHERE workflow_id=$1",[r.workflow_id]);
    }
  }
}
/** Подключение и worker восстанавливаются независимо от API; остановка не отменяет внешний Ansible job. */
export function startTemporal(pool,options){
  const {address,namespace,taskQueue}=options;
  if(!address||!namespace||!taskQueue)throw Error('TEMPORAL_CONFIGURATION_REQUIRED');
  let stopping=false,worker,connection,native,relay,delivery;
  const abort=new AbortController();
  // AIDEV-NOTE: Медленный внешний проход не исчерпывает соединения NATS API и доставщика.
  const executionPool=new Pool({connectionString:options.databaseURL,max:4,connectionTimeoutMillis:3000,statement_timeout:10000});
  executionPool.on('error',()=>console.error('codeworks execution database disconnected'));
  executionPool.on('connect',client=>client.on('error',()=>{}));
  // Один connection удерживает index guard, второй обслуживает короткие checkpoints; команды имеют прежний пул.
  const indexPool=new Pool({connectionString:options.databaseURL,max:2,connectionTimeoutMillis:3000,statement_timeout:10000});
  indexPool.on('error',()=>console.error('codeworks index database disconnected'));
  const activities=createActivities(executionPool,{...options,codeIndex:options.codeIndex??createCodeIndex(indexPool)});
  const running=(async()=>{
    while(!stopping){
      try{
        connection=await Connection.connect({address,connectTimeout:'5 seconds'});
        if(stopping)break;
        const client=new Client({connection,namespace});
        let delivering=false,nextProjects=0;
        const deliver=async()=>{if(stopping||delivering)return;delivering=true;try{
          delivery=connection.withAbortSignal(abort.signal,()=>connection.withDeadline(Date.now()+3000,async()=>{
            if(Date.now()>=nextProjects){
              const projects=(await pool.query("SELECT project_id,instance_id FROM codeworks.execution_control WHERE owner='temporal'")).rows;
              for(const project of projects){
                try{await client.workflow.start('codeworksProjectReconciler',{workflowId:`codeworks/${project.instance_id}/${project.project_id}/reconciler`,taskQueue,args:[{projectId:project.project_id}],workflowIdReusePolicy:'REJECT_DUPLICATE'});}
                catch(error){if(!(error instanceof WorkflowExecutionAlreadyStartedError))throw error;}
              }
              nextProjects=Date.now()+60000;
            }
            await deliverCommands(pool,client,{taskQueue,shouldStop:()=>stopping});
          }));await delivery;
        }catch{console.error('codeworks command delivery unavailable');}finally{delivering=false;}};
        relay=setInterval(()=>void deliver(),1000);relay.unref();await deliver();
        native=await NativeConnection.connect({address});
        worker=await Worker.create({connection:native,namespace,taskQueue,workflowBundle:{codePath:fileURLToPath(new URL('../dist/workflows.js',import.meta.url))},activities,maxConcurrentActivityTaskExecutions:4,maxConcurrentWorkflowTaskExecutions:8,shutdownGraceTime:'5 seconds',shutdownForceTime:'15 seconds'});
        const workerRun=worker.run();
        if(stopping&&worker.getState()==='RUNNING')worker.shutdown();
        await workerRun;
      }catch{if(!stopping)console.error('codeworks temporal worker unavailable; commands retained');}
      finally{if(relay)clearInterval(relay);await delivery?.catch(()=>{});worker=undefined;await native?.close().catch(()=>{});native=undefined;await connection?.close().catch(()=>{});connection=undefined;}
      if(!stopping)await wait(1000);
    }
  })();
  return {async close(){stopping=true;abort.abort();if(relay)clearInterval(relay);if(worker?.getState()==='RUNNING')worker.shutdown();await running;await executionPool.end();await indexPool.end();}};
}
