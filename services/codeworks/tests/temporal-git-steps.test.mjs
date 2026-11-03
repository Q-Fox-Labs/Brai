// ABOUTME: Проверяет узкие Git-блокировки, параллельные fetch и повтор очистки на настоящем Git.
// ABOUTME: Использует только disposable репозиторий и local bare origin; сеть GitHub и рабочие данные не затрагивает.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,access} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {command,createGit} from '../src/git.mjs';
import {createFlowGit} from '../src/git-flow.mjs';
import {createActivityGit} from '../src/git-steps.mjs';
import {createServer} from 'node:http';
import {withExecutionContext,executionFetch} from '../src/execution-context.mjs';
import {handleGitStep} from '../src/git-step.mjs';
test('scoped Git preserves independent work, immutable fetch results and recoverable remote cleanup',async t=>{
  const temporary=fileURLToPath(new URL('../../../tmp/',import.meta.url));await mkdir(temporary,{recursive:true});
  const root=await mkdtemp(path.join(temporary,'codeworks-scoped-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const repo=path.join(root,'repo'),areas=path.join(root,'areas'),bare=path.join(root,'origin.git');await mkdir(areas);
  const run=(...args)=>command('git',['-C',repo,...args]);
  await command('git',['init','-b','dev',repo]);await run('config','user.name','Fixture');await run('config','user.email','fixture@example.invalid');
  await writeFile(path.join(repo,'base'),'base');await run('add','.');await run('commit','-m','base');const base=(await run('rev-parse','HEAD')).stdout;
  await command('git',['init','--bare',bare]);await run('remote','add','origin',bare);await run('push','origin','dev',base+':refs/heads/main');
  const project={repo_path:repo,common_dir:repo+'/.git',workspace_root:areas,github:{repository:'fixture/repository'}};
  const w={id:randomUUID(),ownership_token:randomUUID(),base_sha:base,branch:'feature/scoped-git',path:path.join(areas,'scoped')};
  const flowGit=createFlowGit({localRemote:true,requireLock:()=>{}}),{git}=createActivityGit({flowGit});
  await git.branch(project,w);await git.checkout(project,w);
  await writeFile(w.path+'/change','new');await command('git',['-C',w.path,'add','.']);await command('git',['-C',w.path,'commit','-m','change']);
  const head=(await command('git',['-C',w.path,'rev-parse','HEAD'])).stdout;
  const lock=spawn('/usr/bin/flock',['-x',project.common_dir+'/codeworks.lock','/bin/sh','-c','printf ready; read -r finish'],{stdio:['pipe','pipe','pipe']});
  await once(lock.stdout,'data');
  try{
    await assert.rejects(git.branch(project,{...w,id:randomUUID(),ownership_token:randomUUID(),branch:'feature/other',path:areas+'/other'}),{code:'BUSY'});
    await flowGit.push(project,w.branch,head);assert.equal(await flowGit.remote(project,w.branch),head);
    const sentinel='preserve independent FETCH_HEAD\n';await writeFile(project.common_dir+'/FETCH_HEAD',sentinel);
    await Promise.all([flowGit.fetch(project,'dev',base),flowGit.fetch(project,w.branch,head)]);
    assert.equal(await readFile(project.common_dir+'/FETCH_HEAD','utf8'),sentinel);
    assert.equal((await run('rev-parse','refs/remotes/origin/dev')).stdout,base);
    assert.equal((await git.inspect(project,w)).dirty,false);
  }finally{const closed=once(lock,'close');lock.stdin.end('done\n');await closed;}
  await run('merge','--no-ff','--no-edit',w.branch);const merged=(await run('rev-parse','HEAD')).stdout;
  const lost=createActivityGit({flowGit:{...flowGit,removeBranch:async(...args)=>{await flowGit.removeBranch(...args);throw Error('response lost after remote deletion');}}}).git;
  await assert.rejects(lost.cleanup(project,w,[merged],head),/response lost/);await access(w.path);
  assert.equal(await flowGit.remote(project,w.branch),null);
  assert.equal(await git.cleanup(project,w,[merged],head),true);await assert.rejects(access(w.path));
  assert.equal(await git.cleanup(project,w,[merged],head),true);
});

test('local Git RPC preserves error IDs, batches and notification semantics',async()=>{
  let calls=0;const mutate=async()=>{calls++;return true;},params={method:'branch',project:{},workspace:{}};
  assert.equal((await handleGitStep('{',mutate)).error.code,-32700);
  assert.equal((await handleGitStep('[]',mutate)).error.code,-32600);
  const request={jsonrpc:'2.0',id:'git-1',method:'git.mutate',params};
  assert.equal((await handleGitStep(JSON.stringify({...request,params:{}}),mutate)).error.code,-32602);
  assert.equal((await handleGitStep(JSON.stringify({...request,method:'unknown'}),mutate)).id,'git-1');
  const responses=await handleGitStep(JSON.stringify([request,{jsonrpc:'2.0',method:'git.mutate',params},17]),mutate);
  assert.equal(calls,2);assert.equal(responses.length,2);assert.equal(responses[0].result,true);assert.equal(responses[1].error.code,-32600);
});

test('Activity cancellation stops only its command and HTTP request; independent work completes',async()=>{
  const controller=new AbortController();let release,entered;
  const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
  const server=createServer(async(req,res)=>{entered();await gate;res.end('released');});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const url='http://127.0.0.1:'+server.address().port;
    const http=assert.rejects(withExecutionContext({signal:controller.signal},()=>executionFetch(url,{signal:AbortSignal.timeout(10000)})));
    const child=assert.rejects(withExecutionContext({signal:controller.signal},()=>command(process.execPath,['-e','setTimeout(()=>{},10000)'])));
    const independent=withExecutionContext({},()=>command(process.execPath,['-e',"process.stdout.write('independent')"]));
    await started;controller.abort(Error('fixture interruption'));
    await Promise.all([http,child]);assert.equal((await independent).stdout,'independent');
  }finally{release();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('fresh hotfix base updates only its tracking ref and keeps the DEV checkout and FETCH_HEAD',async t=>{
  const tmp=fileURLToPath(new URL('../../../tmp/',import.meta.url));await mkdir(tmp,{recursive:true});
  const root=await mkdtemp(path.join(tmp,'codeworks-base-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const repo=root+'/repo',bare=root+'/origin.git',producer=root+'/producer',areas=root+'/areas';await mkdir(areas);
  await command('git',['init','--bare',bare]);await command('git',['init','-b','dev',repo]);
  const g=(...args)=>command('git',['-C',repo,...args]);
  await g('config','user.name','Fixture');await g('config','user.email','fixture@example.invalid');
  await writeFile(repo+'/base','base');await g('add','.');await g('commit','-m','base');
  const base=(await g('rev-parse','HEAD')).stdout;await g('remote','add','origin',bare);await g('push','origin','dev',base+':refs/heads/main');
  await g('update-ref','refs/remotes/origin/main',base);
  await command('git',['clone','--branch','main',bare,producer]);
  const other=(...args)=>command('git',['-C',producer,...args]);
  await other('config','user.name','Fixture');await other('config','user.email','fixture@example.invalid');
  await writeFile(producer+'/prod-fix','accepted PROD');await other('add','.');await other('commit','-m','production fix');await other('push','origin','main');
  const head=(await other('rev-parse','HEAD')).stdout,sentinel='preserve FETCH_HEAD\n';await writeFile(repo+'/.git/FETCH_HEAD',sentinel);
  const p={repo_path:repo,common_dir:repo+'/.git',workspace_root:areas,git_flow:{hotfix_base:'refs/remotes/origin/main'},github:{repository:'fixture/repository'}};
  const git=createGit({flowGit:createFlowGit({localRemote:true,requireLock:()=>{}})});
  assert.equal(await git.readBase(p,'hotfix'),head);
  assert.equal((await g('rev-parse','refs/remotes/origin/main')).stdout,head);
  assert.equal((await g('rev-parse','HEAD')).stdout,base);
  assert.equal(await readFile(repo+'/.git/FETCH_HEAD','utf8'),sentinel);await assert.rejects(access(repo+'/prod-fix'));
  await g('update-ref','refs/remotes/origin/main',base);
  let reads=0;const racing=createGit({flowGit:{remote:async()=>++reads===1?head:'f'.repeat(40)}});
  await assert.rejects(racing.readBase(p,'hotfix'),{code:'TARGET_CHANGED'});
  assert.equal((await g('rev-parse','refs/remotes/origin/main')).stdout,base);
});
