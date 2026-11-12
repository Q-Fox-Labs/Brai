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
import {canonical} from '../src/operator.mjs';
const digest=x=>createHash('sha256').update(x).digest('hex');
async function withReceipt(dir,bundle){const source={reviewed:true,disposition:{type:'archived'}},authorization_ref='01a18284-c791-7902-9879-60203820368b',receiptPath=dir+'/receipt.json';const bytes=JSON.stringify({authorization_ref,source_manifest_sha256:digest(canonical(source)),bundle});await writeFile(receiptPath,bytes,{mode:0o600});const archive={...bundle,authorization_ref,receipt:{path:receiptPath,sha256:digest(bytes)}};return {archive,manifest:{...source,disposition:{...source.disposition,archive}}};}
test('standalone archive restores every pinned head and rejects changed proofs',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'codeworks-archive-test-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const repo=root+'/repo',archives=root+'/archives',bundle=archives+'/case.bundle';await mkdir(archives,{mode:0o700});
 await command('git',['init','-b','main',repo]);const run=(...args)=>command('git',['-C',repo,...args]);await run('config','user.name','Fixture');await run('config','user.email','fixture@example.invalid');
 await writeFile(repo+'/file','data');await run('add','.');await run('commit','-m','fixture');await run('branch','fixture');const head=(await run('rev-parse','HEAD')).stdout;
 await run('bundle','create',bundle,'refs/heads/fixture');await chmod(bundle,0o600);
 const sha=createHash('sha256').update(await readFile(bundle)).digest('hex');const project={cleanup_archive_roots:[archives],cleanup_archive_uid:process.getuid()};const {archive,manifest}=await withReceipt(archives,{path:bundle,sha256:sha,heads:[{ref:'refs/heads/fixture',oid:head}]});
 const expected={branch:{oid:head},remote:{oid:null},tracking:{oid:head},worktree:{head:null}};
 assert.deepEqual(await verifyCleanupArchive(project,expected,archive,{manifest}),{sha256:sha,heads:archive.heads});

 for(const [code,stderr,errorCode] of [[null,'','ETIMEDOUT'],[128,'fatal: read: Input/output error','EIO'],[128,'fatal: Too many open files','EMFILE'],[128,'fatal: No space left on device','ENOSPC']]){
   await assert.rejects(verifyCleanupArchive(project,expected,archive,{manifest,run:async()=>({code,stderr,stdout:''})}),{code:errorCode});
 }
 await assert.rejects(verifyCleanupArchive(project,expected,archive,{manifest,run:async()=>({code:128,stderr:'invalid bundle',stdout:''})}),/ARCHIVE_UNVERIFIED/);

 await assert.rejects(verifyCleanupArchive(project,{...expected,tracking:{oid:'a'.repeat(40)}},archive,{manifest}),/ARCHIVE_UNVERIFIED/);
 await assert.rejects(verifyCleanupArchive(project,expected,{...archive,sha256:'0'.repeat(64)},{manifest}),/ARCHIVE_UNVERIFIED/);
 await assert.rejects(verifyCleanupArchive(project,expected,{...archive,heads:[{ref:'refs/heads/other',oid:head}]},{manifest}),/ARCHIVE_UNVERIFIED/);
 await assert.rejects(verifyCleanupArchive({...project,cleanup_archive_roots:[root]},expected,archive,{manifest}),/ARCHIVE_UNVERIFIED/);
 const receipt=JSON.parse(await readFile(archive.receipt.path,'utf8'));receipt.source_manifest_sha256='0'.repeat(64);const badBytes=JSON.stringify(receipt);await writeFile(archive.receipt.path,badBytes);const forged={...archive,receipt:{...archive.receipt,sha256:digest(badBytes)}};const forgedManifest={...manifest,disposition:{...manifest.disposition,archive:forged}};
 await assert.rejects(verifyCleanupArchive(project,expected,forged,{manifest:forgedManifest}),/ARCHIVE_UNVERIFIED/);
 await withReceipt(archives,{path:bundle,sha256:sha,heads:archive.heads});
 await chmod(bundle,0o666);await assert.rejects(verifyCleanupArchive(project,expected,archive,{manifest}),/ARCHIVE_UNVERIFIED/);await chmod(bundle,0o600);
 await symlink(bundle,archives+'/link.bundle');await assert.rejects(verifyCleanupArchive(project,expected,{...archive,path:archives+'/link.bundle'},{manifest}),/ARCHIVE_UNVERIFIED/);
});


