// ABOUTME: Проверяет настоящий Git cleanup с root-owned архивом игнорируемого дерева.
// ABOUTME: Изменение источника или подтверждения сохраняет рабочую область.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {access,chmod,lstat,mkdir,mkdtemp,readFile,rm,symlink,writeFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {command} from '../../src/git.mjs';
import {createActivityGit} from '../../src/git-steps.mjs';
import {snapshotPreservedTree} from '../../src/filesystem-preservation.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const run=(args,options={})=>command(args[0],args.slice(1),options);

test('root-sealed ignored files are rechecked under the Git cleanup lock',{timeout:120000},async t=>{
  assert.equal(process.getuid?.(),0,'production receipt verification requires root-owned fixture');
  const fixtureRoot=process.env.CODEWORKS_FS_FIXTURE_ROOT;
  assert.ok(fixtureRoot&&path.isAbsolute(fixtureRoot),'explicit disposable fixture root required');
  const root=await mkdtemp(path.join(fixtureRoot,'git-preservation-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const repo=path.join(root,'repo'),areas=path.join(root,'areas'),vault=path.join(root,'vault'),restore=path.join(root,'restore');
  await Promise.all([mkdir(repo),mkdir(areas),mkdir(vault,{mode:0o700}),mkdir(restore)]);
  await run(['git','init',repo]);
  await run(['git','-C',repo,'config','user.name','Fixture']);
  await run(['git','-C',repo,'config','user.email','fixture@example.invalid']);
  await writeFile(path.join(repo,'.gitignore'),'tmp/\n');
  await run(['git','-C',repo,'add','.gitignore']);
  await run(['git','-C',repo,'commit','-m','fixture']);
  const base=(await run(['git','-C',repo,'rev-parse','HEAD'])).stdout;
  const id=randomUUID(),project={id:randomUUID(),repo_path:repo,common_dir:path.join(repo,'.git'),workspace_root:areas};
  const w={id,ownership_token:randomUUID(),base_sha:base,branch:'feature/preservation',path:path.join(areas,id)};
  const git=createActivityGit().git;await git.branch(project,w);await git.checkout(project,w);
  await mkdir(path.join(w.path,'tmp'));
  const source=path.join(w.path,'tmp','ignored.txt'),outside=path.join(root,'outside.txt');
  await writeFile(source,'preserved ignored bytes\n');await writeFile(outside,'outside secret\n');
  await symlink(outside,path.join(w.path,'tmp','external-link'));
  const initial=await snapshotPreservedTree(w.path,'tmp');
  await writeFile(outside,'changed outside bytes\n');
  assert.deepEqual(await snapshotPreservedTree(w.path,'tmp'),initial,'snapshot does not follow external symlink');
  await assert.rejects(snapshotPreservedTree(w.path,'tmp/external-link'),{code:'TARGET_CHANGED'});
  const archive=path.join(vault,'ignored.tar'),receiptPath=path.join(vault,'receipt.json');
  const seal=async()=>{
    await run(['tar','-C',w.path,'-cf',archive,'tmp']);await chmod(archive,0o600);
    const s=await lstat(archive,{bigint:true}),snapshot=await snapshotPreservedTree(w.path,'tmp');
    const metadata={dev:String(s.dev),ino:String(s.ino),size:String(s.size),mtime_ns:String(s.mtimeNs),ctime_ns:String(s.ctimeNs),mode:String(s.mode&0o7777n),uid:String(s.uid)};
    const receipt={version:1,project_id:project.id,workspace_id:w.id,workspace_path:w.path,source_relative_path:'tmp',source_snapshot_sha256:snapshot.sha256,source_entries:snapshot.entries,archive:{path:archive,sha256:hash(await readFile(archive)),...metadata}};
    const bytes=Buffer.from(JSON.stringify(receipt));await writeFile(receiptPath,bytes,{mode:0o600});await chmod(receiptPath,0o600);
    return {receipt_path:receiptPath,receipt_sha256:hash(bytes)};
  };
  let proof=await seal();
  await run(['tar','-C',restore,'-xf',archive]);
  assert.deepEqual(await snapshotPreservedTree(restore,'tmp'),initial,'archive restores the complete ignored tree');
  const expected=await git.inspectResources(project,w);
  assert.equal(expected.worktree.dirty,false,'fixture data is actually ignored by Git');
  const manifest={manifestVersion:1,reviewed:true,project_id:project.id,common_dir:project.common_dir,workspace_id:w.id,branch:expected.branch,remote:expected.remote,tracking:expected.tracking,ownership:expected.ownership,worktree:expected.worktree,provenance:[{kind:'fixture'}],disposition:{type:'archived'},manifest_sha256:'a'.repeat(64)};
  const cleanup=()=>git.cleanupStep(project,w,expected,'worktree',{manifest:{...manifest,filesystem_preservation:proof}});
  const refused=async()=>{await assert.rejects(cleanup(),{code:'TARGET_CHANGED'});await access(source);};
  for(const invalid of [null,false,{}]){
    await assert.rejects(git.cleanupStep(project,w,expected,'worktree',{manifest:{...manifest,filesystem_preservation:invalid}}),{code:'TARGET_CHANGED'});
    await access(source);
  }
  await writeFile(source,'changed\n');await refused();await writeFile(source,'preserved ignored bytes\n');
  await rm(source);await assert.rejects(cleanup(),{code:'TARGET_CHANGED'});await writeFile(source,'preserved ignored bytes\n');
  const extra=path.join(w.path,'tmp','new-ignored');await writeFile(extra,'new\n');await refused();await rm(extra);
  await chmod(receiptPath,0o644);await refused();await chmod(receiptPath,0o600);
  const originalReceipt=await readFile(receiptPath),forged=JSON.parse(originalReceipt);forged.workspace_id=randomUUID();
  const forgedBytes=Buffer.from(JSON.stringify(forged));await writeFile(receiptPath,forgedBytes);proof={receipt_path:receiptPath,receipt_sha256:hash(forgedBytes)};await refused();
  await writeFile(receiptPath,originalReceipt);proof={receipt_path:receiptPath,receipt_sha256:hash(originalReceipt)};
  await writeFile(archive,'corrupt archive\n');await refused();proof=await seal();
  const retained=await readFile(archive),result=await cleanup();
  assert.equal(result.outcome,'removed');await assert.rejects(access(w.path),{code:'ENOENT'});
  assert.deepEqual(await readFile(archive),retained,'archive bytes survive Git removal');
});
