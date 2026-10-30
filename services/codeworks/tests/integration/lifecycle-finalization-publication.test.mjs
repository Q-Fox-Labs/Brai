// ABOUTME: Проверяет закрытую неудачную попытку и последующую проверенную публикацию через public cleanup.
// ABOUTME: Использует disposable PostgreSQL, Git origin и отдельный Temporal worker без внешних выпусков.
import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,access} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {Pool} from 'pg';
import {Connection,Client} from '@temporalio/client';
import {NativeConnection,Worker,bundleWorkflowCode} from '@temporalio/worker';
import {setup,configured,prepareWith} from './fixture.mjs';
import {command,createGit,gitResourcesAbsent} from '../../src/git.mjs';
import {createFlowGit} from '../../src/git-flow.mjs';
import {createActivityGit,localGitStep} from '../../src/git-steps.mjs';
import {createStore} from '../../src/storage.mjs';
import {createHandlers} from '../../src/domain.mjs';
import {createActivities,deliverCommands} from '../../src/temporal.mjs';
import {reconcileProjectLedger} from '../../src/reconciler.mjs';
import {acquireTarget,releaseTarget} from '../../src/lifecycle.mjs';
import {createCodeIndex} from '../../src/code-index.mjs';
import {processProjectCompletions} from '../../src/completion-inbox.mjs';

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,timeout=60000){const end=Date.now()+timeout;while(Date.now()<end){if(await check())return;await sleep(100);}throw Error('PUBLICATION_CLEANUP_TIMEOUT');}

