// ABOUTME: Проверяет обновление основной копии через настоящий Temporal и создание следующей задачи.
// ABOUTME: GitHub и установка заданы fixture-портами; Git, PostgreSQL, preparer и worker restart настоящие.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile,copyFile,chmod,stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Connection,Client} from '@temporalio/client';
import {NativeConnection,Worker,bundleWorkflowCode} from '@temporalio/worker';
import {setup,configured} from './fixture.mjs';
import {command,createGit,gitResourcesAbsent} from '../../src/git.mjs';
import {createFlowGit} from '../../src/git-flow.mjs';
import {createActivityGit} from '../../src/git-steps.mjs';
import {createActivities,deliverCommands} from '../../src/temporal.mjs';
import {runOperation} from '../../src/worker.mjs';
import {recordDeployment} from '../../src/deployment-evidence.mjs';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(work,timeout=90000){const end=Date.now()+timeout;while(!await work()){assert.ok(Date.now()<end,'checkout fixture timed out');await sleep(100);}}

test('Temporal release reconciles source conflict and lost FF receipt, then prepares the next task',{timeout:300000},async t=>{
  assert.ok(configured&&process.env.CODEWORKS_TEST_SOURCE_HELPER,'explicit disposable DB and operator helper are required');
  const flowGit=createFlowGit({localRemote:true,requireLock:()=>{}});
  const f=await setup({git:createGit({flowGit})});let worker,running,delivery,connection,native;const workflows=[];
  t.after(async()=>{
    clearInterval(delivery);
    if(worker?.getState()==='RUNNING')worker.shutdown();
    await running;
    if(connection){const client=new Client({connection,namespace:process.env.CODEWORKS_TEMPORAL_NAMESPACE});for(const id of workflows)await client.workflow.getHandle(id).terminate('fixture cleanup').catch(()=>{});}
    await native?.close();await connection?.close();await f.close();
  });
  const required=[{name:'Codeworks components',app_id:42}],p=await f.project({sharedFixture:true,codeIndexDisabled:true,github:{repository:'fixture/repository',required_checks:required}});
  const g=(...args)=>command('git',['-C',p.repo_path,...args]);
  const base=(await g('rev-parse','HEAD')).stdout;
  const protectedArea=await f.prepare({project_id:p.id,workspace_key:'protected-source-reader',request_key:'protected-source-reader'});await f.worker(p,protectedArea.operation_id);
  const protectedFile=await readFile(path.join(protectedArea.path,'hello.txt'),'utf8'),shared=await readFile(path.join(p.repo_path,'node_modules/shared-readonly/keep.js'),'utf8');
  await copyFile(process.env.CODEWORKS_TEST_SOURCE_HELPER,path.join(p.common_dir,'hooks/synchronize-brai-source'));await chmod(path.join(p.common_dir,'hooks/synchronize-brai-source'),0o755);
  await f.owner.query("INSERT INTO codeworks.execution_control(project_id,instance_id,owner) VALUES($1,'checkout-fixture','temporal')",[p.id]);
  const adapters=createActivityGit({flowGit});
  let currentWorkspace,crashed=false;
  const prs=[],github={
    find:async(_,leg)=>prs.find(pr=>pr.head.ref===leg.branch&&pr.base.ref===leg.target)??null,
    create:async(_,leg,body)=>{const pr={number:prs.length+1,html_url:'https://github.com/fixture/repository/pull/1',body,state:'open',merged:false,head:{sha:leg.head,ref:leg.branch,repo:{full_name:p.github.repository}},base:{ref:leg.target,repo:{full_name:p.github.repository}}};prs.push(pr);return pr;},
    get:async(_,number)=>{
      const pr=prs.find(v=>v.number===number),r=(await f.app.query('SELECT details FROM codeworks.releases WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 1',[currentWorkspace])).rows[0];
      if(r?.details.primary?.merge_sha&&await flowGit.verifyMerge(p,r.details.primary)){pr.merged=true;pr.state='closed';pr.merge_commit_sha=r.details.primary.merge_sha;}return pr;
    },
    checks:async(_,sha)=>[{name:'Codeworks components',app_id:42,sha,status:'completed',conclusion:'success'}],
  };
  connection=await Connection.connect({address:process.env.CODEWORKS_TEMPORAL_ADDRESS});
  native=await NativeConnection.connect({address:process.env.CODEWORKS_TEMPORAL_ADDRESS});
  const namespace=process.env.CODEWORKS_TEMPORAL_NAMESPACE,queue='cw-checkout-'+randomUUID(),client=new Client({connection,namespace});
  const bundle=await bundleWorkflowCode({workflowsPath:fileURLToPath(new URL('../../src/workflows.cjs',import.meta.url))});
  const start=async()=>{
    worker=await Worker.create({connection:native,namespace,taskQueue:queue,workflowBundle:bundle,shutdownGraceTime:'2 seconds',shutdownForceTime:'10 seconds',
      activities:createActivities(f.app,{allowedRepositories:[p.repo_path],adapters:{...adapters,github,deploymentAdapter:null},
        execute:async(pool,id,git,options)=>runOperation(pool,id,git,{...options,checkpoint:async stage=>{
          await options.checkpoint(stage);
          if(stage==='after-local-checkout'&&!crashed){crashed=true;throw Object.assign(Error('lost source receipt'),{code:'TEST_INTERRUPTION'});}
        }})})});
    running=worker.run();
  };
  const stop=async()=>{worker.shutdown();await running;};
  await start();
  delivery=setInterval(()=>deliverCommands(f.app,client,{taskQueue:queue}).catch(()=>{}),100);
  const op=async id=>(await f.h.call('status',{project_id:p.id,operation_id:id},'codex')).operation;
  const prepared=await f.prepare({project_id:p.id,workspace_key:'source-change',request_key:'source-change'});
  currentWorkspace=prepared.workspace_id;
  await until(async()=>(await op(prepared.operation_id)).status==='succeeded');
  const w=(await f.app.query('SELECT * FROM codeworks.workspaces WHERE id=$1',[currentWorkspace])).rows[0];
  const workflow=(await f.app.query('SELECT workflow_id FROM codeworks.workflow_registry WHERE workspace_id=$1',[w.id])).rows[0].workflow_id;workflows.push(workflow);
  const manifest=JSON.parse(await readFile(path.join(w.path,'packages/leaf/package.json'),'utf8')),lock=JSON.parse(await readFile(path.join(w.path,'package-lock.json'),'utf8'));
  manifest.dependencies={'shared-readonly':'1.0.0'};lock.packages['packages/leaf'].dependencies=manifest.dependencies;
  await writeFile(path.join(w.path,'packages/leaf/package.json'),JSON.stringify(manifest)+'\n');await writeFile(path.join(w.path,'package-lock.json'),JSON.stringify(lock)+'\n');
  await command('git',['-C',w.path,'add','packages/leaf/package.json','package-lock.json']);await command('git',['-C',w.path,'commit','-m','Declare existing prepared dependency']);
  const head=(await command('git',['-C',w.path,'rev-parse','HEAD'])).stdout;
  await writeFile(path.join(p.repo_path,'hello.txt'),'foreign uncommitted edit\n');await writeFile(path.join(p.repo_path,'foreign-untracked'),'preserve me\n');
  const release=await f.h.call('release',{project_id:p.id,workspace_id:w.id,commit_sha:head,request_key:'release-source-change'},'codex');
  await until(async()=>(await op(release.operation_id)).status==='awaiting_deployment');
  const merged=(await op(release.operation_id)).result.details.primary.merge_sha;
  await recordDeployment(f.app,{project_id:p.id,target:'dev',commit_sha:merged,evidence_url:'https://fixture.invalid/checkout/'+merged},{allowedRepositories:[p.repo_path]});
  await client.workflow.getHandle(workflow).signal('commandsAvailable');
  await until(async()=>(await op(release.operation_id)).step==='LOCAL_CHECKOUT_DIRTY');
  assert.equal((await g('rev-parse','HEAD')).stdout,base);assert.equal(await readFile(path.join(p.repo_path,'hello.txt'),'utf8'),'foreign uncommitted edit\n');
  assert.equal((await f.app.query('SELECT count(*)::int AS n FROM codeworks.cleanup_obligations WHERE workspace_id=$1',[w.id])).rows[0].n,0);
  await stop();
  await writeFile(path.join(p.repo_path,'hello.txt'),protectedFile);
  await start();await client.workflow.getHandle(workflow).signal('commandsAvailable');
  await until(()=>crashed);await stop();
  assert.equal((await g('rev-parse','HEAD')).stdout,merged,'real FF did not occur before lost receipt');
  const interrupted=(await f.app.query('SELECT details FROM codeworks.releases WHERE operation_id=$1',[release.operation_id])).rows[0];
  assert.equal(interrupted.details.primary.local_checkout,undefined,'lost receipt was falsely persisted');
  await start();await client.workflow.getHandle(workflow).signal('commandsAvailable');
  await until(async()=>(await client.workflow.getHandle(workflow).describe()).status.name==='COMPLETED');
  assert.equal((await op(release.operation_id)).status,'succeeded');
  assert.equal((await op(release.operation_id)).result.details.primary.local_checkout.commit_sha,merged);
  assert.equal(gitResourcesAbsent(await createGit({flowGit}).inspectResources(p,w)),true);
  assert.equal(await readFile(path.join(p.repo_path,'foreign-untracked'),'utf8'),'preserve me\n');
  assert.equal(await readFile(path.join(protectedArea.path,'hello.txt'),'utf8'),protectedFile);
  assert.equal(await readFile(path.join(p.repo_path,'node_modules/shared-readonly/keep.js'),'utf8'),shared);
  assert.ok(await stat(protectedArea.path));
  const next=await f.prepare({project_id:p.id,workspace_key:'after-release',request_key:'after-release'});
  await until(async()=>(await op(next.operation_id)).status==='succeeded');
  const nextArea=(await f.app.query('SELECT * FROM codeworks.workspaces WHERE id=$1',[next.workspace_id])).rows[0];
  assert.equal(nextArea.base_sha,merged);assert.equal((await g('rev-parse','HEAD')).stdout,merged);
  assert.deepEqual(JSON.parse(await readFile(path.join(next.path,'packages/leaf/package.json'),'utf8')).dependencies,manifest.dependencies);
  await command(p.preparer_path,['--check',next.path]);
  const nextWorkflow=(await f.app.query('SELECT workflow_id FROM codeworks.workflow_registry WHERE workspace_id=$1',[next.workspace_id])).rows[0].workflow_id;workflows.push(nextWorkflow);
  await f.h.call('workspace.cancel',{project_id:p.id,workspace_id:next.workspace_id,request_key:'finish-after-release',reason:'Disposable verification completed'},'codex');
  await until(async()=>(await client.workflow.getHandle(nextWorkflow).describe()).status.name==='COMPLETED');
  assert.equal(gitResourcesAbsent(await createGit({flowGit}).inspectResources(p,nextArea)),true);
  assert.ok(await stat(protectedArea.path));
});
