// ABOUTME: Проверяет durable cleanup-resume на disposable PostgreSQL с настоящими блокировками.
// ABOUTME: Git, архив и индекс представлены read-only портами; рабочие службы и ресурсы не меняются.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {setup,configured} from './fixture.mjs';
import {resumeCleanup,cleanupEvidenceDigest} from '../../src/cleanup-resume.mjs';
import {canonical} from '../../src/contracts.mjs';

test('repair resumes its original request after EIO and preserves locks, refs, evidence and workflow identity',{timeout:120000},async t=>{
  assert.ok(configured,'explicit disposable PostgreSQL is required');
  const f=await setup();t.after(()=>f.close());
  const projectId='resume_'+randomUUID(),workspaceId=randomUUID(),obligationId=randomUUID(),token=randomUUID(),sha='a'.repeat(40);
  const project={id:projectId,repo_path:'/fixture/'+projectId,common_dir:'/fixture/'+projectId+'/.git',workspace_root:'/fixture/'+projectId+'/areas'};
  await f.owner.query('INSERT INTO codeworks.projects(id,config) VALUES($1,$2)',[projectId,project]);
  const workspace={id:workspaceId,project_id:projectId,branch:'feature/repair',path:project.workspace_root+'/'+workspaceId,base_sha:sha,ownership_token:token};
  await f.owner.query("INSERT INTO codeworks.workspaces(id,project_id,workspace_key,kind,base_ref,base_sha,branch,path,ownership_token) VALUES($1,$2,'repair','feature','refs/remotes/origin/dev',$3,$4,$5,$6)",[workspaceId,projectId,sha,workspace.branch,workspace.path,token]);
  await f.owner.query("INSERT INTO codeworks.execution_control(project_id,instance_id,owner) VALUES($1,'cleanup-resume','temporal')",[projectId]);
  const workflow='codeworks/cleanup-resume/'+projectId+'/workspace/'+workspaceId;
  await f.owner.query("INSERT INTO codeworks.workflow_registry(workflow_id,project_id,workspace_id,owner,state,lifecycle) VALUES($1,$2,$3,'temporal','draining','closing')",[workflow,projectId,workspaceId]);
  const expected={branch:{ref:'refs/heads/'+workspace.branch,oid:sha},remote:{ref:'refs/heads/'+workspace.branch,oid:null,known:true},tracking:{ref:'refs/remotes/origin/'+workspace.branch,oid:null},ownership:{ref:'refs/codeworks/ownership/'+workspaceId,oid:'b'.repeat(40),matches:true},worktree:{path:workspace.path,pathExists:true,registered:true,head:sha,dirty:false,owned:true,lock:'codeworks:'+token}};
  const archive={path:'/fixture/archive.bundle',sha256:'c'.repeat(64)},source={manifestVersion:1,reviewed:true,project_id:projectId,common_dir:project.common_dir,workspace_id:workspaceId,protected_task_ids:[],branch:expected.branch,remote:expected.remote,tracking:expected.tracking,ownership:expected.ownership,worktree:expected.worktree,disposition:{type:'archived',archive}};
  const manifest={...source,manifest_sha256:createHash('sha256').update(canonical(source)).digest('hex')},evidence={manifest,archive,archive_authorized:true};
  await f.owner.query("INSERT INTO codeworks.cleanup_obligations(id,project_id,workspace_id,subject_key,outcome,step,state,expected,evidence,owner_workflow_id,epoch,blocker) VALUES($1,$2,$3,$4,'cancelled','worktree','waiting_decision',$5,$6,$7,4,'ARCHIVE_UNVERIFIED')",[obligationId,projectId,workspaceId,'workspace:'+workspaceId,expected,evidence,workflow]);
  const read=async()=>(await f.app.query('SELECT * FROM codeworks.cleanup_obligations WHERE id=$1',[obligationId])).rows[0];
  const original=await read(),request={obligation_id:obligationId,expected_epoch:4,evidence_sha256:cleanupEvidenceDigest(original),request_key:'same-repair-key'};
  let once=true,inspectCount=0;
  const current=structuredClone(expected),ports={allowedRepositories:[project.repo_path],git:{inspectResources:async()=>{inspectCount++;return current;},cleanupStep:async()=>assert.fail('repair deleted Git resource')},codeIndex:{inspect:async()=>({complete:true,owner:{present:false},resources:{collections:[],metadataPoints:[]}}),remove:async()=>assert.fail('repair deleted index')},verifyArchive:async()=>{
    if(once){once=false;throw Object.assign(Error('archive read'),{code:'EIO'});}
    const guard=await f.app.connect();
    try{
      assert.equal((await guard.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired',['execution:workspace:'+workspaceId])).rows[0].acquired,false,'resume holds the same execution guard');
      for(const [table,idColumn,id] of [['workspaces','id',workspaceId],['workflow_registry','workflow_id',workflow],['cleanup_obligations','id',obligationId]]){
        await guard.query('BEGIN');await guard.query("SET LOCAL lock_timeout='100ms'");
        await assert.rejects(guard.query('SELECT 1 FROM codeworks.'+table+' WHERE '+idColumn+'=$1 FOR UPDATE',[id]),{code:'55P03'});
        await guard.query('ROLLBACK');
      }
    }finally{await guard.query('ROLLBACK').catch(()=>{});guard.release();}
  }};
  const unavailable=await resumeCleanup(f.app,projectId,request,ports);
  assert.equal(unavailable.status,'awaiting_reconciliation');assert.equal((await read()).epoch,'4');
  assert.equal((await f.app.query('SELECT count(*)::int AS n FROM codeworks.operations WHERE kind=\'repair\' AND project_id=$1',[projectId])).rows[0].n,1);
  const repaired=await resumeCleanup(f.app,projectId,request,ports);
  assert.equal(repaired.operation_id,unavailable.operation_id);assert.equal(repaired.status,'succeeded');assert.equal(repaired.epoch,5);
  const saved=await read();assert.equal(saved.state,'pending');assert.deepEqual(saved.expected,expected);assert.deepEqual(saved.evidence,evidence);assert.equal(saved.step,'worktree');
  const audit=(await f.app.query('SELECT * FROM codeworks.operations WHERE id=$1',[repaired.operation_id])).rows[0];assert.equal(audit.kind,'repair');assert.equal(audit.workspace_id,null);assert.equal(audit.executor_id,'codeworks_owner');assert.equal(audit.status,'succeeded');
  assert.equal((await f.app.query('SELECT count(*)::int AS n FROM codeworks.workflow_registry WHERE project_id=$1',[projectId])).rows[0].n,1);
  assert.equal((await f.app.query('SELECT count(*)::int AS n FROM codeworks.commands WHERE operation_id=$1',[repaired.operation_id])).rows[0].n,0);
  assert.deepEqual(await resumeCleanup(f.app,projectId,request,ports),{...repaired,duplicate:true});assert.equal(inspectCount,2);
  const stale=await resumeCleanup(f.app,projectId,{...request,request_key:'stale-epoch'},ports);
  assert.equal(stale.status,'failed');assert.equal(stale.blocker,'CLEANUP_FENCE_LOST');assert.equal((await read()).epoch,'5');
  await f.owner.query("UPDATE codeworks.cleanup_obligations SET state='waiting_decision',blocker='ARCHIVE_UNVERIFIED' WHERE id=$1",[obligationId]);
  const pinned=await read(),next={obligation_id:obligationId,expected_epoch:5,evidence_sha256:cleanupEvidenceDigest(pinned),request_key:'changed-ref'};
  current.branch.oid='f'.repeat(40);
  const changed=await resumeCleanup(f.app,projectId,next,ports);assert.equal(changed.status,'failed');assert.equal((await read()).epoch,'5');assert.equal((await read()).state,'waiting_decision');
});
