// ABOUTME: Проверяет штатный Codex, настоящий Git, PostgreSQL и Temporal от первой правки до удаления.
// ABOUTME: Отдельные home, provider, БД и task queue; потеря Post задаётся отсутствием тестового обработчика.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir,mkdtemp,rm,readFile,stat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {Connection,Client} from '@temporalio/client';
import {NativeConnection,Worker,bundleWorkflowCode} from '@temporalio/worker';
import {setup,configured} from './fixture.mjs';
import {stockCodex} from './stock-codex.mjs';
import {runHook} from '../../src/hook.mjs';
import {createActivities,deliverCommands} from '../../src/temporal.mjs';
import {readExecutorItems} from '../../src/executor-completion.mjs';

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,timeout=180000){const end=Date.now()+timeout;while(Date.now()<end){if(await fn())return;await sleep(100);}throw Error('STOCK_WRITER_TIMEOUT');}
test('stock nested tools write outside native roots; missing Post recovers and cancellation reaches verified zero',{timeout:300000},async t=>{
  assert.ok(configured&&process.env.CODEWORKS_STOCK_CODEX_BINARY,'explicit disposable DB and stock Codex required');
  const f=await setup();let executor,worker,connection,native,http,delivery,client,running;const workflows=[];
  const socketRoot=await mkdtemp('/tmp/cw-stock-socket-');
  const oldSocket=process.env.CODEWORKS_EXECUTOR_SOCKET;
  t.after(async()=>{clearInterval(delivery);if(worker){worker.shutdown();await running?.catch(()=>{});}for(const id of workflows)await client.workflow.getHandle(id).terminate('isolated fixture cleanup').catch(()=>{});await executor?.close();await native?.close();await connection?.close();if(http){http.closeAllConnections();await new Promise(r=>http.close(r));}if(oldSocket===undefined)delete process.env.CODEWORKS_EXECUTOR_SOCKET;else process.env.CODEWORKS_EXECUTOR_SOCKET=oldSocket;await f.close();await rm(socketRoot,{recursive:true,force:true});});
  const p=await f.project({codeIndexDisabled:true}),protectedArea=await f.prepare({project_id:p.id,workspace_key:'protected-work',request_key:'protected'});await f.worker(p,protectedArea.operation_id);
  const spool=p.workspace_root+'/spool',home=p.workspace_root+'/native-home';await mkdir(spool,{mode:0o700});
  const socket=socketRoot+'/server.sock';process.env.CODEWORKS_EXECUTOR_SOCKET=socket;
  const config={native_file_writes:false,completion_spool:spool,projects:[{id:p.id,repo_path:p.repo_path,workspace_root:p.workspace_root}]};
  const recorded=[];
  http=createServer(async(req,res)=>{try{let body='';for await(const b of req)body+=b;const event=JSON.parse(body);recorded.push({tool:event.tool_name,id:event.tool_use_id});const reply=await runHook(event,{config,env:{CODEWORKS_EXECUTOR_ID:'codex'},polls:80,connect:async()=>({call:(method,args)=>f.h.call(method,args,'codex'),close(){}})});res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(reply));}catch(e){res.writeHead(500);res.end('FIXTURE_ERROR');}});
  await new Promise(r=>http.listen(0,'127.0.0.1',r));
  executor=await stockCodex({binary:process.env.CODEWORKS_STOCK_CODEX_BINARY,home,cwd:p.repo_path,socketPath:socket,hookCommand:`${process.execPath} ${fileURLToPath(new URL('./stock-hook.mjs',import.meta.url))} http://127.0.0.1:${http.address().port}/`});
  const hooks=await executor.call('hooks/list',{cwds:[p.repo_path]}),state={};for(const h of hooks.data[0].hooks)state[h.key]={trusted_hash:h.currentHash};
  await executor.call('config/batchWrite',{edits:[{keyPath:'hooks.state',value:state,mergeStrategy:'replace'}]});
  const thread=(await executor.call('thread/start',{cwd:p.repo_path,model:'gpt-6.1-sol',modelProvider:'fixture',approvalPolicy:'on-request',sandbox:'workspace-write'})).thread.id;
  connection=await Connection.connect({address:process.env.CODEWORKS_TEMPORAL_ADDRESS});client=new Client({connection,namespace:process.env.CODEWORKS_TEMPORAL_NAMESPACE});native=await NativeConnection.connect({address:process.env.CODEWORKS_TEMPORAL_ADDRESS});
  const queue='cw-stock-'+randomUUID(),bundle=await bundleWorkflowCode({workflowsPath:fileURLToPath(new URL('../../src/workflows.cjs',import.meta.url))});
  await f.owner.query("INSERT INTO codeworks.execution_control(project_id,instance_id,owner) VALUES($1,'stock-fixture','temporal')",[p.id]);
  worker=await Worker.create({connection:native,namespace:process.env.CODEWORKS_TEMPORAL_NAMESPACE,taskQueue:queue,workflowBundle:bundle,activities:createActivities(f.app,{allowedRepositories:[p.repo_path],completionSpoolDirectory:spool})});running=worker.run();
  delivery=setInterval(()=>deliverCommands(f.app,client,{taskQueue:queue}).catch(()=>{}),100);
  const turn=async script=>{const before=executor.events.length;executor.setScript(script);const result=await executor.call('turn/start',{threadId:thread,input:[{type:'text',text:'Run the isolated writer fixture.'}]});await until(()=>executor.events.slice(before).some(e=>e.method==='turn/completed'&&e.params.turn.id===result.turn.id));return result.turn.id;};
  const denied=await turn(`text(await tools.apply_patch(${JSON.stringify('*** Begin Patch\n*** Add File: '+p.repo_path+'/unused.txt\n+x\n*** End Patch')}));`);
  assert.ok(recorded.some(e=>e.tool==='apply_patch'));
  assert.equal((await f.app.query('SELECT count(*)::int AS n FROM codeworks.workspaces WHERE project_id=$1',[p.id])).rows[0].n,1,'nested native denial created no workspace');
  assert.equal((await f.app.query('SELECT count(*)::int AS n FROM codeworks.write_calls WHERE project_id=$1 AND turn_id=$2',[p.id,denied])).rows[0].n,0);
  const diff='diff --git a/new.txt b/new.txt\nnew file mode 100644\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+actual stock write\n';
  const command=`git -C '${p.repo_path}' apply --whitespace=nowarn <<'PATCH'\n${diff}PATCH\n`;
  const written=await turn(`text(await tools.exec_command(${JSON.stringify({cmd:command,workdir:p.repo_path,sandbox_permissions:'require_escalated',justification:'Write only disposable Codeworks fixture'})}));`);
  const call=(await f.app.query('SELECT * FROM codeworks.write_calls WHERE project_id=$1 AND turn_id=$2',[p.id,written])).rows[0];assert.ok(call);
  const w=(await f.app.query('SELECT * FROM codeworks.workspaces WHERE id=$1',[call.workspace_id])).rows[0];workflows.push((await f.app.query('SELECT workflow_id FROM codeworks.workflow_registry WHERE workspace_id=$1',[w.id])).rows[0].workflow_id);
  assert.equal(await readFile(w.path+'/new.txt','utf8'),'actual stock write\n');assert.equal(await stat(p.repo_path+'/new.txt').catch(()=>null),null);
  assert.equal(call.state,'in_flight','no Post exists in this fixture');
  const observed=await readExecutorItems(socket,thread,written);assert.ok(observed.data.some(e=>e.item.id===call.tool_use_id&&e.item.status==='completed'));
  const reconciler=`codeworks/stock-fixture/${p.id}/reconciler`;workflows.push(reconciler);await client.workflow.start('codeworksProjectReconciler',{workflowId:reconciler,taskQueue:queue,args:[{projectId:p.id}]});
  await until(async()=>(await f.app.query('SELECT state FROM codeworks.write_calls WHERE id=$1',[call.id])).rows[0].state==='finished');
  assert.equal((await f.app.query('SELECT activation_state FROM codeworks.workspaces WHERE id=$1',[w.id])).rows[0].activation_state,'active');
  // Тестовый файл явно отбрасывается обратным настоящим Git patch; полезные пользовательские изменения не затрагиваются.
  const reverse='diff --git a/new.txt b/new.txt\ndeleted file mode 100644\n--- a/new.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-actual stock write';
  await turn(`text(await tools.exec_command(${JSON.stringify({cmd:`git -C '${w.path}' apply --whitespace=nowarn <<'PATCH'\n${reverse}\nPATCH\n`,workdir:p.repo_path,sandbox_permissions:'require_escalated',justification:'Remove only the generated disposable test file'})}));`);
  await f.h.call('workspace.cancel',{project_id:p.id,workspace_id:w.id,request_key:'cancel-stock',reason:'Disposable fixture complete'},'codex');
  await until(async()=>(await f.h.call('lifecycle.status',{project_id:p.id,workspace_id:w.id},'codex')).workflow.status==='completed');
  const final=await f.h.call('lifecycle.status',{project_id:p.id,workspace_id:w.id},'codex');assert.equal(final.cleanup.state,'done');assert.equal(await stat(w.path).catch(()=>null),null);
  assert.equal((await f.app.query('SELECT removed_at FROM codeworks.workspaces WHERE id=$1',[protectedArea.workspace_id])).rows[0].removed_at,null);
  assert.ok(await stat(protectedArea.path));
});
