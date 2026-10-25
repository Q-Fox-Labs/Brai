// ABOUTME: Проверяет durable доставку, fencing, очередь и replay с настоящими Temporal, PostgreSQL и Git.
// ABOUTME: Изолирует task queue и disposable БД; общий Temporal и чужие workflow не останавливает.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {createFlowGit} from '../../src/git-flow.mjs';
import {executionContext} from '../../src/execution-context.mjs';
import {createActivityGit} from '../../src/git-steps.mjs';
import {randomUUID} from 'node:crypto';
import {writeFile,mkdir,readFile,copyFile,rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {Connection,Client} from '@temporalio/client';
import {Worker,bundleWorkflowCode} from '@temporalio/worker';
import {Pool} from 'pg';
import {createHandlers} from '../../src/domain.mjs';
import {createStore} from '../../src/storage.mjs';
import {createGit,command} from '../../src/git.mjs';
import {transitionInventory,importTransition,resumeReconciledCommand} from '../../src/transition.mjs';
import {connectionProxy} from './temporal-proxy.mjs';
import proto from '@temporalio/proto';
const {temporal}=proto;
import {setup,configured} from './fixture.mjs';
import {deliverCommands,createActivities} from '../../src/temporal.mjs';
import {authorizeCommand,acquireTarget,releaseTarget} from '../../src/lifecycle.mjs';
import {launchWorker,startRuntime} from '../../src/runtime.mjs';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(work,timeout=60000){const end=Date.now()+timeout;for(;;){if(await work())return;assert.ok(Date.now()<end,'fixture condition timed out');await sleep(100);}}
test('Temporal durable lifecycle acceptance',{skip:!configured||process.env.CODEWORKS_TEMPORAL_TEST!=='1',timeout:360000},async t=>{
  const f=await setup(),project=await f.project();
  const root=path.join(project.workspace_root,'temporal-fixture');await mkdir(root);
  const config={databaseURL:f.config.app_url,allowedRepositories:[project.repo_path],address:process.env.CODEWORKS_TEMPORAL_ADDRESS??'127.0.0.1:7233',namespace:process.env.CODEWORKS_TEMPORAL_NAMESPACE??'brai',taskQueue:'codeworks-fixture-'+randomUUID(),...(process.env.CODEWORKS_PREVIOUS_WORKFLOW_BUNDLE?{bundle:process.env.CODEWORKS_PREVIOUS_WORKFLOW_BUNDLE}:{}),crashOnce:path.join(root,'crashed')};
  const configFile=path.join(root,'private.json');await writeFile(configFile,JSON.stringify(config),{mode:0o600});
  const connection=await Connection.connect({address:config.address,connectTimeout:'5 seconds'}),client=new Client({connection,namespace:config.namespace});
  let child;const workflowIds=new Set();
  async function start(){child=spawn(process.execPath,[fileURLToPath(new URL('./temporal-worker.mjs',import.meta.url)),configFile],{stdio:['ignore','ignore','pipe']});child.stderr.on('data',data=>{writeFile(fileURLToPath(new URL('../../../../tmp/codeworks-temporal/worker.log',import.meta.url)),data,{flag:'a',mode:0o600}).catch(()=>{});});child.once('error',()=>{});}
  async function stop(signal='SIGTERM'){if(!child)return;const c=child;child=null;if(c.exitCode!==null||c.signalCode!==null)return;const done=new Promise(r=>c.once('close',r));c.kill(signal);await done;}
  t.after(async()=>{await stop();for(const id of workflowIds)await client.workflow.getHandle(id).terminate('isolated fixture cleanup').catch(()=>{});await connection.close();await f.close();});
  await f.owner.query("INSERT INTO codeworks.execution_control(project_id,instance_id,owner) VALUES($1,'fixture','temporal')",[project.id]);
  const prepare=(key)=>f.h.call('prepare',{project_id:project.id,workspace_key:key,request_key:'prepare-'+key},'codex');
  const status=id=>f.app.query('SELECT status FROM codeworks.operations WHERE id=$1',[id]).then(r=>r.rows[0].status);
  const first=await prepare('first');
  const row=(await f.app.query('SELECT * FROM codeworks.commands WHERE operation_id=$1',[first.operation_id])).rows[0];workflowIds.add(row.workflow_id);
  await t.test('commit without Temporal delivery and lost response retain one operation',async()=>{
    const repeated=await prepare('first');assert.deepEqual(first,repeated);
    assert.equal(row.sequence,'1');assert.equal(row.delivered_at,null);
    const db=await f.app.connect();try{
      await assert.rejects(authorizeCommand(db,first.operation_id,'untrusted-workflow',1),{code:'FORBIDDEN'});
      await assert.rejects(authorizeCommand(db,first.operation_id,row.workflow_id,2),{code:'FORBIDDEN'});
    }finally{db.release();}
  });
  await t.test('PostgreSQL commit succeeds while its response is lost; retry returns the admitted operation',async()=>{
    const url=new URL(f.config.app_url),proxy=await connectionProxy(url.hostname,Number(url.port),{dropOnCommit:true});url.hostname='127.0.0.1';url.port=proxy.address.split(':')[1];
    const runtime=await startRuntime({databaseURL:url.toString(),startRecovery:false,allowedRepositories:[project.repo_path]});
    try{
      await assert.rejects(runtime.call('prepare',{project_id:project.id,workspace_key:'lost-commit',request_key:'prepare-lost-commit'},'codex'));
      const admitted=await prepare('lost-commit');
      const record=(await f.app.query('SELECT workflow_id FROM codeworks.commands WHERE operation_id=$1',[admitted.operation_id])).rows[0];workflowIds.add(record.workflow_id);
      assert.equal((await f.app.query("SELECT count(*) FROM codeworks.requests WHERE idempotency_key='prepare-lost-commit'")).rows[0].count,'1');
    }finally{await runtime.close();await proxy.close();}
  });
  await t.test('connection outage leaves notifications durable without stopping the shared Temporal',async()=>{
    const [host,port]=config.address.split(':'),proxy=await connectionProxy(host,Number(port));
    const lost=await Connection.connect({address:proxy.address,connectTimeout:'3 seconds'}),offline=new Client({connection:lost,namespace:config.namespace});
    try{proxy.drop();await lost.withDeadline(Date.now()+1000,()=>deliverCommands(f.app,offline,{taskQueue:config.taskQueue}));
      assert.equal((await f.app.query('SELECT delivered_at FROM codeworks.commands WHERE operation_id=$1',[first.operation_id])).rows[0].delivered_at,null);
    }finally{await lost.close();await proxy.close();}
  });
  await start();
  await t.test('SIGKILL during Git preparation retries same checkpoint without a second attempt',async()=>{
    await deliverCommands(f.app,client,{taskQueue:config.taskQueue,continueAfter:2});
    await until(async()=>await status(first.operation_id)==='succeeded');
    assert.equal((await f.app.query('SELECT count(*) FROM codeworks.operations WHERE workspace_id=$1',[first.workspace_id])).rows[0].count,'1');
    assert.equal(await readFile(config.crashOnce,'utf8'),'interruption');
    const w=(await f.h.call('status',{project_id:project.id,workspace_id:first.workspace_id},'codex')).workspace;
    assert.equal(w.preparation_state,'ready');assert.equal(w.base_sha,(await f.app.query('SELECT base_sha FROM codeworks.workspaces WHERE id=$1',[w.id])).rows[0].base_sha);
  });
  await t.test('worker SIGKILL and upgrade A to copied immutable bundle B preserve workflow identity',async()=>{
    await stop('SIGKILL');
    const history=await client.workflow.getHandle(row.workflow_id).fetchHistory();
    const serialized=temporal.api.history.v1.History.toObject(history,{longs:String,enums:String,bytes:String});
    await writeFile(path.join(root,'history.json'),JSON.stringify(serialized));
    if(process.env.CODEWORKS_PREVIOUS_WORKFLOW_BUNDLE)assert.ok(history.events.some(e=>e.activityTaskScheduledEventAttributes?.activityType?.name==='executeCommand'),'replay must cover the installed coarse Activity history');
    const bundle=fileURLToPath(new URL('../../dist/workflows.js',import.meta.url));
    await Worker.runReplayHistory({workflowBundle:{codePath:bundle}},temporal.api.history.v1.History.fromObject(serialized),row.workflow_id);
    const generated=fileURLToPath(new URL('../../../../tmp/codeworks-temporal/',import.meta.url));await mkdir(generated,{recursive:true});
    assert.ok(!JSON.stringify(serialized).includes(decodeURIComponent(new URL(f.config.app_url).password)));
    await writeFile(path.join(generated,'saved-history.json'),JSON.stringify(serialized));
    const wrapper=path.join(generated,'fixture-b.cjs'),source=fileURLToPath(new URL('../../src/workflows.cjs',import.meta.url));
    await writeFile(wrapper,"const {patched,proxyActivities}=require('@temporalio/workflow');exports.unadmitted=async id=>proxyActivities({startToCloseTimeout:'5 seconds',retry:{maximumAttempts:1}}).executeCommand(id,1);const {codeworksWorkspace:base}=require("+JSON.stringify(source)+");exports.codeworksWorkspace=async state=>{patched('codeworks-compatible-fixture-v2');return base(state)};\n");
    const next=path.join(generated,'artifact-b-workflows.js'),bundleB=await bundleWorkflowCode({workflowsPath:wrapper});await writeFile(next,bundleB.code);
    await Worker.runReplayHistory({workflowBundle:{codePath:next}},temporal.api.history.v1.History.fromObject(serialized),row.workflow_id);
    config.bundle=next;await writeFile(configFile,JSON.stringify(config),{mode:0o600});
    const second=await prepare('second');const c=(await f.app.query('SELECT workflow_id FROM codeworks.commands WHERE operation_id=$1',[second.operation_id])).rows[0];workflowIds.add(c.workflow_id);
    await start();await deliverCommands(f.app,client,{taskQueue:config.taskQueue});
    await until(async()=>await status(second.operation_id)==='succeeded');
    const cancelled=await f.h.call('workspace.cancel',{project_id:project.id,workspace_id:second.workspace_id,request_key:'cancel-second',reason:'fixture complete'},'codex');
    await deliverCommands(f.app,client,{taskQueue:config.taskQueue,continueAfter:2});await until(async()=>await status(cancelled.operation_id)==='succeeded');
    await until(async()=>(await f.app.query('SELECT state FROM codeworks.workflow_registry WHERE workflow_id=$1',[c.workflow_id])).rows[0].state==='completed');
    const lifecycle=await f.h.call('lifecycle.status',{project_id:project.id,workspace_id:second.workspace_id},'codex');assert.equal(lifecycle.task_status,'cancelled');
    await assert.rejects(f.h.call('prepare',{project_id:project.id,workspace_key:'second',request_key:'revive'},'codex'),{code:'CONFLICT'});
    assert.equal((await f.h.call('status',{project_id:project.id,workspace_id:second.workspace_id},'codex')).git.dirty,false);
  });
  await t.test('a direct Temporal activity without the admitted Workflow ID cannot authorize effects',async()=>{
    const id='codeworks-fixture-unadmitted-'+randomUUID();workflowIds.add(id);
    const before=(await f.app.query('SELECT to_jsonb(o) AS value FROM codeworks.operations o WHERE id=$1',[first.operation_id])).rows;
    const handle=await client.workflow.start('unadmitted',{workflowId:id,taskQueue:config.taskQueue,args:[first.operation_id]});
    await assert.rejects(handle.result());
    assert.deepEqual((await f.app.query('SELECT to_jsonb(o) AS value FROM codeworks.operations o WHERE id=$1',[first.operation_id])).rows,before);
  });
  await t.test('a command across Continue-As-New remains admitted once with the same stable Workflow ID',async()=>{
    const before=await client.workflow.getHandle(row.workflow_id).describe();
    const w=(await f.app.query('SELECT * FROM codeworks.workspaces WHERE id=$1',[first.workspace_id])).rows[0];
    const request={project_id:project.id,workspace_id:w.id,commit_sha:w.base_sha,request_key:'sync-across-continue'};
    const accepted=await f.h.call('sync',request,'codex');
    await deliverCommands(f.app,client,{taskQueue:config.taskQueue});
    await until(async()=>['succeeded','failed'].includes(await status(accepted.operation_id)));
    await until(async()=>(await client.workflow.getHandle(row.workflow_id).describe()).runId!==before.runId);
    assert.deepEqual(await f.h.call('sync',request,'codex'),accepted);
    assert.equal((await f.app.query('SELECT count(*) FROM codeworks.commands WHERE operation_id=$1',[accepted.operation_id])).rows[0].count,'1');
  });
  await t.test('FIFO survives postmerge failure; explicit retry transfers held lane; PROD/DEV are separate',async()=>{
    const db=await f.app.connect();
    try{
      const ids=[randomUUID(),randomUUID(),randomUUID()];
      for(const id of ids)await f.owner.query("INSERT INTO codeworks.operations(id,project_id,workspace_id,executor_id,kind,status,step,request) VALUES($1,$2,$3,'codex','release','failed','fixture',$4)",[id,project.id,first.workspace_id,{commit_sha:'a'.repeat(40)}]);
      for(const id of ids)await f.owner.query("INSERT INTO codeworks.releases(id,workspace_id,operation_id,target,requested_sha,state,details,retry_of) VALUES($1,$2,$3,'dev',$4,'failed','{}',$5)",[randomUUID(),first.workspace_id,id,'a'.repeat(40),id===ids[2]?ids[0]:null]);
      assert.equal(await acquireTarget(db,project.id,'dev',ids[0]),true);
      assert.equal(await acquireTarget(db,project.id,'dev',ids[1]),false);
      assert.equal(await acquireTarget(db,project.id,'prod',ids[1]),true);await releaseTarget(db,ids[1],'prod');
      assert.equal(await acquireTarget(db,project.id,'dev',ids[2],ids[0]),true);
      assert.equal(await acquireTarget(db,project.id,'dev',ids[1]),false);
      await releaseTarget(db,ids[2],'dev','closed');assert.equal(await acquireTarget(db,project.id,'dev',ids[1]),true);
      await releaseTarget(db,ids[1],'dev');
    }finally{db.release();}
  });
  await t.test('closing an unknown installation keeps its lane; confirmed failure frees only the attempt',async()=>{
    const releaseId=randomUUID(),deploymentId=randomUUID(),merge='b'.repeat(40),head='a'.repeat(40);
    await f.owner.query("INSERT INTO codeworks.operations(id,project_id,workspace_id,executor_id,kind,status,step,request) VALUES($1,$2,$3,'codex','release','awaiting_reconciliation','fixture',$4)",[releaseId,project.id,first.workspace_id,{commit_sha:head}]);
    await f.owner.query("INSERT INTO codeworks.operations(id,project_id,executor_id,kind,status,step,request) VALUES($1,$2,'codeworks_owner','rollout','awaiting_reconciliation','fixture',$3)",[deploymentId,project.id,{target:'dev',commit_sha:merge}]);
    await f.owner.query("INSERT INTO codeworks.deployments(operation_id,project_id,target,commit_sha,run_id,attempt,composition_digest,composition,release_operation_id) VALUES($1,$2,'dev',$3,'1','1',$4,'{}',$5)",[deploymentId,project.id,merge,'sha256:'+'c'.repeat(64),releaseId]);
    const details={primary:{branch:first.branch,head,target:'dev',target_sha:head,merge_sha:merge,merge_push_attempted:true,merged:true,deployment_operation_id:deploymentId}};
    await f.owner.query("INSERT INTO codeworks.releases(id,workspace_id,operation_id,target,requested_sha,state,details) VALUES($1,$2,$3,'dev',$4,'awaiting_reconciliation',$5)",[randomUUID(),first.workspace_id,releaseId,head,details]);
    await f.owner.query("INSERT INTO codeworks.release_queue(project_id,target,operation_id,state) VALUES($1,'dev',$2,'held')",[project.id,releaseId]);
    const request={project_id:project.id,workspace_id:first.workspace_id,release_operation_id:releaseId,request_key:'close-failed-release',reason:'Вернуть задачу на доработку'};
    const close=await f.h.call('release.close',request,'codex');
    const depRegistry=(await f.app.query('SELECT workflow_id FROM codeworks.commands WHERE operation_id=$1',[deploymentId])).rows[0];workflowIds.add(depRegistry.workflow_id);
    await deliverCommands(f.app,client,{taskQueue:config.taskQueue});
    await until(async()=>(await f.app.query('SELECT step FROM codeworks.operations WHERE id=$1',[close.operation_id])).rows[0].step==='ROLLOUT_NOT_TERMINAL');
    assert.equal((await f.app.query("SELECT state FROM codeworks.release_queue WHERE operation_id=$1",[releaseId])).rows[0].state,'held');
    const cancellation=await f.h.call('workspace.cancel',{project_id:project.id,workspace_id:first.workspace_id,request_key:'unsafe-cancel',reason:'fixture'},'codex');
    await deliverCommands(f.app,client,{taskQueue:config.taskQueue});await until(async()=>await status(cancellation.operation_id)==='failed');
    await f.owner.query("UPDATE codeworks.operations SET status='failed' WHERE id=$1",[deploymentId]);
    await f.owner.query("UPDATE codeworks.deployments SET receipt=$2 WHERE operation_id=$1",[deploymentId,{status:'failed',operation_id:deploymentId,code:'CONFIRMED_FIXTURE_FAILURE'}]);
    await client.workflow.getHandle(row.workflow_id).signal('commandsAvailable');await until(async()=>await status(close.operation_id)==='succeeded');
    assert.deepEqual(await f.h.call('release.close',request,'codex'),close);
    assert.equal((await f.app.query("SELECT state FROM codeworks.release_queue WHERE operation_id=$1",[releaseId])).rows[0].state,'closed');
    const task=await f.h.call('lifecycle.status',{project_id:project.id,workspace_id:first.workspace_id},'codex');assert.equal(task.task_status,'active');
    assert.equal((await f.h.call('status',{project_id:project.id,workspace_id:first.workspace_id},'codex')).git.dirty,false);
  });
  await t.test('duplicate and reversed notifications do not create business attempts',async()=>{
    const before=(await f.app.query('SELECT count(*) FROM codeworks.operations')).rows[0].count;
    await Promise.all([client.workflow.getHandle(row.workflow_id).signal('commandsAvailable'),client.workflow.getHandle(row.workflow_id).signal('commandsAvailable')]);
    await deliverCommands(f.app,client,{taskQueue:config.taskQueue,continueAfter:2});await sleep(1000);
    assert.equal((await f.app.query('SELECT count(*) FROM codeworks.operations')).rows[0].count,before);
  });
  await t.test('bounded Activity retries freeze one command; confirmed reconciliation resumes the same ID',async()=>{
    const request=await prepare('technical-failure'),record=(await f.app.query('SELECT workflow_id FROM codeworks.commands WHERE operation_id=$1',[request.operation_id])).rows[0];workflowIds.add(record.workflow_id);
    await stop();config.failOperation=request.operation_id;await writeFile(configFile,JSON.stringify(config),{mode:0o600});await start();
    await deliverCommands(f.app,client,{taskQueue:config.taskQueue});
    await until(async()=>await status(request.operation_id)==='awaiting_reconciliation');
    assert.equal((await f.app.query('SELECT state FROM codeworks.commands WHERE operation_id=$1',[request.operation_id])).rows[0].state,'reconciliation');
    assert.equal((await client.workflow.getHandle(record.workflow_id).describe()).status.name,'RUNNING');
    const db=await f.owner.connect();try{
      await assert.rejects(resumeReconciledCommand(db,request.operation_id),/CONFIRMED_RECONCILIATION_REQUIRED/);
      await resumeReconciledCommand(db,request.operation_id,{confirmed:true});
    }finally{db.release();}
    await stop();delete config.failOperation;await writeFile(configFile,JSON.stringify(config),{mode:0o600});await start();
    await deliverCommands(f.app,client,{taskQueue:config.taskQueue});await until(async()=>await status(request.operation_id)==='succeeded');
    assert.deepEqual(await prepare('technical-failure'),request);
  });
  await t.test('independent Ansible installs immutable Codeworks A → B while its Temporal rollout survives restart',{skip:!process.env.CODEWORKS_TEMPORAL_FIXTURE_ROOT,timeout:180000},async()=>{
    await stop();
    const base=process.env.CODEWORKS_TEMPORAL_FIXTURE_ROOT,input=path.join(base,'input.json');await mkdir(base,{recursive:true});
    const id=randomUUID(),artifactA='/tmp/codeworks-temporal-artifact-'+id+'-a',artifactB='/tmp/codeworks-temporal-artifact-'+id+'-b';
    const source=fileURLToPath(new URL('../../../../',import.meta.url)).replace(/\/$/,'');
    const pkg=JSON.parse(await readFile(path.join(source,'tmp/codeworks-temporal/package.log'),'utf8'))[0].artifact.path;
    const adapter=process.env.CODEWORKS_TEMPORAL_FIXTURE_ADAPTER;
    const fixture={...config,source,projectId:project.id,artifactA,artifactB,original:pkg,nextBundle:path.join(source,'tmp/codeworks-temporal/artifact-b-workflows.js'),environment:{CODEWORKS_TEMPORAL_ADDRESS:config.address,CODEWORKS_TEMPORAL_NAMESPACE:config.namespace,CODEWORKS_TEMPORAL_TASK_QUEUE:config.taskQueue,CODEWORKS_DEPLOYMENT_CONFIG:adapter}};
    await writeFile(input,JSON.stringify(fixture),{mode:0o600});
    const ansible=async action=>{const result=await command('/usr/bin/ansible-playbook',['-i','localhost,','-c','local','/srv/projects/admin/ansible/playbooks/operations/codeworks_temporal_service_fixture.yml','-e',JSON.stringify({codeworks_fixture_action:action,codeworks_fixture_input:input,codeworks_fixture_source:source})],{timeout:120000,allowFailure:true,env:{...process.env,ANSIBLE_CONFIG:'/srv/projects/admin/ansible/ansible.cfg'}});await writeFile(path.join(base,'ansible-'+action+'.log'),result.stdout+'\n'+result.stderr);assert.equal(result.code,0,'fixture Ansible '+action+': '+result.stdout.slice(-2500)+' '+result.stderr);};
    try{
      await ansible('prepare');await ansible('start');
      const manifest=JSON.parse(await readFile(path.join(artifactB,'artifact-manifest.json'),'utf8'));
      const head=(await f.app.query('SELECT base_sha FROM codeworks.workspaces WHERE id=$1',[first.workspace_id])).rows[0].base_sha;
      const composition={source:head,components:[{id:'codeworks',artifact:{digest:'sha256:'+manifest.payloadHash}}]};
      await f.owner.query("INSERT INTO codeworks.operations(id,project_id,executor_id,kind,status,step,request) VALUES($1,$2,'codeworks_owner','rollout','pending','verified-ci',$3)",[id,project.id,{target:'dev',commit_sha:head}]);
      await f.owner.query("INSERT INTO codeworks.deployments(operation_id,project_id,target,commit_sha,run_id,attempt,composition_digest,composition) VALUES($1,$2,'dev',$3,'42','1',$4,$5)",[id,project.id,head,'sha256:'+'d'.repeat(64),composition]);
      const ledger=(await f.app.query('SELECT workflow_id FROM codeworks.commands WHERE operation_id=$1',[id])).rows[0];workflowIds.add(ledger.workflow_id);
      await until(async()=>await status(id)==='succeeded',100000);
      assert.equal(await import('node:fs/promises').then(m=>m.realpath(base+'/current')),artifactB);
      const result=JSON.parse(await readFile(base+'/'+id+'/result.json','utf8'));assert.equal(result.receipt.operation_id,id);assert.equal(result.receipt.verified,true);
      assert.equal((await f.app.query('SELECT count(*) FROM codeworks.deployments WHERE operation_id=$1',[id])).rows[0].count,'1');
      assert.equal((await f.app.query("SELECT count(*) FROM codeworks.deployment_evidence WHERE evidence_url=$1",[result.receipt.evidence_url])).rows[0].count,'1');
      assert.equal(JSON.parse(await readFile(base+'/'+id+'/installation.json','utf8')).operation_id,id);
      await writeFile(path.join(source,'tmp/codeworks-temporal/self-update.json'),JSON.stringify({workflow_id:ledger.workflow_id,operation_id:id,sha:head,artifact_digest:'sha256:'+manifest.payloadHash,receipt:result.receipt},null,2));
    }finally{await ansible('stop');await start();}
  });
  await t.test('slow GitHub, duplicate Activity and SIGKILL leave admission and independent workspace execution available',{timeout:100000},async()=>{
    await stop();
    const p=await f.project({github:{repository:'fixture/repository',required_checks:[{name:'checks',app_id:42}]}});
    await f.owner.query("INSERT INTO codeworks.execution_control(project_id,instance_id,owner) VALUES($1,'fixture','temporal')",[p.id]);
    const flowGit=createFlowGit({localRemote:true,requireLock:()=>{}}),adapters=createActivityGit({flowGit});
    const handlers=createHandlers(createStore(f.app),createGit({flowGit}),{allowedRepositories:[p.repo_path]});
    const prepareArea=key=>handlers.call('prepare',{project_id:p.id,workspace_key:key,request_key:'prepare-'+key},'codex');
    const remember=async op=>{workflowIds.add((await f.app.query('SELECT workflow_id FROM codeworks.commands WHERE operation_id=$1',[op.operation_id])).rows[0].workflow_id);return op;};
    let releaseSlow,entered=false,requests=0,pgBlocked=false,pgEntered=false,releasePG;const created=new Map();
    const pgGate=new Promise(resolve=>{releasePG=resolve;});
    const gate=new Promise(resolve=>{releaseSlow=resolve;});
    const server=createServer(async(req,res)=>{
      let input='';for await(const chunk of req)input+=chunk;
      const leg=JSON.parse(input);
      if(req.url==='/find'){
        if(leg.branch==='feature/slow-github'){entered=true;requests++;await gate;}
        if(pgBlocked&&leg.branch==='feature/fast-github'){pgEntered=true;await pgGate;}
        res.end(JSON.stringify(created.get(leg.branch)??null));
      }else{
        assert.equal(req.url,'/create');assert.equal(created.has(leg.branch),false,'one PR per admitted synchronization');
        const pr={number:created.size+1,html_url:'https://fixture.invalid/pr/'+leg.branch,body:leg.body,state:'open',merged:false,head:{sha:leg.head,ref:leg.branch,repo:{full_name:p.github.repository}},base:{ref:leg.target,repo:{full_name:p.github.repository}}};
        created.set(leg.branch,pr);res.end(JSON.stringify(pr));
      }
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const previousAllowed=config.allowedRepositories;
    try{
      config.githubURL='http://127.0.0.1:'+server.address().port+'/';config.allowedRepositories=[...previousAllowed,p.repo_path];
      await writeFile(configFile,JSON.stringify(config),{mode:0o600});await start();
      const slow=await remember(await prepareArea('slow-github')),fast=await remember(await prepareArea('fast-github'));
      await deliverCommands(f.app,client,{taskQueue:config.taskQueue});await until(async()=>await status(slow.operation_id)==='succeeded'&&await status(fast.operation_id)==='succeeded');
      const sha=(await f.app.query('SELECT base_sha FROM codeworks.workspaces WHERE id=$1',[slow.workspace_id])).rows[0].base_sha;
      const request={project_id:p.id,workspace_id:slow.workspace_id,commit_sha:sha,request_key:'slow-sync'};
      const sync=await remember(await handlers.call('sync',request,'codex'));
      await deliverCommands(f.app,client,{taskQueue:config.taskQueue});await until(()=>entered);
      const acquired=await command('/usr/bin/flock',['-n',path.join(p.common_dir,'codeworks.lock'),'/usr/bin/true'],{allowFailure:true});assert.equal(acquired.code,0,'network must not own the shared Git lock');
      assert.deepEqual(await handlers.call('sync',request,'codex'),sync);
      const accepted=await remember(await prepareArea('admitted-during-network'));
      const next=await remember(await handlers.call('sync',{...request,workspace_id:fast.workspace_id,request_key:'fast-sync'},'codex'));
      await deliverCommands(f.app,client,{taskQueue:config.taskQueue});
      await until(async()=>await status(accepted.operation_id)==='succeeded'&&await status(next.operation_id)==='succeeded');
      assert.equal(await status(sync.operation_id),'running');
      const id=(await f.app.query('SELECT workflow_id FROM codeworks.commands WHERE operation_id=$1',[sync.operation_id])).rows[0].workflow_id;
      await createActivities(f.app,{allowedRepositories:[p.repo_path],adapters,identity:()=>id}).synchronizeBranch(sync.operation_id,1);
      assert.equal(requests,1,'duplicate Activity must not repeat an in-flight request');
      await stop('SIGKILL');await start();releaseSlow();
      await client.workflow.getHandle(id).signal('commandsAvailable');await until(async()=>await status(sync.operation_id)==='succeeded');
      assert.equal(created.size,2);assert.deepEqual(await handlers.call('sync',request,'codex'),sync);
      const history=await client.workflow.getHandle(id).fetchHistory();
      assert.ok(history.events.some(e=>e.activityTaskScheduledEventAttributes?.activityType?.name==='synchronizeBranch'));
      await Worker.runReplayHistory({workflowBundle:{codePath:config.bundle}},history,id);
      await stop();
      const endpoint=new URL(f.config.app_url),proxy=await connectionProxy(endpoint.hostname,Number(endpoint.port));
      endpoint.hostname='127.0.0.1';endpoint.port=proxy.address.split(':')[1];
      const isolated=new Pool({connectionString:endpoint.toString(),max:2,connectionTimeoutMillis:1000});
      const reconciled=await handlers.call('sync',{...request,workspace_id:fast.workspace_id,request_key:'sync-lost-execution-db'},'codex');
      const ownId=(await f.app.query('SELECT workflow_id FROM codeworks.commands WHERE operation_id=$1',[reconciled.operation_id])).rows[0].workflow_id;
      const network={find:async(_,leg)=>{const r=await fetch(config.githubURL+'find',{method:'POST',body:JSON.stringify(leg),signal:executionContext()?.signal});return r.json();}};
      const ownActivities=createActivities(isolated,{allowedRepositories:[p.repo_path],adapters:{...adapters,github:network},identity:()=>ownId});
      try{
        pgBlocked=true;
        const interrupted=assert.rejects(ownActivities.synchronizeBranch(reconciled.operation_id,1));
        await until(()=>pgEntered);proxy.drop();await interrupted;
        assert.equal(await status(reconciled.operation_id),'running','lost execution session preserves its admitted command');
        assert.deepEqual(await handlers.call('sync',{...request,workspace_id:fast.workspace_id,request_key:'sync-lost-execution-db'},'codex'),reconciled);
        proxy.restore();pgBlocked=false;releasePG();
        await ownActivities.synchronizeBranch(reconciled.operation_id,1);
        assert.equal(await status(reconciled.operation_id),'succeeded');assert.equal(created.size,2);
      }finally{releasePG();await isolated.end();await proxy.close();}
      let readStarted=false,releaseRead;const readGate=new Promise(resolve=>{releaseRead=resolve;});
      const realGit=createGit({flowGit});
      const slowAdmission=createHandlers(createStore(f.app),{...realGit,readBase:async(...args)=>{readStarted=true;await readGate;return realGit.readBase(...args);}},{allowedRepositories:[p.repo_path]});
      const waiting=slowAdmission.call('prepare',{project_id:p.id,workspace_key:'slow-base-read',request_key:'slow-base-read'},'codex');
      try{
        await until(()=>readStarted);
        await remember(await prepareArea('admitted-during-base-read'));
      }finally{releaseRead();await remember(await waiting);}
    }finally{
      releaseSlow();releasePG();await stop();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
      delete config.githubURL;config.allowedRepositories=previousAllowed;await writeFile(configFile,JSON.stringify(config),{mode:0o600});await start();
    }
  });
  await t.test('handoff imports preparation, CI, partial hotfix, unknown outcome and failed cleanup exactly once',async()=>{
    await stop();
    for(const state of ['preparation','ci','hotfix','unknown','cleanup']){
      const p=await f.project();
      if(state==='hotfix'){
        const base=(await command('git',['-C',p.repo_path,'rev-parse','dev'])).stdout;
        await f.owner.query("INSERT INTO codeworks.deployment_evidence(id,project_id,target,commit_sha,evidence_url) VALUES($1,$2,'prod',$3,'https://fixture.invalid/production-base')",[randomUUID(),p.id,base]);
      }
      const prepared=await f.h.call('prepare',{project_id:p.id,workspace_key:'migration-'+state,request_key:'migration-'+state,...(state==='hotfix'?{kind:'hotfix'}:{})},'codex');
      await f.worker(p,prepared.operation_id,state==='preparation'?'after-checkout':undefined);
      const w=(await f.app.query('SELECT * FROM codeworks.workspaces WHERE id=$1',[prepared.workspace_id])).rows[0];
      let rollout;
      if(state!=='preparation'){
        const release=randomUUID(),details={primary:{branch:w.branch,head:w.base_sha,target:state==='hotfix'?'main':'dev',target_sha:w.base_sha}};
        if(state==='hotfix'){
          const evidence=randomUUID();await f.owner.query("INSERT INTO codeworks.deployment_evidence(id,project_id,target,commit_sha,evidence_url) VALUES($1,$2,'prod',$3,'https://example.invalid/fixture')",[evidence,p.id,w.base_sha]);
          details.primary={...details.primary,merged:true,merge_sha:w.base_sha,deployment_evidence_id:evidence};details.backport={branch:w.branch,head:w.base_sha,target:'dev',target_sha:w.base_sha};
        }
        if(state==='unknown'){
          rollout=randomUUID();details.primary={...details.primary,merged:true,merge_sha:w.base_sha,merge_push_attempted:true,deployment_operation_id:rollout};
          await f.owner.query("INSERT INTO codeworks.operations(id,project_id,executor_id,kind,status,step,request) VALUES($1,$2,'codeworks_owner','rollout','running','launch',$3)",[rollout,p.id,{target:'dev',commit_sha:w.base_sha}]);
          await f.owner.query("INSERT INTO codeworks.deployments(operation_id,project_id,target,commit_sha,run_id,attempt,composition_digest,composition) VALUES($1,$2,'dev',$3,'1','1',$4,'{}')",[rollout,p.id,w.base_sha,'sha256:'+'d'.repeat(64)]);
        }
        const phase=state==='cleanup'?'succeeded':'awaiting_ci';
        await f.owner.query("INSERT INTO codeworks.operations(id,project_id,workspace_id,executor_id,kind,status,step,request) VALUES($1,$2,$3,'codex','release',$4,'checkpoint',$5)",[release,p.id,w.id,phase,{commit_sha:w.base_sha}]);
        await f.owner.query("INSERT INTO codeworks.releases(id,workspace_id,operation_id,target,requested_sha,state,details) VALUES($1,$2,$3,'dev',$4,$5,$6)",[randomUUID(),w.id,release,w.base_sha,phase,details]);
        if(state==='cleanup')await f.owner.query("INSERT INTO codeworks.operations(id,project_id,workspace_id,executor_id,kind,status,step,request) VALUES($1,$2,$3,'codex','cleanup','failed','remote-delete',$4)",[randomUUID(),p.id,w.id,{project_id:p.id,workspace_id:w.id,request_key:'cleanup-fixture'}]);
      }
      await f.owner.query("INSERT INTO codeworks.execution_control(project_id,instance_id,owner,mutations_paused) VALUES($1,'fixture-migration','legacy',true)",[p.id]);
      const removed=randomUUID();
      await f.owner.query("INSERT INTO codeworks.workspaces(id,project_id,workspace_key,kind,base_ref,base_sha,branch,path,ownership_token,removed_at) VALUES($1,$2,'old-removed','feature',$3,$4,'feature/old-removed',$5,$6,now())",[removed,p.id,w.base_ref,w.base_sha,path.join(p.workspace_root,removed),randomUUID()]);
      const before=await transitionInventory(f.app,p.id),db=await f.owner.connect();
      try{
        await assert.rejects(importTransition(db,p.id,'fixture-migration'),/STOPPED_EXECUTOR_REQUIRED/);
        const imported=await importTransition(db,p.id,'fixture-migration',{executorStopped:true,observations:rollout?{[rollout]:'unknown'}:{}});
        assert.equal(imported.already_applied,false);
        assert.equal((await importTransition(db,p.id,'fixture-migration',{executorStopped:true})).already_applied,true);
      }finally{db.release();}
      const after=await transitionInventory(f.app,p.id);assert.deepEqual(after.workspaces,before.workspaces);
      assert.equal(after.removed,1);assert.equal((await f.app.query('SELECT count(*) FROM codeworks.workflow_registry WHERE workspace_id=$1',[removed])).rows[0].count,'0');
      assert.equal((await f.app.query('SELECT count(*) FROM codeworks.workflow_registry WHERE workspace_id=$1',[w.id])).rows[0].count,'1');
      const oldPending=await createStore(f.app).pending(100);assert.equal(oldPending.some(o=>before.operations.some(old=>old.id===o.id)),false);
      if(rollout)assert.equal((await f.app.query('SELECT state FROM codeworks.commands WHERE operation_id=$1',[rollout])).rows[0].state,'reconciliation');
      if(state==='preparation')await assert.rejects(f.worker(p,prepared.operation_id),/FIXTURE_WORKER_FAILED/);
    }
  });
  await t.test('Ansible restores the ledger, request keys and CI proof in a separate database; saved history replays',{skip:!process.env.CODEWORKS_TEMPORAL_FIXTURE_ROOT,timeout:120000},async()=>{
    await stop();
    await f.owner.query("INSERT INTO codeworks.verified_ci(project_id,run_id,attempt,policy_sha256,proof) VALUES($1,'77','1',$2,$3)",[project.id,'e'.repeat(64),{fixture:true,source:'accepted-proof-preserved'}]);
    const result=await command('/usr/bin/sudo',['-n','/usr/bin/ansible-playbook','-i','/srv/projects/admin/ansible/inventory/hosts.yml','/srv/projects/admin/ansible/playbooks/operations/backup_brai_codeworks_temporal_fixture.yml'],{timeout:90000,allowFailure:true});
    assert.equal(result.code,0,'isolated backup/restore: '+result.stdout.slice(-1500));
    const restored=new Pool({connectionString:f.config.restore_owner_url,max:1});
    try{
      for(const table of ['projects','workspaces','operations','requests','releases','deployments','verified_ci','deployment_evidence','installed','execution_control','workflow_registry','commands','release_queue']){
        const sql='SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),\'[]\') AS rows FROM codeworks.'+table+' t';
        assert.deepEqual((await restored.query(sql)).rows,(await f.owner.query(sql)).rows,'restored '+table);
      }
      assert.deepEqual((await restored.query('SELECT * FROM public.codeworks_migrations ORDER BY version')).rows,(await f.owner.query('SELECT * FROM public.codeworks_migrations ORDER BY version')).rows);
      const history=await client.workflow.getHandle(row.workflow_id).fetchHistory();
      await Worker.runReplayHistory({workflowBundle:{codePath:config.bundle}},history,row.workflow_id);
    }finally{await restored.end();}
  });
  await mkdir(fileURLToPath(new URL('../../../../tmp/codeworks-temporal/',import.meta.url)),{recursive:true});
  await writeFile(fileURLToPath(new URL('../../../../tmp/codeworks-temporal/acceptance.json',import.meta.url)),JSON.stringify({workflow_ids:[...workflowIds],operation_id:first.operation_id,workspace_id:first.workspace_id,task_queue:config.taskQueue,namespace:config.namespace},null,2));
});
