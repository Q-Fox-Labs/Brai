// ABOUTME: Проверяет независимую read-only инвентаризацию исторических Git ресурсов.
// ABOUTME: Использует изолированные репозитории и сохраняет все наблюдаемые refs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createGit,command,gitResourcesAbsent} from '../src/git.mjs';
import {createFlowGit} from '../src/git-flow.mjs';

test('historical promotion and feature observations fail closed and never delete refs',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'historical-git-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const repo=root+'/repo',areas=root+'/areas',bare=root+'/origin.git';await mkdir(areas);await command('git',['init','-b','dev',repo]);
 const run=(...args)=>command('git',['-C',repo,...args]);await run('config','user.name','Fixture');await run('config','user.email','fixture@example.invalid');await writeFile(repo+'/base','base');await run('add','.');await run('commit','-m','base');
 const head=(await run('rev-parse','HEAD')).stdout;await command('git',['init','--bare',bare]);await run('remote','add','origin',bare);
 const project={repo_path:repo,common_dir:repo+'/.git',workspace_root:areas,github:{repository:'fixture/repository'}};
 const id=randomUUID(),w={id,kind:'promotion',branch:'release/codeworks-'+id,path:areas+'/'+id,ownership_token:randomUUID(),base_sha:head};
 const flow=createFlowGit({localRemote:true}),git=createGit({flowGit:flow});let observed=await git.inspectHistoricalResources(project,w);assert.equal(gitResourcesAbsent(observed),true);
 await run('branch',w.branch);await run('push','origin',w.branch);observed=await git.inspectHistoricalResources(project,w);assert.equal(observed.branch.oid,head);assert.equal(observed.remote.oid,head);assert.equal(gitResourcesAbsent(observed),false);
 assert.equal((await run('rev-parse','refs/heads/'+w.branch)).stdout,head);
 await assert.rejects(git.inspectHistoricalResources(project,{...w,branch:'release/codeworks-'+randomUUID()}),{code:'INVALID_ARGUMENT'});
 await assert.rejects(git.inspectHistoricalResources(project,{...w,kind:'feature'}),{code:'INVALID_ARGUMENT'});
 await assert.rejects(git.inspectHistoricalResources(project,{...w,kind:'feature',branch:'feature/../bad'}),{code:'INVALID_ARGUMENT'});
 const f={...w,id:randomUUID(),kind:'feature',branch:'feature/example'};f.path=areas+'/'+f.id;assert.equal(gitResourcesAbsent(await git.inspectHistoricalResources(project,f)),true);
 await assert.rejects(createGit({flowGit:{...flow,remoteHistorical:async()=>{throw Error('offline');}}}).inspectHistoricalResources(project,f),/offline/);
 await assert.rejects(git.inspectHistoricalResources({...project,github:null},f),{code:'GIT_FAILED'});
});
