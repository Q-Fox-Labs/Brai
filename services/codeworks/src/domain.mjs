// ABOUTME: Регистрирует рабочие области и намерения Git/CI/выпуска.
// ABOUTME: Не управляет агентами; release агент вызывает после принятия пользователем в чате.
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { canonical, methods, internalMethods, validate, outputNames, schema } from './contracts.mjs';
import { Fault, safeFault } from './errors.mjs';
import {createWriteAdmission} from './write-admission.mjs';
import {createCompletionInbox} from './completion-inbox.mjs';
import {createFlowGit} from './git-flow.mjs';
import {verifyPublication,recheckPublication} from './publication.mjs';
const dto=value=>JSON.parse(JSON.stringify(value));
const publicDTO=(name,row)=>dto(Object.fromEntries(Object.keys(schema.definitions[name].properties).filter(key=>key in row).map(key=>[key,row[key]])));
const workspaceDTO=row=>publicDTO('workspace',row);
const operationDTO=row=>publicDTO('operation',row);
/** Принимает пять операций рабочего цикла и административную регистрацию проекта. */
export function createHandlers(store,git,{adminExecutor='codeworks_admin',allowedRepositories=[],requireTemporal=false,flowGit=createFlowGit()}={}) {
  async function project(db,id,executor) {
    const p=await db.project(id);
    if(!p)throw new Fault('NOT_FOUND');
    if(!allowedRepositories.includes(p.repo_path)||!p.executors.includes(executor))throw new Fault('FORBIDDEN');
    return p;
  }
  async function call(method,args,executorId,writeCallId=null) {
    if(!methods.includes(method)&&!internalMethods.includes(method))throw new Fault('INVALID_ARGUMENT');
    validate(method,args);
    if(!/^[a-z][a-z0-9_]{0,63}$/.test(executorId??''))throw new Fault('FORBIDDEN');
    let value;
    if(internalMethods.includes(method)) {
      if(!store.pool)throw new Fault('INTERNAL');
      await store.read(args.project_id,db=>project(db,args.project_id,executorId));
      const admission=createWriteAdmission(store.pool,{
        prepare:(input,executor,id)=>call('prepare',input,executor,id),
        inspect:(p,w)=>git.inspect(p,w),
        workspace:async(p,id)=>store.read(p,async db=>{
          const config=await project(db,p,executorId),w=await db.workspace(p,id);
          if(!w)throw new Fault('NOT_FOUND');
          return {project:config,workspace:w};
        }),
      });
      value=method==='write.finish'?await createCompletionInbox(store.pool).receive(args,executorId):await admission[method.split('.')[1]](args,executorId);
    } else if(method==='project.register') {
      if(executorId!==adminExecutor||!allowedRepositories.includes(args.project.repo_path))throw new Fault('FORBIDDEN');
      await git.validateProject(args.project);
      value=await store.transaction(args.project.id,async db=>{
        const old=await db.project(args.project.id);
        if(old&&canonical(old)!==canonical(args.project))throw new Fault('CONFLICT','Project configuration differs from the registered project.');
        if(await db.conflictingProject(args.project))throw new Fault('CONFLICT');
        if(!old)await db.insertProject(args.project);
        return {project:args.project};
      });
    } else if(['project.get','status','lifecycle.status'].includes(method)) {
      value=await store.read(args.project_id,async db=>{
        const p=await project(db,args.project_id,executorId);
        if(method==='project.get')return {project:p};
        const operation=args.operation_id?await db.operation(p.id,args.operation_id):null;
        if(args.operation_id&&!operation)throw new Fault('NOT_FOUND');
        const id=args.workspace_id??operation?.workspace_id;
        const w=id?await db.workspace(p.id,id):args.workspace_key?await db.workspaceByKey(p.id,args.workspace_key):null;
        if((id||args.workspace_key)&&!w)throw new Fault('NOT_FOUND');
        if(operation&&w&&operation.workspace_id!==w.id)throw new Fault('CONFLICT');
        if(method==='lifecycle.status'){
          const lifecycle=await db.lifecycle(w.id);
          const obligation=await db.cleanupObligation?.(w.id);
          const closing=obligation&&obligation.state!=='done';
          const writerBlocked=await db.uncertainWriter?.(w.id);
          return {workspace_id:w.id,task_status:closing?'closing':w.removed_at?'removed':lifecycle?.lifecycle??'historical',outcome:lifecycle?.outcome??null,workflow:lifecycle?{id:lifecycle.workflow_id,status:lifecycle.state,generation:Number(lifecycle.generation),executor_state:lifecycle.state!=='completed'&&Date.now()-Math.max(new Date(lifecycle.updated_at).getTime(),new Date(obligation?.updated_at??0).getTime())>120000?'unavailable':lifecycle.executor_state,last_confirmed_stage:closing?'cleanup:'+obligation.step:lifecycle.last_stage,blocked_reason:closing?obligation.blocker:writerBlocked?'WRITER_OUTCOME_UNKNOWN':lifecycle.blocked_reason}:null,cleanup:obligation?{id:obligation.id,state:obligation.state,step:obligation.step,outcome:obligation.outcome,owner_workflow_id:obligation.owner_workflow_id,epoch:Number(obligation.epoch),next_attempt_at:obligation.next_attempt_at,blocker:obligation.blocker}:null,blockers:await db.blockers(w.id)};
        }
        if(!w){
          if(operation)return {operation:operationDTO(operation)};
          const offset=args.offset??0,limit=args.limit??100,rows=await db.workspaces(p.id,limit+1,offset);
          return {workspaces:rows.slice(0,limit).map(workspaceDTO),next_offset:rows.length>limit?offset+limit:null};
        }
        const latest=operation??await db.latestOperation(w.id);
        const result={workspace:workspaceDTO(w),operation:latest?operationDTO(latest):null,git:null};
        if(w.preparation_state==='ready'&&!w.removed_at){
          try{result.git=await git.inspect(p,w);}catch(error){result.inspection_error=safeFault(error).dto();}
        }
        return result;
      });
    } else {
      // AIDEV-NOTE: Git и сеть не входят в транзакцию приёма. Повтор ключа не зависит от нынешнего состояния дерева.
      const snapshot=await store.read(args.project_id,async db=>{
        const p=await project(db,args.project_id,executorId);
        const old=await db.request(p.id,executorId,args.request_key);
        const w=old?null:method==='prepare'?await db.workspaceByKey(p.id,args.workspace_key):await db.workspace(p.id,args.workspace_id);
        const successful=method==='cleanup'&&w?await db.successfulRelease(w.id):null;
        const obligation=method==='cleanup'&&w&&!successful?await db.cleanupObligation?.(w.id):null;
        const existingCleanup=successful||(obligation&&obligation.state!=='done');
        return {project:dto(p),workspace:w?dto(w):null,repeated:!!old,existingCleanup:!!existingCleanup};
      });
      let baseSHA,inspection,publication;
      if(!snapshot.repeated){
        if(method==='prepare'){
          if(!snapshot.workspace&&!writeCallId)throw new Fault('WORKSPACE_WRITE_REQUIRED');
          if(snapshot.workspace?.removed_at){
            const prior=await store.read(args.project_id,db=>db.lifecycle(snapshot.workspace.id));
            if(!writeCallId||prior?.outcome!=='unused')throw new Fault('CONFLICT','Completed workspace requires a distinct task key.');
          }
          if(!snapshot.workspace||snapshot.workspace.removed_at)baseSHA=await git.readBase(snapshot.project,args.kind??'feature');
        }
        if(['sync','release'].includes(method)&&snapshot.workspace&&!snapshot.workspace.removed_at&&snapshot.workspace.preparation_state==='ready')inspection=await git.inspect(snapshot.project,snapshot.workspace);
        if(method==='cleanup'&&!snapshot.existingCleanup&&snapshot.workspace&&!snapshot.workspace.removed_at&&snapshot.workspace.preparation_state==='ready')publication=await store.read(args.project_id,db=>verifyPublication(db,snapshot.project,snapshot.workspace,{git,flowGit}));
      }
      value=await store.transaction(args.project_id,async db=>{
        const p=await project(db,args.project_id,executorId);
        if(canonical(p)!==canonical(snapshot.project))throw new Fault('CONFLICT','Project changed during admission; inspect status before retry.');
        const digest=createHash('sha256').update(canonical({method,args})).digest('hex');
        const old=await db.request(p.id,executorId,args.request_key);
        if(old){
          if(old.payload_sha256!==digest||old.archived)throw new Fault('CONFLICT','Request key belongs to another or archived operation.');
          const w=await db.workspace(p.id,old.workspace_id);
          if(method==='prepare'&&w.removed_at)throw new Fault('CONFLICT','Task workspace was removed; use a new workspace key for a new task.');
          return {operation_id:old.operation_id,workspace_id:w.id,path:w.path,branch:w.branch};
        }
        if(requireTemporal&&(await db.executionControl(p.id))?.owner!=='temporal')throw new Fault('BUSY','Temporal ownership transition is not complete.');
        let w;
        if(method==='prepare') {
          w=await db.workspaceByKey(p.id,args.workspace_key);
          if(w?.removed_at){
            if(!writeCallId||(await db.lifecycle(w.id))?.outcome!=='unused')throw new Fault('CONFLICT');
            w=null;
          }
          const kind=args.kind??'feature';
          if(w){
            if(w.kind!==kind||w.removed_at||w.kind==='promotion')throw new Fault('CONFLICT','Use a new workspace key for a different or completed task.');
          }else{
            if(!writeCallId)throw new Fault('WORKSPACE_WRITE_REQUIRED');
            const native=(await db.query('SELECT id FROM codeworks.write_calls WHERE id=$1 AND project_id=$2 AND executor_id=$3 AND workspace_key=$4 AND request_key=$5 AND state=\'preparing\' FOR UPDATE',[writeCallId,p.id,executorId,args.workspace_key,args.request_key])).rows[0];
            if(!native)throw new Fault('WORKSPACE_WRITE_REQUIRED');
            const key=args.workspace_key;
            if(key.length>64||!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(key)||/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/i.test(key)||/^[0-9a-f]{12,}$/i.test(key))throw new Fault('INVALID_ARGUMENT','New workspace_key must be a short descriptive task name, e.g. codeworks-auto-cleanup; UUIDs and commit hashes are not task names.');
            const base_sha=baseSHA;
            if(!base_sha)throw new Fault('CONFLICT','Workspace changed during admission.');
            if(kind==='hotfix'&&(await db.currentEvidence(p.id,'prod'))?.commit_sha!==base_sha)throw new Fault('PRODUCTION_BASE_MISMATCH');
            const id=randomUUID();
            w={id,project_id:p.id,workspace_key:args.workspace_key,kind,base_ref:p.git_flow[kind+'_base'],base_sha,branch:p.git_flow[kind+'_prefix']+args.workspace_key,path:path.join(p.workspace_root,id),ownership_token:randomUUID(),activation_state:'awaiting_first_write'};
            if((await db.query("SELECT 1 FROM codeworks.cleanup_obligations WHERE project_id=$1 AND state<>'done' AND expected#>>'{branch,ref}'=$2 LIMIT 1",[p.id,'refs/heads/'+w.branch])).rowCount)throw new Fault('CLEANUP_ALREADY_STARTED','The branch is reserved by a saved cleanup obligation.');
            await db.insertWorkspace(w);
          }
        }else{
          w=await db.workspace(p.id,args.workspace_id);
          if(!w)throw new Fault('NOT_FOUND');
          if(w.removed_at)throw new Fault('CONFLICT','Task workspace was removed.');
          if(w.kind==='promotion')throw new Fault('CONFLICT','Historical promotion workspaces are read-only.');
          if(['sync','release'].includes(method)){
            if(w.preparation_state!=='ready'||w.removed_at)throw new Fault('CONFLICT','Workspace must be prepared first.');
            const state=inspection;
            if(!state||snapshot.workspace?.id!==w.id||['path','branch','base_sha','ownership_token'].some(key=>snapshot.workspace[key]!==w[key]))throw new Fault('CONFLICT','Workspace changed during admission.');
            if(state.dirty||state.head!==args.commit_sha)throw new Fault('CONFLICT','Operation requires the current clean workspace commit.');
            if(await db.activeRelease(w.id))throw new Fault('CONFLICT','Workspace has an unfinished release; inspect its status first.');
          }
          if(method==='release'&&!p.github)throw new Fault('CONFLICT','GitHub release is not configured.');
        }
        // AIDEV-NOTE: Допуск команд и hook писателя используют один порядок блокировок.
        await db.query?.('SELECT id FROM codeworks.workspaces WHERE id=$1 FOR UPDATE',[w.id]);
        await db.query?.('SELECT workflow_id FROM codeworks.workflow_registry WHERE workspace_id=$1 FOR UPDATE',[w.id]);
        const lifecycle=await db.lifecycle?.(w.id);
        let cleanupClosing=false,cleanupEvidence={};
        if(method==='cleanup'&&!(await db.query("SELECT 1 FROM codeworks.cleanup_obligations WHERE workspace_id=$1 AND state<>'done' FOR UPDATE",[w.id])).rowCount){
          const successful=await db.successfulRelease(w.id);
          if(!successful){
            if(!publication||!lifecycle||lifecycle.owner!=='temporal'||snapshot.workspace?.id!==w.id||['path','branch','base_sha','ownership_token'].some(key=>snapshot.workspace[key]!==w[key])||!await recheckPublication(db,p,w,publication,{lock:true}))throw new Fault('CONFLICT','Cleanup requires a saved finalization obligation or verified later delivery.');
            cleanupEvidence={publication};
          }
          cleanupClosing=lifecycle?.owner==='temporal';
        }
        let superseded=null;
        if(lifecycle?.lifecycle==='closing'&&['workspace.cancel','workspace.transfer'].includes(method)){
          superseded=(await db.query("SELECT * FROM codeworks.cleanup_obligations WHERE workspace_id=$1 AND state IN ('pending','retry','waiting_decision') AND step='inspect' AND expected='{}'::jsonb FOR UPDATE",[w.id])).rows[0];
          if(!superseded)throw new Fault('CLEANUP_ALREADY_STARTED','Cleanup already began; reconcile the saved route.');
          const guard=(await db.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired',['execution:workspace:'+w.id])).rows[0];
          if(!guard?.acquired)throw new Fault('BUSY','The previous route is being reconciled.');
        }
        if(lifecycle&&(lifecycle.state!=='open'||lifecycle.lifecycle!=='active')&&!superseded&&!(method==='cleanup'&&lifecycle.lifecycle==='closing'&&lifecycle.state==='draining'))throw new Fault('CLEANUP_ALREADY_STARTED','Task no longer accepts new changes.');
        if(method==='release.close'){
          const attempt=await db.releaseOperation(args.release_operation_id,w.id);
          if(!attempt)throw new Fault('NOT_FOUND');
          if(attempt.state==='succeeded')throw new Fault('CONFLICT','Successful release cannot be closed.');
        }
        let existing=method==='prepare'?await db.latestPreparation(w.id):null;
        if(existing?.status==='failed')existing=null;
        const id=existing?.id??randomUUID();
        if(!existing){
          // AIDEV-NOTE: Новый маршрут атомарно возвращает не начатую очистку в сверку; запись не открывается.
          if(superseded)await db.query("UPDATE codeworks.cleanup_obligations SET state='waiting_decision',evidence=jsonb_set(evidence,'{route_pending}','true'::jsonb),updated_at=now() WHERE id=$1",[superseded.id]);
          await db.insertOperation({id,project_id:p.id,workspace_id:w.id,executor_id:executorId,kind:method,status:'pending',step:'intent',request:args,result:null});
          if(cleanupClosing){
            await db.query("INSERT INTO codeworks.cleanup_obligations(id,project_id,workspace_id,subject_key,source_operation_id,outcome,step,state,evidence,owner_workflow_id,epoch) VALUES($1,$2,$3,$4,$5,'released','inspect','pending',$6::jsonb,$7,1)",[randomUUID(),p.id,w.id,'workspace:'+w.id,id,JSON.stringify(cleanupEvidence),lifecycle.workflow_id]);
            await db.query("UPDATE codeworks.workflow_registry SET state='draining',lifecycle='closing',outcome='released',updated_at=now() WHERE workspace_id=$1",[w.id]);
          }
          if(['workspace.cancel','workspace.transfer'].includes(method)&&lifecycle){
            const outcome=method==='workspace.cancel'?'cancelled':'transferred';
            if(superseded){
              const {route_history:priorHistory,...priorEvidence}=superseded.evidence??{};
              const history=[...(priorHistory??[]),{operation_id:superseded.source_operation_id,outcome:superseded.outcome,evidence:priorEvidence}];
              await db.query("UPDATE codeworks.cleanup_obligations SET source_operation_id=$2,outcome=$3,evidence=$4::jsonb,epoch=epoch+1,blocker='ROUTE_RECONCILIATION_REQUIRED',updated_at=now() WHERE id=$1",[superseded.id,id,outcome,JSON.stringify({route_pending:true,route_history:history})]);
              await db.query("UPDATE codeworks.operations SET status='failed',step='ROUTE_SUPERSEDED',updated_at=now() WHERE id=$1 AND status<>'succeeded'",[superseded.source_operation_id]);
              await db.query("UPDATE codeworks.commands SET state='done',updated_at=now() WHERE operation_id=$1",[superseded.source_operation_id]);
            }else await db.query("INSERT INTO codeworks.cleanup_obligations(id,project_id,workspace_id,subject_key,source_operation_id,outcome,step,state,evidence,owner_workflow_id,epoch,blocker) VALUES($1,$2,$3,$4,$5,$6,'inspect','waiting_decision',$7::jsonb,$8,1,'ROUTE_RECONCILIATION_REQUIRED')",[randomUUID(),p.id,w.id,'workspace:'+w.id,id,outcome,JSON.stringify({route_pending:true}),lifecycle.workflow_id]);
            await db.query("UPDATE codeworks.workflow_registry SET state='draining',lifecycle='closing',outcome=$2,updated_at=now() WHERE workspace_id=$1",[w.id,outcome]);
          }
          if(method==='release'){
            let details={},retryOf=null;
            const previous=await db.latestRelease(w.id);
            if(previous?.state==='failed'&&previous.requested_sha===args.commit_sha){
              const candidate=structuredClone(previous.details);let retry=false;
              for(const name of ['primary','backport']){
                const leg=candidate[name];
                if(leg?.deployment_operation_id&&await db.failedDeployment(leg.deployment_operation_id)){
                  leg.deployment_retry_of=leg.deployment_operation_id;retry=true;
                }
              }
              // AIDEV-NOTE: Новый ключ разрешает одну попытку установки; повторы старого ключа остаются неизменны.
              if(retry){details=candidate;retryOf=previous.operation_id;}
            }
            await db.release({id:randomUUID(),workspace_id:w.id,operation_id:id,target:w.kind==='feature'?'dev':'prod',requested_sha:args.commit_sha,state:'pending',details,retry_of:retryOf});
          }
        }
        await db.insertRequest({project_id:p.id,executor_id:executorId,key:args.request_key,digest,operation_id:id});
        return {operation_id:id,workspace_id:w.id,path:w.path,branch:w.branch};
      });
    }
    // AIDEV-NOTE: PostgreSQL Date должен проверяться в том же ISO-виде, который получит транспорт.
    value=dto(value);
    try{validate(outputNames[method],value);}catch{throw new Fault('INTERNAL');}
    return value;
  }
  return {call};
}
