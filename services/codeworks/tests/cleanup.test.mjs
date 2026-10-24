// ABOUTME: Проверяет удаление дерева и ветки выпуска в настоящем изолированном Git origin.
// ABOUTME: Dirty, unmerged и чужие области сохраняются; повтор terminal cleanup безопасен.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,access} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createGit,command} from '../src/git.mjs';
import {createFlowGit} from '../src/git-flow.mjs';
for(const kind of ['feature','hotfix'])test(kind+' cleanup preserves dirty/unmerged/foreign resources and requires every merged leg',async t=>{
 const temporary=fileURLToPath(new URL('../../../tmp/',import.meta.url));await mkdir(temporary,{recursive:true});
 const root=await mkdtemp(path.join(temporary,'codeworks-cleanup-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const repo=path.join(root,'repo'),workspaces=path.join(root,'workspaces');await mkdir(workspaces);
 const run=(...args)=>command('git',['-C',repo,...args]);
 await command('git',['init','--initial-branch=dev',repo]);await run('config','user.name','Fixture');await run('config','user.email','fixture@example.invalid');
 await writeFile(repo+'/base','base');await run('add','.');await run('commit','-m','base');await run('branch','production');
 const bare=path.join(root,'origin.git');await command('git',['init','--bare',bare]);await run('remote','add','origin',bare);
 const base=(await run('rev-parse','HEAD')).stdout,id=randomUUID(),project={repo_path:repo,common_dir:repo+'/.git',workspace_root:workspaces,github:{repository:'fixture/repository'}};
 const w={id,ownership_token:randomUUID(),base_sha:base,branch:kind+'/codeworks-'+id,path:workspaces+'/'+id,legacy_writer:{state:'active'}};
 const old=process.env.CODEWORKS_LOCK_HELD;process.env.CODEWORKS_LOCK_HELD='1';t.after(()=>{if(old===undefined)delete process.env.CODEWORKS_LOCK_HELD;else process.env.CODEWORKS_LOCK_HELD=old;});
 const flow=createFlowGit({localRemote:true}),git=createGit({flowGit:flow});await git.branch(project,w);await git.checkout(project,w);
 await writeFile(w.path+'/fix','fix');await command('git',['-C',w.path,'add','.']);await command('git',['-C',w.path,'commit','-m','fix']);
 const head=(await command('git',['-C',w.path,'rev-parse','HEAD'])).stdout;await run('push','origin',w.branch);
 const cleanup=heads=>git.cleanup(project,w,heads,head);
 assert.equal(await cleanup([]),false);assert.equal(await cleanup([base]),false);
 await run('merge','--no-ff','--no-edit',w.branch);const merged=(await run('rev-parse','HEAD')).stdout;let heads=[merged];
 if(kind==='hotfix'){assert.equal(await cleanup([merged,base]),false);await run('checkout','production');await run('merge','--no-ff','-m','production merge',w.branch);heads.push((await run('rev-parse','HEAD')).stdout);}
 await writeFile(w.path+'/dirty','preserve');assert.equal(await cleanup(heads),false);await rm(w.path+'/dirty');
 await assert.rejects(git.cleanup(project,{...w,ownership_token:'foreign'},heads,head),{code:'OWNERSHIP_CONFLICT'});
 assert.equal(await flow.remote(project,w.branch),head);
 await command('git',['-C',bare,'update-ref','refs/heads/'+w.branch,base,head]);
 await assert.rejects(cleanup(heads),{code:'TARGET_CHANGED'});await access(w.path);
 assert.equal(await flow.remote(project,w.branch),base);
 await command('git',['-C',bare,'update-ref','refs/heads/'+w.branch,head,base]);
 const lost=createGit({flowGit:{...flow,removeBranch:async(...args)=>{await flow.removeBranch(...args);throw new Error('delete response lost');}}});
 await assert.rejects(lost.cleanup(project,w,heads,head),/delete response lost/);await access(w.path);
 assert.equal(await flow.remote(project,w.branch),null);
 assert.equal(await cleanup(heads),true);await assert.rejects(access(w.path));
 assert.notEqual((await command('git',['-C',repo,'show-ref','--verify','refs/heads/'+w.branch],{allowFailure:true})).code,0);
 assert.equal(await cleanup(heads),true);
 await mkdir(w.path);await writeFile(w.path+'/foreign','preserve');
 assert.equal(await cleanup(heads),false);await access(w.path+'/foreign');
});
