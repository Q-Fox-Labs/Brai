// ABOUTME: Регистрирует рабочие области и намерения Git/CI/выпуска.
// ABOUTME: Не управляет агентами; release агент вызывает после принятия пользователем в чате.
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { canonical, methods, validate, outputNames } from './contracts.mjs';
import { Fault, safeFault } from './errors.mjs';
const dto=value=>JSON.parse(JSON.stringify(value));
const workspaceDTO=row=>{const {ownership_token,legacy_writer,...rest}=row;return dto(rest);};
/** Принимает пять операций рабочего цикла и административную регистрацию проекта. */
export function createHandlers(store,git,{adminExecutor='codeworks_admin',allowedRepositories=[]}={}) {
  async function project(db,id,executor) {
    const p=await db.project(id);
    if(!p)throw new Fault('NOT_FOUND');
    if(!allowedRepositories.includes(p.repo_path)||!p.executors.includes(executor))throw new Fault('FORBIDDEN');
    return p;
  }
  async function call(method,args,executorId) {
    if(!methods.includes(method))throw new Fault('INVALID_ARGUMENT');
    validate(method,args);
    if(!/^[a-z][a-z0-9_]{0,63}$/.test(executorId??''))throw new Fault('FORBIDDEN');
    let value;
    if(method==='project.register') {
      if(executorId!==adminExecutor||!allowedRepositories.includes(args.project.repo_path))throw new Fault('FORBIDDEN');
      await git.validateProject(args.project);
      value=await store.transaction(args.project.id,async db=>{
        const old=await db.project(args.project.id);
        if(old&&canonical(old)!==canonical(args.project))throw new Fault('CONFLICT','Project configuration differs from the registered project.');
        if(await db.conflictingProject(args.project))throw new Fault('CONFLICT');
        if(!old)await db.insertProject(args.project);
        return {project:args.project};
      });
    } else if(['project.get','status'].includes(method)) {
      value=await store.read(args.project_id,async db=>{
        const p=await project(db,args.project_id,executorId);
        if(method==='project.get')return {project:p};
        const operation=args.operation_id?await db.operation(p.id,args.operation_id):null;
        if(args.operation_id&&!operation)throw new Fault('NOT_FOUND');
        const id=args.workspace_id??operation?.workspace_id;
        const w=id?await db.workspace(p.id,id):args.workspace_key?await db.workspaceByKey(p.id,args.workspace_key):null;
        if((id||args.workspace_key)&&!w)throw new Fault('NOT_FOUND');
        if(operation&&w&&operation.workspace_id!==w.id)throw new Fault('CONFLICT');
        if(!w)return operation?{operation:dto(operation)}:{workspaces:(await db.workspaces(p.id)).map(workspaceDTO)};
        const latest=operation??await db.latestOperation(w.id);
        const result={workspace:workspaceDTO(w),operation:latest?dto(latest):null,git:null};
        if(w.preparation_state==='ready'&&!w.removed_at){
          try{result.git=await git.inspect(p,w);}catch(error){result.inspection_error=safeFault(error).dto();}
        }
        return result;
      });
    } else {
      value=await store.transaction(args.project_id,async db=>{
        const p=await project(db,args.project_id,executorId);
        const digest=createHash('sha256').update(canonical({method,args})).digest('hex');
        const old=await db.request(p.id,executorId,args.request_key);
        if(old){
          if(old.payload_sha256!==digest||old.archived)throw new Fault('CONFLICT','Request key belongs to another or archived operation.');
          const w=await db.workspace(p.id,old.workspace_id);
          if(method==='prepare'&&w.removed_at)throw new Fault('CONFLICT','Task workspace was removed; use a new workspace key for a new task.');
          return {operation_id:old.operation_id,workspace_id:w.id,path:w.path,branch:w.branch};
        }
        let w;
        if(method==='prepare') {
          w=await db.workspaceByKey(p.id,args.workspace_key);
          const kind=args.kind??'feature';
          if(w){
            if(w.kind!==kind||w.removed_at||w.kind==='promotion')throw new Fault('CONFLICT','Use a new workspace key for a different or completed task.');
          }else{
            const key=args.workspace_key;
            if(key.length>64||!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(key)||/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/i.test(key)||/^[0-9a-f]{12,}$/i.test(key))throw new Fault('INVALID_ARGUMENT','New workspace_key must be a short descriptive task name, e.g. codeworks-auto-cleanup; UUIDs and commit hashes are not task names.');
            const base_sha=await git.readBase(p,kind);
            if(kind==='hotfix'&&(await db.currentEvidence(p.id,'prod'))?.commit_sha!==base_sha)throw new Fault('PRODUCTION_BASE_MISMATCH');
            const id=randomUUID();
            w={id,project_id:p.id,workspace_key:args.workspace_key,kind,base_ref:p.git_flow[kind+'_base'],base_sha,branch:p.git_flow[kind+'_prefix']+args.workspace_key,path:path.join(p.workspace_root,id),ownership_token:randomUUID()};
            await db.insertWorkspace(w);
          }
        }else{
          w=await db.workspace(p.id,args.workspace_id);
          if(!w)throw new Fault('NOT_FOUND');
          if(w.kind==='promotion')throw new Fault('CONFLICT','Historical promotion workspaces are read-only.');
          if(method!=='cleanup'){
            if(w.preparation_state!=='ready'||w.removed_at)throw new Fault('CONFLICT','Workspace must be prepared first.');
            const state=await git.inspect(p,w);
            if(state.dirty||state.head!==args.commit_sha)throw new Fault('CONFLICT','Operation requires the current clean workspace commit.');
            if(await db.activeRelease(w.id))throw new Fault('CONFLICT','Workspace has an unfinished release; inspect its status first.');
          }
          if(method==='cleanup'&&!await db.successfulRelease(w.id))throw new Fault('CONFLICT','Cleanup requires a completed release.');
          if(method==='release'&&!p.github)throw new Fault('CONFLICT','GitHub release is not configured.');
        }
        let existing=method==='prepare'?await db.latestPreparation(w.id):null;
        if(existing?.status==='failed')existing=null;
        const id=existing?.id??randomUUID();
        if(!existing){
          await db.insertOperation({id,project_id:p.id,workspace_id:w.id,executor_id:executorId,kind:method,status:'pending',step:'intent',request:args,result:null});
          if(method==='release'){
            let details={};
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
              if(retry)details=candidate;
            }
            await db.release({id:randomUUID(),workspace_id:w.id,operation_id:id,target:w.kind==='feature'?'dev':'prod',requested_sha:args.commit_sha,state:'pending',details});
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
