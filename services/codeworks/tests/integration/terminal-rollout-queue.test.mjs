// ABOUTME: Проверяет завершённые rollout с осиротевшей очередью на PostgreSQL и Temporal.
// ABOUTME: Квитанции синтетические только в disposable БД; рабочие службы и чужие workflow не меняет.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Connection,Client} from '@temporalio/client';
import {NativeConnection,Worker,bundleWorkflowCode} from '@temporalio/worker';
import {Pool} from 'pg';
import {setup,configured} from './fixture.mjs';
import {acquireTarget,reconcileSuccessfulRollouts} from '../../src/lifecycle.mjs';
import {advanceDeployment} from '../../src/deployment.mjs';
import {createActivities,deliverCommands} from '../../src/temporal.mjs';
import {runOperation} from '../../src/worker.mjs';
import {createActivityGit} from '../../src/git-steps.mjs';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){const deadline=Date.now()+90000;while(!await fn()){assert.ok(Date.now()<deadline,'rollout queue acceptance timed out');await sleep(100);}}

test('Temporal repairs terminal standalone lanes without reviving roots or losing atomic completion',{timeout:240000},async t=>{
  assert.ok(configured&&process.env.CODEWORKS_TEMPORAL_ADDRESS,'explicit disposable PostgreSQL and Temporal required');
  const f=await setup({strictVerifier:true}),verifier=new Pool({connectionString:f.config.verifier_url});
  let connection,native,worker,running,delivery;const ids=[];
  const previousVerifier=process.env.CODEWORKS_VERIFIER_DATABASE_URL;process.env.CODEWORKS_VERIFIER_DATABASE_URL=f.config.verifier_url;
  t.after(async()=>{clearInterval(delivery);if(worker?.getState()==='RUNNING')worker.shutdown();await running;
    if(connection){const client=new Client({connection,namespace:process.env.CODEWORKS_TEMPORAL_NAMESPACE});for(const id of ids)await client.workflow.getHandle(id).terminate('isolated fixture complete').catch(()=>{});}
    await native?.close();await connection?.close();await verifier.end();await f.close();
    if(previousVerifier===undefined)delete process.env.CODEWORKS_VERIFIER_DATABASE_URL;else process.env.CODEWORKS_VERIFIER_DATABASE_URL=previousVerifier;
  });
  const p=await f.project({codeIndexDisabled:true});
  await f.owner.query("INSERT INTO codeworks.execution_control(project_id,instance_id,owner) VALUES($1,'terminal-queue','temporal')",[p.id]);
  const create=async(project=p,target='prod')=>{
    const id=randomUUID(),sha='a'.repeat(40),composition={source:sha,components:[]},digest='sha256:'+'b'.repeat(64);
    const op=(await f.app.query("INSERT INTO codeworks.operations(id,project_id,executor_id,kind,status,step,request) VALUES($1,$2,'codeworks_owner','rollout','pending','fixture',$3) RETURNING *",[id,project.id,{target,commit_sha:sha}])).rows[0];
    await f.app.query('INSERT INTO codeworks.deployments(operation_id,project_id,target,commit_sha,run_id,attempt,composition_digest,composition) VALUES($1,$2,$3,$4,$5,1,$6,$7)',[id,project.id,target,sha,id,digest,composition]);
    const receipt={operation_id:id,project_id:project.id,target,commit_sha:sha,composition_digest:digest,composition,verified:true,evidence_url:'https://fixture.invalid/'+id};
    const workflow=(await f.app.query('SELECT workflow_id FROM codeworks.workflow_registry WHERE operation_id=$1',[id])).rows[0]?.workflow_id;
    return {op,receipt,workflow};
  };
  const held=async item=>{const db=await f.app.connect();try{assert.equal(await acquireTarget(db,item.op.project_id,item.receipt.target,item.op.id),true);}finally{db.release();}};
  const succeed=async item=>{
    await advanceDeployment(verifier,item.op,async()=>({status:'succeeded',receipt:item.receipt}));
    // Воспроизводится прежнее out-of-band завершение без освобождения release_queue.
    await f.app.query("UPDATE codeworks.operations SET status='succeeded',step='ANSIBLE_ROLLOUT_VERIFIED' WHERE id=$1",[item.op.id]);
  };
  const state=async item=>(await f.app.query('SELECT q.state,o.status FROM codeworks.release_queue q JOIN codeworks.operations o ON o.id=q.operation_id WHERE q.operation_id=$1',[item.op.id])).rows[0];
  const old=await create();await held(old);await succeed(old);
  await f.owner.query("UPDATE codeworks.commands SET state='done' WHERE operation_id=$1",[old.op.id]);
  await f.owner.query("UPDATE codeworks.workflow_registry SET state='completed',executor_state='completed' WHERE operation_id=$1",[old.op.id]);
  const barrier=await create();
  {const db=await f.app.connect();try{assert.equal(await acquireTarget(db,p.id,'prod',barrier.op.id),false);}finally{db.release();}}
  await succeed(barrier);
  const next=await create();
  {const db=await f.app.connect();try{assert.equal(await acquireTarget(db,p.id,'prod',next.op.id),false);}finally{db.release();}}
  const active=await create(p,'dev');await held(active);
  await f.owner.query("UPDATE codeworks.operations SET status='running' WHERE id=$1",[active.op.id]);
  // Неизвестные, неуспешные и связанные с release результаты не разрешают освобождение.
  for(const mode of ['missing-evidence','wrong-receipt','failed','release-owned','live-executor']){
    const project=await f.project({codeIndexDisabled:true});
    await f.owner.query("INSERT INTO codeworks.execution_control(project_id,instance_id,owner) VALUES($1,'terminal-queue','temporal')",[project.id]);
    const item=await create(project);await held(item);await succeed(item);
    if(mode==='missing-evidence')await f.owner.query('DELETE FROM codeworks.deployment_evidence WHERE project_id=$1',[project.id]);
    if(mode==='wrong-receipt')await verifier.query("UPDATE codeworks.deployments SET receipt=jsonb_set(receipt,'{commit_sha}',to_jsonb($2::text)) WHERE operation_id=$1",[item.op.id,'c'.repeat(40)]);
    if(mode==='failed')await f.owner.query("UPDATE codeworks.operations SET status='failed' WHERE id=$1",[item.op.id]);
    if(mode==='release-owned'){
      const area=await f.prepare({project_id:project.id,workspace_key:'release-owner',request_key:'release-owner'}),parent=randomUUID();
      await f.app.query("INSERT INTO codeworks.operations(id,project_id,workspace_id,executor_id,kind,status,step,request) VALUES($1,$2,$3,'codex','release','failed','fixture','{}')",[parent,project.id,area.workspace_id]);
      await f.app.query('UPDATE codeworks.deployments SET release_operation_id=$2 WHERE operation_id=$1',[item.op.id,parent]);
    }
    const guard=await f.app.connect();try{
      if(mode==='live-executor')await guard.query('SELECT pg_advisory_lock(hashtextextended($1,0))',['execution:rollout:'+item.op.id]);
      assert.equal((await reconcileSuccessfulRollouts(f.app,project.id)).released,0,mode);
      assert.equal((await state(item)).state,'held',mode);
    }finally{if(mode==='live-executor')await guard.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',['execution:rollout:'+item.op.id]);guard.release();}
    await f.owner.query("UPDATE codeworks.commands SET state='done' WHERE workflow_id IN (SELECT workflow_id FROM codeworks.workflow_registry WHERE project_id=$1)",[project.id]);
    await f.owner.query("UPDATE codeworks.workflow_registry SET state='completed' WHERE project_id=$1",[project.id]);
  }
  const namespace=process.env.CODEWORKS_TEMPORAL_NAMESPACE,queue='terminal-queue-'+randomUUID();
  connection=await Connection.connect({address:process.env.CODEWORKS_TEMPORAL_ADDRESS});native=await NativeConnection.connect({address:process.env.CODEWORKS_TEMPORAL_ADDRESS});
  const client=new Client({connection,namespace});
  const wrapper=path.join(p.repo_path,'..','queue-workflows.cjs');
  await writeFile(wrapper,'Object.assign(exports,require('+JSON.stringify(fileURLToPath(new URL('../../src/workflows.cjs',import.meta.url)))+'));exports.completedLegacyRollout=async()=>true;\n');
  const bundle=await bundleWorkflowCode({workflowsPath:wrapper});
  let interrupted=false;
  const start=async()=>{
    worker=await Worker.create({connection:native,namespace,taskQueue:queue,workflowBundle:bundle,shutdownGraceTime:'2 seconds',activities:createActivities(f.app,{allowedRepositories:[p.repo_path],adapters:{...createActivityGit(),deploymentAdapter:async id=>{
      assert.equal(id,next.op.id,'old completed or active rollout was executed');return {status:'succeeded',receipt:next.receipt};
    }},execute:async(pool,id,git,options)=>runOperation(pool,id,git,{...options,checkpoint:async stage=>{
      await options.checkpoint(stage);if(id===next.op.id&&stage==='before-rollout-finish'&&!interrupted){interrupted=true;throw Object.assign(Error('completion interrupted'),{code:'TEST_INTERRUPTION'});}
    }})})});running=worker.run();
  };
  const stop=async()=>{worker.shutdown();await running;};
  await start();
  const legacy=await client.workflow.start('completedLegacyRollout',{workflowId:old.workflow,taskQueue:queue});ids.push(old.workflow);await legacy.result();
  const oldRun=(await legacy.describe()).runId;
  const barrierHandle=await client.workflow.start('codeworksWorkspace',{workflowId:barrier.workflow,taskQueue:queue,args:[{generation:1,position:0}]});ids.push(barrier.workflow);
  await until(async()=>(await f.app.query('SELECT state FROM codeworks.commands WHERE operation_id=$1',[barrier.op.id])).rows[0].state==='done');
  assert.equal((await barrierHandle.describe()).status.name,'RUNNING','terminal success cannot finish with an unreleased lane');
  assert.equal((await state(barrier)).state,'queued');
  const reconciler='codeworks/terminal-queue/'+p.id+'/reconciler';ids.push(reconciler,next.workflow);
  await client.workflow.start('codeworksProjectReconciler',{workflowId:reconciler,taskQueue:queue,args:[{projectId:p.id}]});
  await until(async()=>(await state(old)).state==='released');
  assert.equal((await legacy.describe()).status.name,'COMPLETED');assert.equal((await legacy.describe()).runId,oldRun);
  // Доставляется только следующая операция; чужой active DEV имеет собственный живой владелец.
  await f.owner.query('UPDATE codeworks.workflow_registry SET started_at=now() WHERE operation_id=$1',[active.op.id]);
  delivery=setInterval(()=>deliverCommands(f.app,client,{taskQueue:queue}).catch(()=>{}),100);
  await until(()=>interrupted);await stop();
  assert.deepEqual(await state(next),{state:'held',status:'running'},'crash rolls back both terminal status and lane release');
  await start();await until(async()=>(await state(next)).status==='succeeded');
  assert.equal((await state(next)).state,'released');
  await until(async()=>(await barrierHandle.describe()).status.name==='COMPLETED');
  assert.equal((await state(barrier)).state,'released');
  await until(async()=>(await client.workflow.getHandle(next.workflow).describe()).status.name==='COMPLETED');
  assert.deepEqual(await state(active),{state:'held',status:'running'});
  assert.equal((await reconcileSuccessfulRollouts(f.app,p.id)).released,0,'repeat is idempotent');
});
