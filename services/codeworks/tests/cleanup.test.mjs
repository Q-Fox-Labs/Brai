// ABOUTME: Проверяет реальную ownership cleanup на disposable Git worktree без сетевого origin.
// ABOUTME: Active, dirty, unmerged и чужие области сохраняются; повтор terminal cleanup безопасен.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,access,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createGit,command} from '../src/git.mjs';
for(const kind of ['feature','hotfix'])test(kind+' cleanup preserves active/dirty/unmerged/foreign resources and requires every merged leg',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'codeworks-cleanup-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const repo=path.join(root,'repo'),workspaces=path.join(root,'workspaces');await mkdir(workspaces);
 const run=(...args)=>command('git',['-C',repo,...args]);
 await command('git',['init','--initial-branch=dev',repo]);await run('config','user.name','Fixture');await run('config','user.email','fixture@example.invalid');
 await writeFile(repo+'/base','base');await run('add','.');await run('commit','-m','base');await run('branch','production');
 const base=(await run('rev-parse','HEAD')).stdout,id=randomUUID(),project={repo_path:repo,common_dir:repo+'/.git',workspace_root:workspaces};
 const w={id,ownership_token:randomUUID(),base_sha:base,branch:kind+'/codeworks-'+id,path:workspaces+'/'+id,writer:{state:'active'}};
 const old=process.env.CODEWORKS_LOCK_HELD;process.env.CODEWORKS_LOCK_HELD='1';t.after(()=>{if(old===undefined)delete process.env.CODEWORKS_LOCK_HELD;else process.env.CODEWORKS_LOCK_HELD=old;});
 const git=createGit();await git.branch(project,w);await git.checkout(project,w);
 await writeFile(w.path+'/fix','fix');await command('git',['-C',w.path,'add','.']);await command('git',['-C',w.path,'commit','-m','fix']);
 assert.equal(await git.cleanup(project,w,[base]),false);
 w.writer.state='quiesced';assert.equal(await git.cleanup(project,w,[base]),false);
 await run('merge','--no-ff','--no-edit',w.branch);const merged=(await run('rev-parse','HEAD')).stdout;let heads=[merged];
 if(kind==='hotfix'){assert.equal(await git.cleanup(project,w,[merged,base]),false);await run('checkout','production');await run('merge','--no-ff','-m','production merge',w.branch);heads.push((await run('rev-parse','HEAD')).stdout);}
 await writeFile(w.path+'/dirty','preserve');assert.equal(await git.cleanup(project,w,heads),false);await rm(w.path+'/dirty');
 await assert.rejects(git.cleanup(project,{...w,ownership_token:'foreign'},heads),{code:'OWNERSHIP_CONFLICT'});
 assert.equal(await git.cleanup(project,w,heads),true);await assert.rejects(access(w.path));
 assert.notEqual((await command('git',['-C',repo,'show-ref','--verify','refs/heads/'+w.branch],{allowFailure:true})).code,0);
 assert.equal(await git.cleanup(project,w,heads),true);
});

for(const kind of ['feature','hotfix'])test(kind+' trusted commit is scoped and recovers branch mutation without a second commit',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'codeworks-commit-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const repo=root+'/repo',workspaces=root+'/areas';await mkdir(workspaces);
 const run=(...args)=>command('git',['-C',repo,...args]);
 await command('git',['init','--initial-branch=dev',repo]);await run('config','user.name','Fixture');await run('config','user.email','fixture@example.invalid');
 await writeFile(repo+'/base','base');await run('add','.');await run('commit','-m','base');
 const base=(await run('rev-parse','HEAD')).stdout,id=randomUUID(),project={repo_path:repo,common_dir:repo+'/.git',workspace_root:workspaces,allowed_paths:['.'],excluded_paths:['private']};
 const w={id,ownership_token:randomUUID(),base_sha:base,branch:kind+'/codeworks-'+id,path:workspaces+'/'+id};
 const old=process.env.CODEWORKS_LOCK_HELD;process.env.CODEWORKS_LOCK_HELD='1';t.after(()=>{if(old===undefined)delete process.env.CODEWORKS_LOCK_HELD;else process.env.CODEWORKS_LOCK_HELD=old;});
 const git=createGit();await git.branch(project,w);await git.checkout(project,w);
 await writeFile(w.path+'/fix','change');await writeFile(w.path+'/private','preserve');
 const op={id:randomUUID(),created_at:new Date(),request:{parent_sha:base,message:'Scoped change'}};
 await assert.rejects(git.planCommit(project,w,op),{code:'FORBIDDEN'});await rm(w.path+'/private');
 const plan=await git.planCommit(project,w,op);assert.notEqual(plan.commit_sha,base);
 assert.deepEqual(await git.planCommit(project,w,op),plan);
 assert.equal((await git.inspect(project,w)).head,base);
 await run('update-ref','refs/heads/'+w.branch,plan.commit_sha,base);
 assert.equal((await git.finishCommit(project,w,plan)).commit_sha,plan.commit_sha);
 assert.equal((await git.finishCommit(project,w,plan)).commit_sha,plan.commit_sha);
 assert.equal((await git.inspect(project,w)).dirty,false);
 assert.equal((await run('rev-list','--count',base+'..'+w.branch)).stdout,'1');
 assert.equal(await readFile(w.path+'/fix','utf8'),'change');assert.equal((await run('rev-parse','dev')).stdout,base);
 await assert.rejects(git.finishCommit(project,{...w,ownership_token:'foreign'},plan),{code:'OWNERSHIP_CONFLICT'});
});
