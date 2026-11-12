// ABOUTME: Проверяет независимость admission от медленного GitHub и потерянной PG session.
// ABOUTME: Переиспользует один scenario в полном и адресном Temporal fixture без изменения production времени.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {Pool} from 'pg';
import {Worker} from '@temporalio/worker';
import {createFlowGit} from '../../src/git-flow.mjs';
import {createActivityGit} from '../../src/git-steps.mjs';
import {createGit,command} from '../../src/git.mjs';
import {createHandlers} from '../../src/domain.mjs';
import {createStore} from '../../src/storage.mjs';
import {executionContext} from '../../src/execution-context.mjs';
import {createActivities,deliverCommands} from '../../src/temporal.mjs';
import {prepareWith} from './fixture.mjs';
import {connectionProxy} from './temporal-proxy.mjs';
/** Setup двух настоящих деревьев ограничен 180с; проверки независимости сохраняют прежний until budget. */
export async function temporalNetworkScenario({f,config,configFile,start,stop,client,workflowIds,until}){
  const status=id=>f.app.query('SELECT status FROM codeworks.operations WHERE id=$1',[id]).then(r=>r.rows[0].status);

    await stop();
    const p=await f.project({github:{repository:'fixture/repository',required_checks:[{name:'checks',app_id:42}]}});
    await f.owner.query("INSERT INTO codeworks.execution_control(project_id,instance_id,owner) VALUES($1,'fixture','temporal')",[p.id]);
    const flowGit=createFlowGit({localRemote:true,requireLock:()=>{}}),adapters=createActivityGit({flowGit});
    const handlers=createHandlers(createStore(f.app),createGit({flowGit}),{allowedRepositories:[p.repo_path]});
    const prepareArea=key=>prepareWith(handlers.call,{project_id:p.id,workspace_key:key,request_key:'prepare-'+key},'codex');
    const remember=async op=>{workflowIds.add((await f.app.query('SELECT workflow_id FROM codeworks.commands WHERE operation_id=$1',[op.operation_id])).rows[0].workflow_id);return op;};
    let releaseSlow,entered=false,requests=0,pgBlocked=false,pgEntered=false,releasePG;const created=new Map();
    const pgGate=new Promise(resolve=>{releasePG=resolve;});
    const gate=new Promise(resolve=>{releaseSlow=resolve;});
    const server=createServer(async(req,res)=>{
      let input='';for await(const chunk of req)input+=chunk;
      const request=JSON.parse(input),known=req.url==='/get'?[...created.values()].find(pr=>pr.number===request.number):null;
      const leg=req.url==='/get'?{branch:known?.head.ref}:request;
      if(req.url==='/find'||req.url==='/get'){
        if(leg.branch==='feature/slow-github'){entered=true;requests++;await gate;}
        if(pgBlocked&&leg.branch==='feature/fast-github'){pgEntered=true;await pgGate;}
        res.end(JSON.stringify((req.url==='/get'?known:created.get(leg.branch))??null));
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
      await deliverCommands(f.app,client,{taskQueue:config.taskQueue});await until(async()=>{
        const rows=(await f.app.query('SELECT id,status,step,error FROM codeworks.operations WHERE id=ANY($1::uuid[])',[[slow.operation_id,fast.operation_id]])).rows;
        assert.ok(rows.every(row=>row.status!=='failed'),'network fixture preparation failed: '+JSON.stringify(rows));
        return rows.length===2&&rows.every(row=>row.status==='succeeded');
      },180000);
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
      const networkCall=async(method,args)=>{const r=await fetch(config.githubURL+method,{method:'POST',body:JSON.stringify(args),signal:executionContext()?.signal});return r.json();};
      const network={find:(_,leg)=>networkCall('find',leg),get:(_,number)=>networkCall('get',{number})};
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
      const waiting=prepareWith(slowAdmission.call,{project_id:p.id,workspace_key:'slow-base-read',request_key:'slow-base-read'},'codex');
      try{
        await until(()=>readStarted);
        await remember(await prepareArea('admitted-during-base-read'));
      }finally{releaseRead();await remember(await waiting);}
    }finally{
      releaseSlow();releasePG();await stop();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
      delete config.githubURL;config.allowedRepositories=previousAllowed;await writeFile(configFile,JSON.stringify(config),{mode:0o600});await start();
    }
}