test('explicit cleanup preserves failed A after a later verified B contains its exact result',{timeout:180000},async t=>{
  assert.ok(configured&&process.env.CODEWORKS_TEMPORAL_ADDRESS&&process.env.CODEWORKS_TEMPORAL_NAMESPACE,'explicit disposable PostgreSQL and Temporal are required');
  const f=await setup({strictVerifier:true});let connection,native,client,workflow;const ids=new Set();
  t.after(async()=>{for(const id of ids)await client?.workflow.getHandle(id).terminate('isolated fixture cleanup').catch(()=>{});await native?.close();await connection?.close();await f.close();});
  const project=await f.project({github:{repository:'fixture/repository',required_checks:[{name:'checks',app_id:42}]},codeIndexDisabled:true});
  const flowGit=createFlowGit({localRemote:true,requireLock:()=>{}}),git=createGit({flowGit});
  let entered=false,releaseStep,localRefsRemoved=false;const gate=new Promise(resolve=>{releaseStep=resolve;});t.after(()=>releaseStep());
  // Local child steps use real Git under flock; the parent verifies/deletes the disposable bare remote.
  const adapters=createActivityGit({flowGit,step:async(method,p,workspace,args)=>{if(method==='cleanupStep'&&args[1]==='worktree'){entered=true;await gate;}const result=await localGitStep(method,{...p,github:undefined},workspace,args);if(method==='cleanupStep'&&args[1]==='local_refs')localRefsRemoved=true;return result;}});
  const handlers=createHandlers(createStore(f.app),git,{allowedRepositories:[project.repo_path],flowGit});
  const prepared=await prepareWith(handlers.call,{project_id:project.id,workspace_key:'published-result',request_key:'prepare-publication'});
  await f.worker(project,prepared.operation_id);
  const w=(await f.app.query('SELECT * FROM codeworks.workspaces WHERE id=$1',[prepared.workspace_id])).rows[0];
  const write={project_id:project.id,workspace_id:w.id,workspace_key:w.workspace_key,session_id:'publication-session',turn_id:'turn',tool_use_id:'write',tool_name:'apply_patch',payload_sha256:'a'.repeat(64),targets:['hello.txt'],request_key:'publication-write'};
  const call=await handlers.call('write.begin',write,'codex');await handlers.call('write.admit',{project_id:project.id,write_call_id:call.write_call_id,rewritten_sha256:'b'.repeat(64)},'codex');
  await writeFile(w.path+'/hello.txt','published result\n');await handlers.call('write.finish',{project_id:project.id,session_id:write.session_id,turn_id:write.turn_id,tool_use_id:write.tool_use_id,tool_name:'apply_patch',input_sha256:'b'.repeat(64),canonical_input_sha256:'b'.repeat(64),outcome:'success'},'codex');await processProjectCompletions(f.app,project.id,{allowedRepositories:[project.repo_path],git});
  const local=(...args)=>command('git',['-C',w.path,...args]),repo=(...args)=>command('git',['-C',project.repo_path,...args]);
  await local('add','hello.txt');await local('commit','-m','accepted result');const accepted=(await local('rev-parse','HEAD')).stdout;
  await repo('push','origin',w.branch);await repo('merge','--ff-only',w.branch);await repo('commit','--allow-empty','-m','later delivery');const installed=(await repo('rev-parse','HEAD')).stdout;await repo('push','origin','dev');
  const attempt=randomUUID(),delivery=randomUUID(),rollout=randomUUID(),evidence=randomUUID(),other=randomUUID(),composition={source:installed,components:[]},digest='sha256:'+'c'.repeat(64),url='https://fixture.invalid/publication/'+evidence;
  await f.owner.query("INSERT INTO codeworks.workspaces(id,project_id,workspace_key,kind,base_ref,base_sha,branch,path,ownership_token) VALUES($1,$2,'delivery','feature','refs/heads/dev',$3,'feature/delivery',$4,$5)",[other,project.id,w.base_sha,project.workspace_root+'/'+other,randomUUID()]);
  for(const [id,workspace,status] of [[attempt,w.id,'failed'],[delivery,other,'succeeded']])await f.owner.query("INSERT INTO codeworks.operations(id,project_id,workspace_id,executor_id,kind,status,step,request) VALUES($1,$2,$3,'codex','release',$4,'fixture','{}')",[id,project.id,workspace,status]);
  await f.owner.query("INSERT INTO codeworks.releases(id,workspace_id,operation_id,target,requested_sha,state,closed_at) VALUES($1,$2,$3,'dev',$4,'failed',now()-interval '1 minute')",[randomUUID(),w.id,attempt,accepted]);
  const details={primary:{merged:true,target:'dev',merge_sha:installed,deployment_evidence_id:evidence}};
  await f.owner.query("INSERT INTO codeworks.releases(id,workspace_id,operation_id,target,requested_sha,state,details) VALUES($1,$2,$3,'dev',$4,'succeeded',$5)",[randomUUID(),other,delivery,installed,details]);
  await f.owner.query("INSERT INTO codeworks.operations(id,project_id,executor_id,kind,status,step,request) VALUES($1,$2,'codeworks_owner','rollout','succeeded','done','{}')",[rollout,project.id]);
  const receipt={verified:true,operation_id:rollout,project_id:project.id,target:'dev',commit_sha:installed,composition_digest:digest,composition,evidence_url:url};
  await f.owner.query("INSERT INTO codeworks.deployments(operation_id,project_id,target,commit_sha,run_id,attempt,composition_digest,composition,receipt,release_operation_id) VALUES($1,$2,'dev',$3,'fixture','1',$4,$5,$6,$7)",[rollout,project.id,installed,digest,composition,receipt,delivery]);
  await f.owner.query("INSERT INTO codeworks.deployment_evidence(id,project_id,target,commit_sha,evidence_url) VALUES($1,$2,'dev',$3,$4)",[evidence,project.id,installed,url]);
  await f.owner.query("INSERT INTO codeworks.installed(project_id,target,operation_id,composition) VALUES($1,'dev',$2,$3)",[project.id,rollout,composition]);
  // Exercise the production role split: app can read but cannot write trusted verifier data.
  for(const table of ['installed','deployment_evidence','verified_ci']){
    for(const privilege of ['INSERT','UPDATE']){
      const permission=await f.app.query('SELECT has_table_privilege(current_user,$1,$2) AS allowed',['codeworks.'+table,privilege]);
      assert.equal(permission.rows[0].allowed,false,`${table} ${privilege} must remain verifier-only`);
    }
  }
  await assert.rejects(f.app.query("UPDATE codeworks.installed SET composition=composition WHERE project_id=$1",[project.id]),{code:'42501'});
  await assert.rejects(f.app.query("INSERT INTO codeworks.installed(project_id,target,operation_id,composition) VALUES($1,'dev',$2,$3)",[project.id,rollout,composition]),{code:'42501'});
  await assert.rejects(f.app.query("UPDATE codeworks.deployment_evidence SET evidence_url=evidence_url WHERE id=$1",[evidence]),{code:'42501'});
  await assert.rejects(f.app.query("INSERT INTO codeworks.deployment_evidence(id,project_id,target,commit_sha,evidence_url) VALUES($1,$2,'dev',$3,$4)",[randomUUID(),project.id,installed,url+'/forged']),{code:'42501'});
  const acl=(await f.owner.query("SELECT has_function_privilege('public','codeworks.lock_publication_evidence(text,uuid,uuid)','EXECUTE') AS public_execute")).rows[0];
  assert.equal(acl.public_execute,false);
  const definer=(await f.owner.query("SELECT prosecdef,proconfig,pg_get_userbyid(proowner)=current_user AS owned FROM pg_proc WHERE oid='codeworks.lock_publication_evidence(text,uuid,uuid)'::regprocedure")).rows[0];
  assert.equal(definer.prosecdef,true);assert.equal(definer.owned,true);assert.deepEqual(definer.proconfig,['search_path=pg_catalog']);
  const verifier=new Pool({connectionString:f.config.verifier_url,max:1}),locked=await f.app.connect(),verifierClient=await verifier.connect();
  let pending;
  try{
    assert.equal((await verifierClient.query("SELECT has_table_privilege(current_user,'codeworks.installed','UPDATE') AS allowed")).rows[0].allowed,true);
    assert.equal((await verifierClient.query("SELECT has_table_privilege(current_user,'codeworks.deployment_evidence','INSERT') AS allowed")).rows[0].allowed,true);
    assert.equal((await locked.query("SELECT has_function_privilege(current_user,'codeworks.lock_publication_evidence(text,uuid,uuid)','EXECUTE') AS allowed")).rows[0].allowed,true);
    await locked.query('BEGIN');
    const appPid=(await locked.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const verifierPid=(await verifierClient.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    assert.equal((await locked.query('SELECT codeworks.lock_publication_evidence($1,$2,$3) AS locked',[project.id,randomUUID(),evidence])).rows[0].locked,false);
    assert.equal((await locked.query('SELECT codeworks.lock_publication_evidence($1,$2,$3) AS locked',[project.id,rollout,randomUUID()])).rows[0].locked,false);
    assert.equal((await locked.query('SELECT codeworks.lock_publication_evidence($1,$2,$3) AS locked',[project.id,rollout,evidence])).rows[0].locked,true);
    pending=verifierClient.query("UPDATE codeworks.installed SET composition=composition WHERE project_id=$1 AND target='dev'",[project.id]);
    await until(async()=>((await f.owner.query('SELECT $1::int=ANY(pg_blocking_pids($2)) AS blocked',[appPid,verifierPid])).rows[0].blocked),10000);
    await locked.query('COMMIT');assert.equal((await pending).rowCount,1);pending=null;
  }finally{
    await locked.query('ROLLBACK').catch(()=>{});if(pending)await pending.catch(()=>{});
    locked.release();verifierClient.release();await verifier.end();
  }
  workflow='codeworks/fixture/'+project.id+'/workspace/'+w.id;
  await f.owner.query("INSERT INTO codeworks.execution_control(project_id,instance_id,owner) VALUES($1,'fixture','temporal')",[project.id]);
  await f.owner.query("INSERT INTO codeworks.workflow_registry(workflow_id,project_id,workspace_id,owner) VALUES($1,$2,$3,'temporal')",[workflow,project.id,w.id]);
  await reconcileProjectLedger(f.app,project.id,'fixture-reconciler');
  assert.equal((await f.app.query('SELECT count(*)::int AS n FROM codeworks.cleanup_obligations WHERE workspace_id=$1',[w.id])).rows[0].n,0,'no explicit cleanup means no automatic closure');
  const cleanup=key=>handlers.call('cleanup',{project_id:project.id,workspace_id:w.id,request_key:key},'codex');
  await f.owner.query("UPDATE codeworks.deployments SET receipt=jsonb_set(receipt,'{verified}','false') WHERE operation_id=$1",[rollout]);
  await assert.rejects(cleanup('unverified'),{code:'CONFLICT'});await f.owner.query('UPDATE codeworks.deployments SET receipt=$2 WHERE operation_id=$1',[rollout,receipt]);
  await f.owner.query("UPDATE codeworks.releases SET details='{}' WHERE operation_id=$1",[delivery]);await assert.rejects(cleanup('mismatched-delivery'),{code:'CONFLICT'});await f.owner.query('UPDATE codeworks.releases SET details=$2 WHERE operation_id=$1',[delivery,details]);
  const newer=randomUUID();await f.owner.query("INSERT INTO codeworks.operations(id,project_id,executor_id,kind,status,step,request,archived) VALUES($1,$2,'codeworks_owner','rollout','failed','fixture','{}',true)",[newer,project.id]);
  await f.owner.query("INSERT INTO codeworks.deployments(operation_id,project_id,target,commit_sha,run_id,attempt,composition_digest,composition,receipt,created_at) VALUES($1,$2,'dev',$3,'newer','1',$4,$5,'{\"verified\":false}',now()+interval '1 second')",[newer,project.id,installed,digest,composition]);
  await f.owner.query('UPDATE codeworks.operations SET archived=false WHERE id=$1',[newer]);await assert.rejects(cleanup('newer-unverified'),{code:'CONFLICT'});await f.owner.query('UPDATE codeworks.operations SET archived=true WHERE id=$1',[newer]);
  await writeFile(w.path+'/hello.txt','dirty\n');await assert.rejects(cleanup('dirty'),{code:'CONFLICT'});await local('checkout','--','hello.txt');
  await local('commit','--allow-empty','-m','unpublished');await assert.rejects(cleanup('new-head'),{code:'CONFLICT'});await local('reset','--hard',accepted);
  const uncertain={...write,turn_id:'later',tool_use_id:'uncertain',request_key:'uncertain-writer'};
  const u=await handlers.call('write.begin',uncertain,'codex');await handlers.call('write.admit',{project_id:project.id,write_call_id:u.write_call_id,rewritten_sha256:'d'.repeat(64)},'codex');
  await handlers.call('write.stop',{project_id:project.id,session_id:uncertain.session_id,turn_id:uncertain.turn_id,event:'Stop'},'codex');await assert.rejects(cleanup('unknown-writer'),{code:'CONFLICT'});
  await handlers.call('write.finish',{project_id:project.id,session_id:uncertain.session_id,turn_id:uncertain.turn_id,tool_use_id:uncertain.tool_use_id,tool_name:'apply_patch',input_sha256:'d'.repeat(64),canonical_input_sha256:'d'.repeat(64),outcome:'success'},'codex');await processProjectCompletions(f.app,project.id,{allowedRepositories:[project.repo_path],git});
  const address=process.env.CODEWORKS_TEMPORAL_ADDRESS,namespace=process.env.CODEWORKS_TEMPORAL_NAMESPACE,taskQueue='codeworks-publication-'+randomUUID();
  const holder=randomUUID(),challenger=randomUUID();
  for(const id of [holder,challenger])await f.owner.query("INSERT INTO codeworks.operations(id,project_id,executor_id,kind,status,step,request,archived) VALUES($1,$2,'codeworks_owner','rollout','succeeded','fixture','{}',true)",[id,project.id]);
  await f.owner.query("INSERT INTO codeworks.release_queue(project_id,target,operation_id,state) VALUES($1,'dev',$2,'held')",[project.id,holder]);
  connection=await Connection.connect({address,connectTimeout:'5 seconds'});client=new Client({connection,namespace});native=await NativeConnection.connect({address});ids.add(workflow);
  const bundle=await bundleWorkflowCode({workflowsPath:fileURLToPath(new URL('../../src/workflows.cjs',import.meta.url))});
  const actualIndex=createCodeIndex(f.app);let altered=false;
  const codeIndex={...actualIndex,inspect:async(...args)=>{const result=await actualIndex.inspect(...args);if(localRefsRemoved&&!altered){altered=true;await f.owner.query("UPDATE codeworks.deployments SET receipt=jsonb_set(receipt,'{verified}','false') WHERE operation_id=$1",[rollout]);}return result;}};
  const worker=await Worker.create({connection:native,namespace,taskQueue,workflowBundle:bundle,activities:createActivities(f.app,{allowedRepositories:[project.repo_path],adapters,codeIndex}),maxConcurrentActivityTaskExecutions:4});
  await worker.runUntil(async()=>{
    const acceptedCleanup=await cleanup('explicit-cleanup');await deliverCommands(f.app,client,{taskQueue});
    await until(async()=>(await f.app.query('SELECT blocker FROM codeworks.cleanup_obligations WHERE workspace_id=$1',[w.id])).rows[0]?.blocker==='DEV_TARGET_BUSY');
    await access(w.path);assert.equal(await flowGit.remote(project,w.branch),accepted,'held DEV lane prevents deletion');
    await f.owner.query("UPDATE codeworks.release_queue SET state='closed' WHERE operation_id=$1",[holder]);
    await f.owner.query("UPDATE codeworks.cleanup_obligations SET state='pending',next_attempt_at=NULL WHERE workspace_id=$1",[w.id]);
    await client.workflow.getHandle(workflow).signal('commandsAvailable');await until(()=>entered,30000);
    const lane=await f.app.connect();let acquired=false;
    try{
      const attempt=acquireTarget(lane,project.id,'dev',challenger).then(value=>{acquired=value;return value;});
      await sleep(300);assert.equal(acquired,false,'new DEV acquisition waits for destructive cleanup');
      releaseStep();assert.equal(await attempt,true);await releaseTarget(lane,challenger,'dev','closed');
    }finally{releaseStep();lane.release();}
    await until(async()=>(await f.app.query('SELECT blocker FROM codeworks.cleanup_obligations WHERE workspace_id=$1',[w.id])).rows[0]?.blocker==='DELIVERY_PROOF_CHANGED');
    assert.equal((await f.app.query('SELECT removed_at FROM codeworks.workspaces WHERE id=$1',[w.id])).rows[0].removed_at,null,'changed receipt cannot finalize');
    await f.owner.query('UPDATE codeworks.deployments SET receipt=$2 WHERE operation_id=$1',[rollout,receipt]);
    await f.owner.query("UPDATE codeworks.cleanup_obligations SET state='pending',blocker=NULL,next_attempt_at=NULL WHERE workspace_id=$1",[w.id]);
    await client.workflow.getHandle(workflow).signal('commandsAvailable');
    await until(async()=>{
      const obligation=(await f.app.query('SELECT state,step,blocker FROM codeworks.cleanup_obligations WHERE workspace_id=$1',[w.id])).rows[0];
      if(obligation?.state==='waiting_decision')throw Error('PUBLICATION_BLOCKED '+JSON.stringify(obligation));
      return (await f.app.query('SELECT removed_at FROM codeworks.workspaces WHERE id=$1',[w.id])).rows[0]?.removed_at;
    });
    assert.equal((await f.app.query('SELECT status FROM codeworks.operations WHERE id=$1',[acceptedCleanup.operation_id])).rows[0].status,'succeeded');
    const obligation=(await f.app.query('SELECT state,outcome,evidence FROM codeworks.cleanup_obligations WHERE workspace_id=$1',[w.id])).rows[0];
    assert.equal(obligation.state,'done');assert.equal(obligation.outcome,'released');assert.equal(obligation.evidence.publication.original_attempt_id,attempt);assert.equal(obligation.evidence.publication.source_accepted_sha,accepted);
  });
  assert.equal((await f.app.query('SELECT status FROM codeworks.operations WHERE id=$1',[attempt])).rows[0].status,'failed');
  assert.equal((await f.app.query('SELECT state FROM codeworks.releases WHERE operation_id=$1',[attempt])).rows[0].state,'failed');
  await assert.rejects(access(w.path));assert.equal(await flowGit.remote(project,w.branch),null);
  assert.notEqual((await command('git',['-C',project.repo_path,'show-ref','--verify','refs/heads/'+w.branch],{allowFailure:true})).code,0);
  assert.ok(gitResourcesAbsent(await git.inspectResources(project,w)));
});

test('legacy successful release admits cleanup without a publication lookup',{timeout:120000},async t=>{
  assert.ok(configured,'explicit disposable PostgreSQL is required');
  const f=await setup();t.after(()=>f.close());const p=await f.project();
  const area=await f.prepare({project_id:p.id,workspace_key:'legacy-success',request_key:'legacy-success'});await f.worker(p,area.operation_id);
  const w=(await f.app.query('SELECT * FROM codeworks.workspaces WHERE id=$1',[area.workspace_id])).rows[0],release=randomUUID();
  await f.owner.query("INSERT INTO codeworks.operations(id,project_id,workspace_id,executor_id,kind,status,step,request) VALUES($1,$2,$3,'codex','release','succeeded','done','{}')",[release,p.id,w.id]);
  await f.owner.query("INSERT INTO codeworks.releases(id,workspace_id,operation_id,target,requested_sha,state) VALUES($1,$2,$3,'dev',$4,'succeeded')",[randomUUID(),w.id,release,w.base_sha]);
  const workflow='codeworks/fixture/'+p.id+'/workspace/'+w.id;
  await f.owner.query("INSERT INTO codeworks.execution_control(project_id,instance_id,owner) VALUES($1,'fixture','temporal')",[p.id]);
  await f.owner.query("INSERT INTO codeworks.workflow_registry(workflow_id,project_id,workspace_id,owner) VALUES($1,$2,$3,'temporal')",[workflow,p.id,w.id]);
  const handlers=createHandlers(createStore(f.app),createGit(),{allowedRepositories:[p.repo_path],flowGit:{ancestor:()=>assert.fail('publication lookup must not run')}});
  const cleanup=await handlers.call('cleanup',{project_id:p.id,workspace_id:w.id,request_key:'legacy-cleanup'},'codex');
  const row=(await f.app.query('SELECT * FROM codeworks.cleanup_obligations WHERE workspace_id=$1',[w.id])).rows[0];
  assert.equal(row.outcome,'released');assert.equal(row.source_operation_id,cleanup.operation_id);assert.equal(row.state,'pending');
  const registry=(await f.app.query('SELECT state,lifecycle,outcome FROM codeworks.workflow_registry WHERE workspace_id=$1',[w.id])).rows[0];
  assert.deepEqual(registry,{state:'draining',lifecycle:'closing',outcome:'released'});
});

test('existing cleanup obligation admits retry without a new publication or network lookup',{timeout:120000},async t=>{
  assert.ok(configured,'explicit disposable PostgreSQL is required');
  const f=await setup();t.after(()=>f.close());const p=await f.project();
  const area=await f.prepare({project_id:p.id,workspace_key:'existing-obligation',request_key:'existing-obligation'});await f.worker(p,area.operation_id);
  const owner='codeworks/fixture/'+p.id+'/workspace/'+area.workspace_id,id=randomUUID();
  await f.owner.query("INSERT INTO codeworks.execution_control(project_id,instance_id,owner) VALUES($1,'fixture','temporal')",[p.id]);
  await f.owner.query("INSERT INTO codeworks.workflow_registry(workflow_id,project_id,workspace_id,owner,state,lifecycle) VALUES($1,$2,$3,'temporal','draining','closing')",[owner,p.id,area.workspace_id]);
  await f.owner.query("INSERT INTO codeworks.cleanup_obligations(id,project_id,workspace_id,subject_key,outcome,state,owner_workflow_id,epoch) VALUES($1,$2,$3,$4,'cancelled','waiting_decision',$5,1)",[id,p.id,area.workspace_id,'workspace:'+area.workspace_id,owner]);
  const git={...createGit(),inspectResources:()=>assert.fail('existing obligation must not inspect publication')};
  const handlers=createHandlers(createStore(f.app),git,{allowedRepositories:[p.repo_path],flowGit:{ancestor:()=>assert.fail('existing obligation must not access network')}});
  const cleanup=await handlers.call('cleanup',{project_id:p.id,workspace_id:area.workspace_id,request_key:'existing-cleanup'},'codex');
  assert.ok(cleanup.operation_id);assert.equal((await f.app.query('SELECT count(*)::int AS n FROM codeworks.cleanup_obligations WHERE workspace_id=$1',[area.workspace_id])).rows[0].n,1);
});
