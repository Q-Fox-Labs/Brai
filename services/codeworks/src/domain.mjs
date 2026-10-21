// ABOUTME: Управляет намерениями, областями, явной передачей записи и запросами выпуска.
// ABOUTME: Git, транспорт и соединение PostgreSQL подключаются извне; задачи game-core не копируются.
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { canonical, methods, validate, outputNames } from './contracts.mjs';
import { Fault } from './errors.mjs';
const dto=row=>JSON.parse(JSON.stringify(row));
const workspaceDTO=row=>{ const {ownership_token,...rest}=row; return dto(rest); };
function assertWriter(workspace,executor,args) {
  const w=workspace.writer;
  if (w.state!=='active'||w.executor_id!==executor||w.session_id!==args.session_id||w.epoch!==args.expected_epoch) throw new Fault('WRITER_BUSY');
}
/** Создаёт общие операции. executorId поступает только от доверенного адаптера. */
export function createHandlers(store,git,{adminExecutor='codeworks_admin',assertQuiescent=async()=>{},allowedRepositories=[]}={}) {
  async function authorized(db,projectId,executorId) {
    const project=await db.project(projectId);
    if(!project)throw new Fault('NOT_FOUND');
    if(!allowedRepositories.includes(project.repo_path))throw new Fault('FORBIDDEN');
    if(!project.executors.includes(executorId))throw new Fault('FORBIDDEN');
    return project;
  }
  async function workspace(db,projectId,id) {
    const row=await db.workspace(projectId,id);
    if (!row) throw new Fault('NOT_FOUND');
    return row;
  }
  async function attach(db,w,executor,args) {
    await db.attach({id:randomUUID(),workspace_id:w.id,executor_id:executor,session_id:args.session_id,move_id:args.move_id??null,attempt_id:args.attempt_id??null,writer_epoch:w.writer.epoch});
  }
  async function operation(db,w,executor,kind,args,status='pending',result=null,id=randomUUID()) {
    await db.insertOperation({id,project_id:w.project_id,workspace_id:w.id,executor_id:executor,actor_id:args.actor_id??null,kind,status,step:status==='pending'?'intent':status,request:args,result});
    return {operation_id:id,workspace_id:w.id};
  }
  /** Валидирует параметры и результат по схемам фактического метода. */
  async function call(method,args,executorId) {
    if (!methods.includes(method)) throw new Fault('INVALID_ARGUMENT');
    validate(method,args);
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(executorId??'')) throw new Fault('FORBIDDEN');
    let value;
    if (method==='project.register') {
      if (executorId!==adminExecutor||!allowedRepositories.includes(args.project.repo_path)) throw new Fault('FORBIDDEN');
      await git.validateProject(args.project);
      value=await store.transaction(args.project.id,async db=>{
        const old=await db.project(args.project.id);
        if (old && canonical(old)!==canonical(args.project)) throw new Fault('CONFLICT','Project policy is immutable in this version.');
        const overlaps=await db.conflictingProject(args.project);
        if (overlaps) throw new Fault('CONFLICT');
        if (!old) await db.insertProject(args.project);
        return {project:args.project};
      });
    } else {
      const readOnly=['project.get','status','operation-status'].includes(method);
      const access=readOnly?store.read:store.transaction;
      if(!readOnly) value=await store.read(args.project_id,async db=>{
        await authorized(db,args.project_id,executorId);
        const old=await db.request(args.project_id,executorId,args.idempotency_key);
        if(!old)return null;
        if(old.payload_sha256!==createHash('sha256').update(canonical({method,args})).digest('hex'))throw new Fault('CONFLICT');
        return {operation_id:old.operation_id,workspace_id:old.workspace_id};
      });
      if(!value)value=await access(args.project_id,async db=>{
        const project=await authorized(db,args.project_id,executorId);
        if (method==='project.get') return {project};
        if (method==='operation-status') {
          const op=await db.operation(args.project_id,args.operation_id);
          if (!op) throw new Fault('NOT_FOUND');
          return {operation:dto(op)};
        }
        if (method==='status') {
          const w=await workspace(db,args.project_id,args.workspace_id);
          const state=w.preparation_state==='ready'?await git.inspect(project,w):null;
          const attachments=await db.attachments(w.id);
          return {workspace:workspaceDTO(w),attachments:dto(attachments),git:state};
        }
        const digest=createHash('sha256').update(canonical({method,args})).digest('hex');
        const old=await db.request(args.project_id,executorId,args.idempotency_key);
        if (old) {
          if (old.payload_sha256!==digest) throw new Fault('CONFLICT','Idempotency key was used with different parameters.');
          return {operation_id:old.operation_id,workspace_id:old.workspace_id};
        }
        let accepted;
        if (method==='prepare-write') {
          let w=await db.workspaceByKey(args.project_id,args.workspace_key);
          if (!w) {
            const id=randomUUID(),kind=args.kind;
            let base_ref=project.git_flow[kind+'_base'];
            let base_sha;
            if(kind==='promotion'){
              const proof=await db.evidenceById(project.id,args.evidence_id);
              if(!proof||proof.target!=='dev'||proof.commit_sha!==args.commit_sha)throw new Fault('VERIFIED_DEV_REQUIRED');
              base_sha=args.commit_sha;base_ref='verified-dev:'+proof.id;
              await git.readPinned(project,base_sha);
            }else{
              base_sha=await git.readBase(project,kind);
              if(kind==='hotfix'){
                const installed=await db.currentEvidence(project.id,'prod');
                if(!installed||installed.commit_sha!==base_sha)throw new Fault('PRODUCTION_BASE_MISMATCH');
              }
            }
            const branch=(kind==='promotion'?'release/':project.git_flow[kind+'_prefix'])+'codeworks-'+id;
            const areaPath=path.join(project.workspace_root,id);
            const writer={executor_id:executorId,session_id:args.session_id,epoch:1,state:'active'};
            w={id,project_id:args.project_id,workspace_key:args.workspace_key,element_id:args.element_id??null,kind,base_ref,base_sha,branch,path:areaPath,ownership_token:randomUUID(),writer};
            await db.insertWorkspace(w);
          } else {
            if (w.kind!==args.kind || (args.element_id!==undefined&&w.element_id!==args.element_id)||(w.kind==='promotion'&&(w.base_sha!==args.commit_sha||w.base_ref!=='verified-dev:'+args.evidence_id))) throw new Fault('CONFLICT');
            assertWriter(w,executorId,{...args,expected_epoch:w.writer.epoch});
            if(w.preparation_state==='ready')await git.inspect(project,w);
          }
          const existing=await db.latestPreparation(w.id);
          accepted=existing&&existing.status!=='failed'?{operation_id:existing.id,workspace_id:w.id}:await operation(db,w,executorId,method,args);
          await attach(db,w,executorId,args);
        } else {
          const w=await workspace(db,args.project_id,args.workspace_id);
          if (w.preparation_state!=='ready') throw new Fault('CONFLICT','Workspace preparation must succeed first.');
          await git.inspect(project,w);
          if (method==='commit') {
            assertWriter(w,executorId,args);
            if(await db.activeRelease(w.id))throw new Fault('CONFLICT');
            const commitId=randomUUID();
            await assertQuiescent({workspace:workspaceDTO(w),executorId,sessionId:args.session_id,temporary:commitId});
            w.writer={...w.writer,state:'committing'};await db.updateWriter(w);
            accepted=await operation(db,w,executorId,method,{...args,parent_sha:(await git.inspect(project,w)).head},'pending',null,commitId);
          } else if (method==='attach-or-transfer') {
            if(w.writer.state==='committing')throw new Fault('WRITER_BUSY');
            if (args.mode==='quiesce') {
              assertWriter(w,executorId,args);
              if (args.writes_stopped!==true) throw new Fault('INVALID_ARGUMENT','Previous writer must explicitly confirm that writes have stopped.');
              // AIDEV-NOTE: Managed host перекрывает admission и ждёт реальные namespace children.
              await assertQuiescent({workspace:workspaceDTO(w),executorId,sessionId:args.session_id});
              w.writer={...w.writer,state:'quiesced'};
            } else {
              if (args.writes_stopped!==undefined) throw new Fault('INVALID_ARGUMENT');
              if (w.writer.epoch!==args.expected_epoch) throw new Fault('WRITER_BUSY');
              if (w.writer.state==='active') {
                if (w.writer.executor_id!==executorId||w.writer.session_id!==args.session_id) throw new Fault('WRITER_BUSY');
              } else w.writer={executor_id:executorId,session_id:args.session_id,epoch:w.writer.epoch+1,state:'active'};
              await attach(db,w,executorId,args);
            }
            await db.updateWriter(w);
            accepted=await operation(db,w,executorId,method,args,'succeeded',{writer:w.writer});
          } else {
            assertWriter(w,executorId,args);
            const current=await git.inspect(project,w);
            if (current.head!==args.commit_sha||current.dirty) throw new Fault('CONFLICT','Release requires the current clean workspace commit.');
            if((w.kind==='feature'&&args.target!=='dev')||(w.kind!=='feature'&&args.target!=='prod'))throw new Fault('INVALID_ARGUMENT','Release target does not match workspace route.');
            if(await db.activeRelease(w.id))throw new Fault('CONFLICT','Workspace already has an unfinished release.');
            await assertQuiescent({workspace:workspaceDTO(w),executorId,sessionId:args.session_id});
            w.writer={...w.writer,state:'quiesced'};await db.updateWriter(w);
            const releaseId=randomUUID();
            accepted=await operation(db,w,executorId,method,args,project.github?'pending':'awaiting_execution',project.github?{release_id:releaseId,state:'pending',details:{}}:{release_id:releaseId,reason:'RELEASE_EXECUTION_NOT_AVAILABLE'});
            await db.release({id:releaseId,workspace_id:w.id,operation_id:accepted.operation_id,target:args.target,requested_sha:args.commit_sha,state:project.github?'pending':'awaiting_execution'});
          }
        }
        await db.insertRequest({project_id:args.project_id,executor_id:executorId,key:args.idempotency_key,digest,operation_id:accepted.operation_id});
        return accepted;
      });
    }
    // AIDEV-NOTE: Ошибка серверного ответа является INTERNAL, а не ошибкой параметров клиента.
    try { validate(outputNames[method],value); } catch { throw new Fault('INTERNAL'); }
    return value;
  }
  return {call};
}
