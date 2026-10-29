// ABOUTME: Проверяет исторические отметки удаления реальными PostgreSQL, Temporal, Git и Qdrant.
// ABOUTME: Сверка только наблюдает ресурсы и никогда не вызывает удаление.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {Connection,Client} from '@temporalio/client';
import {NativeConnection,Worker,bundleWorkflowCode} from '@temporalio/worker';
import {setup,configured} from './fixture.mjs';
import {createGit,command} from '../../src/git.mjs';
import {createFlowGit} from '../../src/git-flow.mjs';
import {createCodeIndex,indexIdentity} from '../../src/code-index.mjs';
import {createActivities} from '../../src/temporal.mjs';
import {reconcileProjectLedger} from '../../src/reconciler.mjs';
import {runCleanupObligation} from '../../src/worker.mjs';

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,timeout=180000){const end=Date.now()+timeout;while(Date.now()<end){if(await fn())return;await sleep(100);}throw Error('HISTORICAL_ZERO_TIMEOUT');}

test('historical release records are observed to zero without destructive calls',{timeout:360000},async t=>{
  assert.ok(configured&&process.env.CODEWORKS_INDEX_QDRANT&&process.env.CODEWORKS_TEMPORAL_ADDRESS&&process.env.CODEWORKS_TEMPORAL_NAMESPACE,'explicit disposable PostgreSQL, Qdrant and Temporal are required');
  const f=await setup();let connection,native,client,handle;const collections=[];
  t.after(async()=>{if(handle)await client.workflow.getHandle(handle.workflowId).terminate('fixture finished').catch(()=>{});await native?.close();await connection?.close();for(const name of collections)await fetch(process.env.CODEWORKS_INDEX_QDRANT+'/collections/'+name,{method:'DELETE'}).catch(()=>{});await f.close();});
  const p=await f.project({github:{repository:'fixture/repository',required_checks:[{name:'checks',app_id:42}]}}),items=[];
  const base=(await command('git',['-C',p.repo_path,'rev-parse','HEAD'])).stdout,owner=`codeworks/history-fixture/${p.id}/reconciler`;
  for(let i=0;i<103;i++){
    const id=randomUUID(),release=randomUUID(),kind=i===0?'promotion':'feature',branch=kind==='promotion'?'release/codeworks-'+id:'feature/history-'+id;
    await f.owner.query("INSERT INTO codeworks.workspaces(id,project_id,workspace_key,kind,base_ref,base_sha,branch,path,ownership_token,preparation_state,removed_at,legacy_writer) VALUES($1,$2,$3,$4,'refs/heads/dev',$5,$6,$7,$8,'ready',now(),$9)",[id,p.id,'history-'+i,kind,base,branch,p.workspace_root+'/'+id,randomUUID(),kind==='promotion'?{state:'quiesced'}:null]);
    await f.owner.query("INSERT INTO codeworks.operations(id,project_id,workspace_id,executor_id,kind,status,step,request) VALUES($1,$2,$3,'codex','release','succeeded','done','{}')",[release,p.id,id]);
    await f.owner.query("INSERT INTO codeworks.releases(id,workspace_id,operation_id,target,requested_sha,state) VALUES($1,$2,$3,'dev',$4,'succeeded')",[randomUUID(),id,release,base]);
    if(i<7)await f.owner.query('UPDATE codeworks.operations SET archived=true WHERE id=$1',[release]);
    items.push({id,release,kind,branch});
  }
  await f.owner.query("INSERT INTO codeworks.execution_control(project_id,instance_id,owner) VALUES($1,'history-fixture','temporal')",[p.id]);
  const sorted=[...items].sort((a,b)=>a.id.localeCompare(b.id)),held=await f.owner.connect();
  try{
    await held.query('BEGIN');for(const item of sorted.slice(0,32))await held.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['execution:workspace:'+item.id]);
    const first=await reconcileProjectLedger(f.app,p.id,owner,{historicalCursor:null});
    assert.equal(first.historicalHasMore,true);assert.equal(first.nextHistoricalCursor,sorted[31].id);
    const next=await reconcileProjectLedger(f.app,p.id,owner,{historicalCursor:first.nextHistoricalCursor});
    assert.equal(next.historicalHasMore,true);
    const created=(await f.app.query('SELECT workspace_id FROM codeworks.cleanup_obligations WHERE project_id=$1',[p.id])).rows.map(row=>row.workspace_id);
    assert.ok(created.includes(sorted[32].id));assert.ok(sorted.slice(0,32).every(item=>!created.includes(item.id)));
    await held.query('ROLLBACK');
  }finally{held.release();}
  for(let i=0;i<6;i++)await reconcileProjectLedger(f.app,p.id,owner);
  const seeded=(await f.app.query('SELECT id,workspace_id,evidence,state FROM codeworks.cleanup_obligations WHERE project_id=$1',[p.id])).rows;
  assert.equal(seeded.length,103,'more than 100 records across four pages are discovered');assert.equal(new Set(seeded.map(x=>x.workspace_id)).size,103);
  assert.ok(seeded.every(x=>x.evidence.historical_zero?.mode==='inspect_only'));
  await f.owner.query("UPDATE codeworks.cleanup_obligations SET state='waiting_decision',blocker='FIXTURE_NOT_SELECTED' WHERE project_id=$1 AND NOT (workspace_id=ANY($2::uuid[]))",[p.id,items.slice(0,15).map(item=>item.id)]);
  const feature=p.workspace_root+'/feature.json',hotfix=p.workspace_root+'/hotfix.json',settings=p.workspace_root+'/history-index.json';
  const prefix='historical_'+randomUUID().replaceAll('-','')+'_';
  for(const [file,profile] of [[feature,'feature'],[hotfix,'hotfix']])await writeFile(file,JSON.stringify({env:{QDRANT_MODE:'external',QDRANT_URL:process.env.CODEWORKS_INDEX_QDRANT,QDRANT_COLLECTION_PREFIX:prefix+profile+'_',SOCRATICODE_AUTO_RESUME:'off',SOCRATICODE_WATCHER:'manual'}}));
  await writeFile(settings,JSON.stringify({engine:'/opt/socraticode/node_modules/socraticode/dist/index.js',socraticodeConfig:{feature,hotfix},sources:{}}));
  const rawIndex=createCodeIndex(f.app,{configFile:settings}),index={...rawIndex,remove:()=>assert.fail('historical observations must never remove index')};
  const flowGit=createFlowGit({localRemote:true,requireLock:()=>{}}),rawGit=createGit({flowGit}),git={...rawGit,cleanup:()=>assert.fail('historical observations must never clean Git'),cleanupStep:()=>assert.fail('historical observations must never delete Git resources')};
  const selected=seeded.find(x=>x.workspace_id===items[1].id),run=()=>runCleanupObligation(f.app,selected.id,owner,{git,flowGit,codeIndex:index,allowedRepositories:[p.repo_path]});
  const reset=()=>f.owner.query("UPDATE codeworks.cleanup_obligations SET state='pending',blocker=NULL,next_attempt_at=NULL WHERE id=$1",[selected.id]);
  const writer=randomUUID();await f.owner.query("INSERT INTO codeworks.write_calls(id,project_id,workspace_id,executor_id,session_id,turn_id,tool_use_id,tool_name,workspace_key,kind,request_key,payload_sha256,targets,state) VALUES($1,$2,$3,'codex','fixture','turn','tool','Bash','history-1','feature','fixture',$4,'[]','uncertain')",[writer,p.id,selected.workspace_id,'a'.repeat(64)]);
  assert.equal((await run()).blocker,'HISTORICAL_SCOPE_CHANGED');await f.owner.query('DELETE FROM codeworks.write_calls WHERE id=$1',[writer]);await reset();
  await f.owner.query("UPDATE codeworks.releases SET state='failed' WHERE operation_id=$1",[items[1].release]);assert.equal((await run()).blocker,'HISTORICAL_SCOPE_CHANGED');await f.owner.query("UPDATE codeworks.releases SET state='succeeded' WHERE operation_id=$1",[items[1].release]);await reset();
  await f.owner.query("UPDATE codeworks.operations SET status='failed' WHERE id=$1",[items[1].release]);assert.equal((await run()).blocker,'HISTORICAL_SCOPE_CHANGED');await f.owner.query("UPDATE codeworks.operations SET status='succeeded' WHERE id=$1",[items[1].release]);await reset();
  await command('git',['-C',p.repo_path,'branch',items[1].branch,base]);assert.equal((await run()).blocker,'HISTORICAL_RESOURCES_REMAIN_OR_UNKNOWN');await command('git',['-C',p.repo_path,'branch','-D',items[1].branch]);await reset();
  const collection=prefix+'feature_codebase_'+indexIdentity(p.workspace_root+'/'+selected.workspace_id);collections.push(collection);
  const created=await fetch(process.env.CODEWORKS_INDEX_QDRANT+'/collections/'+collection,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({vectors:{size:4,distance:'Cosine'}})});assert.ok(created.ok,await created.text());
  assert.equal((await run()).blocker,'HISTORICAL_RESOURCES_REMAIN_OR_UNKNOWN');const removed=await fetch(process.env.CODEWORKS_INDEX_QDRANT+'/collections/'+collection,{method:'DELETE'});assert.ok(removed.ok);await reset();
  await writeFile(hotfix,JSON.stringify({env:{QDRANT_MODE:'external',QDRANT_URL:'http://127.0.0.1:1',QDRANT_COLLECTION_PREFIX:prefix+'hotfix_'}}));
  await assert.rejects(run());
  assert.notEqual((await f.app.query('SELECT state FROM codeworks.cleanup_obligations WHERE id=$1',[selected.id])).rows[0].state,'done');
  await writeFile(hotfix,JSON.stringify({env:{QDRANT_MODE:'external',QDRANT_URL:process.env.CODEWORKS_INDEX_QDRANT,QDRANT_COLLECTION_PREFIX:prefix+'hotfix_',SOCRATICODE_AUTO_RESUME:'off',SOCRATICODE_WATCHER:'manual'}}));await reset();
  connection=await Connection.connect({address:process.env.CODEWORKS_TEMPORAL_ADDRESS,connectTimeout:'5 seconds'});client=new Client({connection,namespace:process.env.CODEWORKS_TEMPORAL_NAMESPACE});native=await NativeConnection.connect({address:process.env.CODEWORKS_TEMPORAL_ADDRESS});
  const bundle=await bundleWorkflowCode({workflowsPath:fileURLToPath(new URL('../../src/workflows.cjs',import.meta.url))}),taskQueue='historical-zero-'+randomUUID();
  const makeWorker=()=>Worker.create({connection:native,namespace:process.env.CODEWORKS_TEMPORAL_NAMESPACE,taskQueue,workflowBundle:bundle,activities:createActivities(f.app,{allowedRepositories:[p.repo_path],adapters:{git,flowGit},codeIndex:index}),maxConcurrentActivityTaskExecutions:4});
  let firstRun;
  await (await makeWorker()).runUntil(async()=>{
    handle=await client.workflow.start('codeworksProjectReconciler',{workflowId:owner,taskQueue,args:[{projectId:p.id,continueAfter:3}]});
    firstRun=handle.firstExecutionRunId;
    await until(async()=>(await f.app.query("SELECT count(*)::int AS n FROM codeworks.cleanup_obligations WHERE project_id=$1 AND state='done'",[p.id])).rows[0].n>=3);
  });
  await (await makeWorker()).runUntil(async()=>{
    await until(async()=>(await f.app.query("SELECT count(*)::int AS n FROM codeworks.cleanup_obligations WHERE project_id=$1 AND state='done'",[p.id])).rows[0].n===15);
    const rows=(await f.app.query("SELECT * FROM codeworks.cleanup_obligations WHERE project_id=$1 AND state='done'",[p.id])).rows;
    assert.ok(rows.every(row=>row.outcome==='released'&&row.result.scope==='historical_workspace_resources'&&row.result.observations.length===2));
    assert.ok(rows.every(row=>row.result.observations.every(o=>o.index.profiles.length===2)));
    assert.equal((await f.app.query('SELECT count(*)::int AS n FROM codeworks.workflow_registry WHERE project_id=$1',[p.id])).rows[0].n,0);
    await reconcileProjectLedger(f.app,p.id,owner);assert.equal((await f.app.query('SELECT count(*)::int AS n FROM codeworks.cleanup_obligations WHERE project_id=$1',[p.id])).rows[0].n,103);
    const first=client.workflow.getHandle(owner,firstRun),history=await first.fetchHistory();
    assert.ok(history.events.some(e=>e.activityTaskScheduledEventAttributes?.activityType?.name==='reconcileProject'));
    assert.ok(history.events.some(e=>e.workflowExecutionContinuedAsNewEventAttributes),'singleton continues as new');
    assert.notEqual((await client.workflow.getHandle(owner).describe()).runId,firstRun);
    await Worker.runReplayHistory({workflowBundle:bundle},history,owner);
  });
});
