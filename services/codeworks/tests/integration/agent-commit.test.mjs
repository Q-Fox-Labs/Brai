// ABOUTME: Проверяет настоящий bridge/PG/Git/worker на собственной Stage6 БД.
// ABOUTME: SIGKILL после CAS, transfer и повторы не создают второй commit или чужую запись.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,mkdtemp,rm,chmod} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {migrate} from '../../src/migrate.mjs';
import {createStore} from '../../src/storage.mjs';
import {createHandlers} from '../../src/domain.mjs';
import {createGit,command} from '../../src/git.mjs';
import {createAgentHost,socketCall} from '../../src/agent-host.mjs';
import {launchWorker} from '../../src/runtime.mjs';
const configured=process.env.CODEWORKS_STAGE6_TEST_CONFIG;
test('real bridge chooses kind/context before write, fences revoked writer, commits durably and requests own release',{skip:!configured,timeout:180000},async()=>{
 const c=JSON.parse(await readFile(configured,'utf8'));assert.equal(new URL(c.owner_url).pathname,'/brai_codeworks_stage6_test');
 const owner=new Pool({connectionString:c.owner_url,max:1}),app=new Pool({connectionString:c.app_url,max:6});
 const parent=fileURLToPath(new URL('../../../../tmp/',import.meta.url));await mkdir(parent,{recursive:true});
 const temporary=await mkdtemp(parent+'cw-bridge-'),socketRoot=await mkdtemp('/tmp/cwb-');let host;const children=[];
 try{
  await migrate(owner,c.app_role,c.verifier_role);
  for(const kind of ['feature','hotfix']){
   const repo=temporary+'/'+kind,areas=temporary+'/'+kind+'-areas',state=socketRoot+'/'+kind;await mkdir(repo);await mkdir(areas);await mkdir(repo+'/node_modules');
   const git=(...a)=>command('git',['-C',repo,...a]);await command('git',['init','-b','dev',repo]);await git('config','user.name','Stage6');await git('config','user.email','stage6@example.invalid');
   await writeFile(repo+'/.gitignore','node_modules/\n');await writeFile(repo+'/package-lock.json','{}\n');await writeFile(repo+'/hello.txt','base\n');await git('add','.');await git('commit','-m','base');
   const base=(await git('rev-parse','HEAD')).stdout;for(const branch of ['dev','main'])await git('update-ref','refs/remotes/origin/'+branch,base);
   const preparer=repo+'/.git/hooks/prepare-stage6';await writeFile(preparer,'#!/bin/sh\nif [ \"$1\" = --check ]; then test -d \"$2/node_modules\"; else mkdir -p \"$1/node_modules\"; fi\n');await chmod(preparer,0o755);
   const p={id:'bridge_'+randomUUID(),repo_path:repo,common_dir:repo+'/.git',workspace_root:areas,allowed_paths:['.'],excluded_paths:['.git','node_modules','.env'],executors:['codex','hermes'],git_flow:{feature_base:'refs/remotes/origin/dev',hotfix_base:'refs/remotes/origin/main',feature_prefix:'feature/',hotfix_prefix:'hotfix/'},preparer_path:preparer,node_version:'24.21.0',platform:'linux-x64'};
   const handlers=createHandlers(createStore(app),createGit(),{allowedRepositories:[repo],assertQuiescent:r=>host.quiesce(r)});
   await handlers.call('project.register',{project:p},'codeworks_admin');
   if(kind==='hotfix')await owner.query('INSERT INTO codeworks.deployment_evidence(id,project_id,target,commit_sha,evidence_url) VALUES($1,$2,$3,$4,$5)',[randomUUID(),p.id,'prod',base,'https://fixture.invalid/deployment']);
   const work=async(id,crash='')=>{const child=launchWorker(p.common_dir,id,{...process.env,CODEWORKS_DATABASE_URL:c.app_url,CODEWORKS_ALLOWED_REPOSITORIES:JSON.stringify([repo]),CODEWORKS_TEST_MODE:'1',CODEWORKS_TEST_CRASH_AFTER:crash});children.push(child);await new Promise(resolve=>child.once('close',resolve));};
   host=await createAgentHost({state_root:state,projects:[p.id],adapter_project_id:p.id,executors:{codex:{},hermes:{}},require_immutable:false,onError:e=>console.error(e.message)},async(method,args,executor)=>{const result=await handlers.call(method,args,executor);if(method==='prepare-write')void work(result.operation_id);return result;});
   const control=r=>socketCall(state+'/control.sock',r),codex=await control({action:'open',project_id:p.id,executor_id:'codex'}),call=r=>socketCall(codex.socket,r);
   const element=randomUUID(),move=randomUUID(),attempt=randomUUID();await call({action:'kind',kind,element_id:element,move_id:move,attempt_id:attempt});
   assert.equal((await call({action:'status'})).workspace,null);
   await call({action:'batch',operations:[{op:'write',path:'fix.txt',content:'dirty handoff\n'}]});
   const status=await call({action:'status'});assert.equal(status.workspace.kind,kind);assert.equal(status.workspace.element_id,element);assert.equal(status.attachments[0].move_id,move);assert.equal(status.attachments[0].attempt_id,attempt);
   await assert.rejects(call({action:'kind',kind:kind==='feature'?'hotfix':'feature'}),/KIND_ALREADY_FIXED/);
   const hermes=await control({action:'open',project_id:p.id,executor_id:'hermes'});await control({action:'quiesce',session_id:codex.session_id});await control({action:'attach',session_id:hermes.session_id,workspace_id:status.workspace.id});
   for(const request of [{action:'commit',request_key:'revoked',message:'no'},{action:'request-release',request_key:'revoked'},{action:'batch',operations:[{op:'write',path:'fix.txt',content:'lost'}]}])await assert.rejects(call(request),/WRITER_FENCED/);
   const hc=r=>socketCall(hermes.socket,r);assert.equal((await hc({action:'read',path:'fix.txt'})).content,'dirty handoff\n');
   const accepted=await hc({action:'commit',request_key:'commit1',message:'Stage6 bridge'});
   const repeated=await hc({action:'commit',request_key:'commit1',message:'Stage6 bridge'});assert.equal(repeated.operation.id,accepted.operation_id);
   await work(accepted.operation_id,'after-commit');
   assert.equal((await hc({action:'commit',request_key:'commit1',message:'Stage6 bridge'})).operation.status,'running');
   // Restart actual host while immutable worker plan and changed Git ref are durable.
   await host.close();host=null;
   await work(accepted.operation_id);
   const after=await handlers.call('operation-status',{project_id:p.id,operation_id:accepted.operation_id},'hermes');assert.equal(after.operation.status,'succeeded');const sha=after.operation.result.commit_sha;
   assert.equal((await git('rev-list','--count',base+'..'+status.workspace.branch)).stdout,'1');assert.equal((await command('git',['-C',status.workspace.path,'status','--porcelain'])).stdout,'');
   const releaseArgs={project_id:p.id,workspace_id:status.workspace.id,session_id:hermes.session_id,expected_epoch:2,idempotency_key:'release1',commit_sha:sha,target:kind==='feature'?'dev':'prod'};
   host=await createAgentHost({state_root:state,projects:[p.id],adapter_project_id:p.id,executors:{codex:{},hermes:{}},require_immutable:false},handlers.call);
   const release=await hc({action:'request-release',request_key:'release1'});assert.deepEqual(await hc({action:'request-release',request_key:'release1'}),release);
   const row=(await owner.query('SELECT requested_sha,target FROM codeworks.releases WHERE operation_id=$1',[release.operation_id])).rows[0];assert.deepEqual(row,{requested_sha:sha,target:releaseArgs.target});
   await host.close();host=null;
   await assert.rejects(handlers.call('commit',{project_id:p.id,workspace_id:status.workspace.id,session_id:hermes.session_id,expected_epoch:2,idempotency_key:'after-release',message:'no'},'hermes'),{code:'WRITER_BUSY'});
  }
 }finally{await host?.close();for(const child of children)if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await Promise.all([owner.end(),app.end()]);await rm(temporary,{recursive:true,force:true});await rm(socketRoot,{recursive:true,force:true});}
});
