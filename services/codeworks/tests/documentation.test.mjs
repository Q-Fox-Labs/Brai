// ABOUTME: Реальный bare origin доказывает scoped docs commit/push без worktree и потери чужого staging.
// ABOUTME: Конкурентный HEAD и неизвестный push завершаются честно, повтор сверяет remote.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {command} from '../src/git.mjs';
import {beginDocumentation,documentationBytes,planDocumentation,finishDocumentation} from '../src/documentation.mjs';
async function fixture(run){
 const lock=process.env.CODEWORKS_LOCK_HELD;process.env.CODEWORKS_LOCK_HELD='1';
 const dir=await mkdtemp(tmpdir()+'/cwd-'),repo=dir+'/repo',origin=dir+'/origin.git';
 const g=(args,options={})=>command('git',['-C',repo,...args],options);
 try{
  await mkdir(repo);await command('git',['init','--bare',origin]);await g(['init','-b','dev']);
  await g(['config','user.name','Codeworks fixture']);await g(['config','user.email','fixture@example.test']);
  await mkdir(repo+'/docs');await writeFile(repo+'/docs/a.md','base\n');await writeFile(repo+'/foreign.txt','base\n');
  await g(['add','.']);await g(['commit','-m','base']);await g(['remote','add','origin',origin]);await g(['push','-u','origin','dev']);
  const project={repo_path:repo,common_dir:repo+'/.git',documentation_paths:['docs'],excluded_paths:[]};
  const change=async()=>{const journal={...await beginDocumentation(project,null,['docs/a.md']),id:randomUUID(),phase:'ready'};await writeFile(repo+'/docs/a.md','own\n');journal.entries['docs/a.md'].after=await documentationBytes(project,'docs/a.md');return {id:randomUUID(),created_at:new Date().toISOString(),request:{message:'Документация',documentation:journal}};};
  await run({dir,repo,origin,g,project,change});
 }finally{await rm(dir,{recursive:true,force:true});if(lock===undefined)delete process.env.CODEWORKS_LOCK_HELD;else process.env.CODEWORKS_LOCK_HELD=lock;}
}
test('docs write→commit/push→readback uses no WT and preserves foreign staged/working bytes',()=>fixture(async({repo,g,project,change})=>{
 await writeFile(repo+'/foreign.txt','foreign staged\n');await g(['add','foreign.txt']);await writeFile(repo+'/foreign.txt','foreign working\n');
 const foreign=(await g(['ls-files','--stage','--','foreign.txt'])).stdout,op=await change();
 const plan=await planDocumentation(project,op);assert.equal((await finishDocumentation(project,op,plan)).commit_sha,plan.commit_sha);
 assert.equal((await g(['ls-remote','origin','refs/heads/dev'])).stdout.split(/\s/)[0],plan.commit_sha);
 assert.equal((await g(['show',plan.commit_sha+':docs/a.md'])).stdout,'own');assert.equal((await g(['show',plan.commit_sha+':foreign.txt'])).stdout,'base');
 assert.equal((await g(['ls-files','--stage','--','foreign.txt'])).stdout,foreign);assert.equal(await readFile(repo+'/foreign.txt','utf8'),'foreign working\n');
 assert.equal((await g(['worktree','list','--porcelain'])).stdout.match(/^worktree /gm).length,1);
 assert.equal((await g(['diff','HEAD','--','docs/a.md'])).stdout,'');
 assert.equal((await finishDocumentation(project,op,plan)).commit_sha,plan.commit_sha);
 assert.equal((await g(['rev-list','--count','HEAD'])).stdout,'2');
}));
test('foreign pre-existing and subsequent edits to claimed path reject without mutation',()=>fixture(async({repo,g,project,change})=>{
 await writeFile(repo+'/docs/a.md','foreign\n');await assert.rejects(beginDocumentation(project,null,['docs/a.md']),/OWNERSHIP_CONFLICT/);
 await g(['checkout','--','docs/a.md']);const op=await change();await writeFile(repo+'/docs/a.md','later foreign\n');
 await assert.rejects(planDocumentation(project,op),/OWNERSHIP_CONFLICT/);assert.equal(await readFile(repo+'/docs/a.md','utf8'),'later foreign\n');
}));
test('concurrent local HEAD after plan rejects CAS and leaves remote unchanged',()=>fixture(async({repo,g,project,change})=>{
 const op=await change(),plan=await planDocumentation(project,op);await writeFile(repo+'/foreign.txt','concurrent\n');await g(['add','foreign.txt']);await g(['commit','-m','concurrent']);
 await assert.rejects(finishDocumentation(project,op,plan),/TARGET_CHANGED/);
 assert.equal((await g(['ls-remote','origin','refs/heads/dev'])).stdout.split(/\s/)[0],plan.parent_sha);
}));
test('unknown push outcome is reconciled and never sent blindly again',()=>fixture(async({g,project,change})=>{
 const op=await change(),plan={...await planDocumentation(project,op),push_attempted:true};
 await assert.rejects(finishDocumentation(project,op,plan),/GIT_FAILED/);
 assert.equal((await g(['ls-remote','origin','refs/heads/dev'])).stdout.split(/\s/)[0],plan.parent_sha);
 await g(['push','origin',plan.commit_sha+':refs/heads/dev']);
 assert.equal((await finishDocumentation(project,op,plan)).commit_sha,plan.commit_sha);
}));
test('head advanced on unrelated paths before planning is safe; registry cannot be expanded',()=>fixture(async({repo,g,project,change})=>{
 const op=await change();await writeFile(repo+'/foreign.txt','external\n');await g(['add','foreign.txt']);await g(['commit','-m','external']);await g(['push','origin','dev']);
 const plan=await planDocumentation(project,op);await finishDocumentation(project,op,plan);
 assert.equal((await g(['show','HEAD:foreign.txt'])).stdout,'external');
 await assert.rejects(beginDocumentation(project,null,['foreign.txt']),/OWNERSHIP_CONFLICT/);
}));
