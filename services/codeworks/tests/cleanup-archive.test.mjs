// ABOUTME: Проверяет безопасное восстановление архивов перед очисткой веток.
// ABOUTME: Использует только временные Git fixtures и не обращается к реальным областям.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,chmod,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {command} from '../src/git.mjs';
import {verifyCleanupArchive} from '../src/cleanup-archive.mjs';
test('standalone archive restores every pinned head and rejects changed proofs',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'codeworks-archive-test-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const repo=root+'/repo',archives=root+'/archives',bundle=archives+'/case.bundle';await mkdir(archives,{mode:0o700});
 await command('git',['init','-b','main',repo]);const run=(...args)=>command('git',['-C',repo,...args]);await run('config','user.name','Fixture');await run('config','user.email','fixture@example.invalid');
 await writeFile(repo+'/file','data');await run('add','.');await run('commit','-m','fixture');await run('branch','fixture');const head=(await run('rev-parse','HEAD')).stdout;
 await run('bundle','create',bundle,'refs/heads/fixture');await chmod(bundle,0o600);
 const sha=createHash('sha256').update(await readFile(bundle)).digest('hex');const project={cleanup_archive_roots:[archives],cleanup_archive_uid:process.getuid()};const archive={path:bundle,sha256:sha,heads:[{ref:'refs/heads/fixture',oid:head}]};
 const expected={branch:{oid:head},remote:{oid:null},tracking:{oid:head},worktree:{head:null}};
 assert.deepEqual(await verifyCleanupArchive(project,expected,archive),{sha256:sha,heads:archive.heads});
 await assert.rejects(verifyCleanupArchive(project,{...expected,tracking:{oid:'a'.repeat(40)}},archive),/ARCHIVE_UNVERIFIED/);
 await assert.rejects(verifyCleanupArchive(project,expected,{...archive,sha256:'0'.repeat(64)}),/ARCHIVE_UNVERIFIED/);
 await assert.rejects(verifyCleanupArchive(project,expected,{...archive,heads:[{ref:'refs/heads/other',oid:head}]}),/ARCHIVE_UNVERIFIED/);
 await assert.rejects(verifyCleanupArchive({...project,cleanup_archive_roots:[root]},expected,archive),/ARCHIVE_UNVERIFIED/);
 await chmod(bundle,0o666);await assert.rejects(verifyCleanupArchive(project,expected,archive),/ARCHIVE_UNVERIFIED/);await chmod(bundle,0o600);
 await symlink(bundle,archives+'/link.bundle');await assert.rejects(verifyCleanupArchive(project,expected,{...archive,path:archives+'/link.bundle'}),/ARCHIVE_UNVERIFIED/);
});


test('rejects a bundle with prerequisites that cannot restore by itself',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'codeworks-archive-thin-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const repo=root+'/repo',archives=root+'/archives',bundle=archives+'/thin.bundle';await mkdir(archives,{mode:0o700});await command('git',['init','-b','main',repo]);const run=(...args)=>command('git',['-C',repo,...args]);
 await run('config','user.name','Fixture');await run('config','user.email','fixture@example.invalid');await writeFile(repo+'/file','before');await run('add','.');await run('commit','-m','base');const base=(await run('rev-parse','HEAD')).stdout;
 await writeFile(repo+'/file','after');await run('commit','-am','next');const head=(await run('rev-parse','HEAD')).stdout;await run('bundle','create',bundle,'refs/heads/main','^'+base);await chmod(bundle,0o600);
 const sha=createHash('sha256').update(await readFile(bundle)).digest('hex'),project={cleanup_archive_roots:[archives],cleanup_archive_uid:process.getuid()},archive={path:bundle,sha256:sha,heads:[{ref:'refs/heads/main',oid:head}]};
 await assert.rejects(verifyCleanupArchive(project,{branch:{oid:head}},archive),/ARCHIVE_UNVERIFIED/);
});