test('rejects a bundle with prerequisites that cannot restore by itself',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'codeworks-archive-thin-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const repo=root+'/repo',archives=root+'/archives',bundle=archives+'/thin.bundle';await mkdir(archives,{mode:0o700});await command('git',['init','-b','main',repo]);const run=(...args)=>command('git',['-C',repo,...args]);
 await run('config','user.name','Fixture');await run('config','user.email','fixture@example.invalid');await writeFile(repo+'/file','before');await run('add','.');await run('commit','-m','base');const base=(await run('rev-parse','HEAD')).stdout;
 await writeFile(repo+'/file','after');await run('commit','-am','next');const head=(await run('rev-parse','HEAD')).stdout;await run('bundle','create',bundle,'refs/heads/main','^'+base);await chmod(bundle,0o600);
 const sha=createHash('sha256').update(await readFile(bundle)).digest('hex'),project={cleanup_archive_roots:[archives],cleanup_archive_uid:process.getuid()},bundleProof={path:bundle,sha256:sha,heads:[{ref:'refs/heads/main',oid:head}]};const {archive,manifest}=await withReceipt(archives,bundleProof);
 await assert.rejects(verifyCleanupArchive(project,{branch:{oid:head}},archive,{manifest}),/ARCHIVE_UNVERIFIED/);
});

test('standalone multi-head bundle restores distinct commits and requires the exact full head set',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'codeworks-archive-multi-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const repo=root+'/repo',archives=root+'/archives',bundle=archives+'/multiple.bundle';await mkdir(archives,{mode:0o700});
 await command('git',['init','-b','main',repo]);const run=(...args)=>command('git',['-C',repo,...args]);
 await run('config','user.name','Fixture');await run('config','user.email','fixture@example.invalid');
 await writeFile(repo+'/file','first commit');await run('add','.');await run('commit','-m','first');
 const first=(await run('rev-parse','HEAD')).stdout;await run('branch','first');
 await writeFile(repo+'/file','second commit');await run('commit','-am','second');
 const second=(await run('rev-parse','HEAD')).stdout;await run('branch','second');assert.notEqual(first,second);
 await run('bundle','create',bundle,'refs/heads/first','refs/heads/second');await chmod(bundle,0o600);
 const listed=(await command('git',['bundle','list-heads',bundle])).stdout.split('\n');assert.equal(listed.length,2);
 const heads=[{ref:'refs/heads/second',oid:second},{ref:'refs/heads/first',oid:first}];
 assert.deepEqual(listed.sort(),heads.map(h=>h.oid+' '+h.ref).sort());
 const info={path:bundle,sha256:digest(await readFile(bundle)),heads},project={cleanup_archive_roots:[archives],cleanup_archive_uid:process.getuid()};
 const {archive,manifest}=await withReceipt(archives,info);
 const expected={branch:{oid:first},remote:{oid:second},tracking:{oid:first},worktree:{head:second}};
 assert.deepEqual(await verifyCleanupArchive(project,expected,archive,{manifest}),{sha256:info.sha256,heads});
 // AIDEV-NOTE: Совпавшая квитанция не разрешает скрыть вторую голову или заменить её OID.
 for(const incomplete of [[heads[0]],[heads[0],{...heads[1],oid:'f'.repeat(40)}]]){
   const changed=await withReceipt(archives,{...info,heads:incomplete});
   await assert.rejects(verifyCleanupArchive(project,{branch:{oid:second}},changed.archive,{manifest:changed.manifest}),/ARCHIVE_UNVERIFIED/);
 }
 assert.equal(digest(await readFile(bundle)),info.sha256);
 assert.equal((await run('rev-parse','refs/heads/first')).stdout,first);assert.equal((await run('rev-parse','refs/heads/second')).stdout,second);
});
