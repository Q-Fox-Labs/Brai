// ABOUTME: Регистрирует рабочие области и намерения Git/CI/выпуска.
// ABOUTME: Не управляет агентами; release агент вызывает после принятия пользователем в чате.
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { canonical, methods, internalMethods, validate, outputNames, schema } from './contracts.mjs';
import { Fault, safeFault } from './errors.mjs';
import {createWriteAdmission} from './write-admission.mjs';
const dto=value=>JSON.parse(JSON.stringify(value));
const publicDTO=(name,row)=>dto(Object.fromEntries(Object.keys(schema.definitions[name].properties).filter(key=>key in row).map(key=>[key,row[key]])));
const workspaceDTO=row=>publicDTO('workspace',row);
const operationDTO=row=>publicDTO('operation',row);
/** Принимает пять операций рабочего цикла и административную регистрацию проекта. */
export function createHandlers(store,git,{adminExecutor='codeworks_admin',allowedRepositories=[],requireTemporal=false}={}) {
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
      value=await admission[method.split('.')[1]](args,executorId);
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
          return {workspace_id:w.id,task_status:w.removed_at?'removed':lifecycle?.lifecycle??'historical',outcome:lifecycle?.outcome??null,workflow:lifecycle?{id:lifecycle.workflow_id,status:lifecycle.state,generation:Number(lifecycle.generation),executor_state:lifecycle.state!=='completed'&&Date.now()-new Date(lifecycle.updated_at).getTime()>120000?'unavailable':lifecycle.executor_state,last_confirmed_stage:lifecycle.last_stage,blocked_reason:lifecycle.blocked_reason}:null,blockers:await db.blockers(w.id)};
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
        return {project:dto(p),workspace:w?dto(w):null,repeated:!!old};
      });
      let baseSHA,inspection;
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
          if(method==='cleanup'&&!await db.successfulRelease(w.id)&&!(await db.query("SELECT 1 FROM codeworks.cleanup_obligations WHERE workspace_id=$1 AND state<>'done'",[w.id])).rowCount)throw new Fault('CONFLICT','Cleanup requires a saved finalization obligation.');
          if(method==='release'&&!p.github)throw new Fault('CONFLICT','GitHub release is not configured.');
        }
        const lifecycle=await db.lifecycle?.(w.id);
        if(lifecycle&&(lifecycle.state!=='open'||lifecycle.lifecycle!=='active')&&!(method==='cleanup'&&lifecycle.lifecycle==='closing'&&lifecycle.state==='draining'))throw new Fault('CLEANUP_ALREADY_STARTED','Task no longer accepts new changes.');
        if(method==='release.close'){
          const attempt=await db.releaseOperation(args.release_operation_id,w.id);
          if(!attempt)throw new Fault('NOT_FOUND');
          if(attempt.state==='succeeded')throw new Fault('CONFLICT','Successful release cannot be closed.');
        }
        let existing=method==='prepare'?await db.latestPreparation(w.id):null;
        if(existing?.status==='failed')existing=null;
        const id=existing?.id??randomUUID();
        if(!existing){
          await db.insertOperation({id,project_id:p.id,workspace_id:w.id,executor_id:executorId,kind:method,status:'pending',step:'intent',request:args,result:null});
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
    try{validate(outputNames[method],value);}catch{throw new Fault('INTERNAL');}
    return value;
  }
  return {call};
}
