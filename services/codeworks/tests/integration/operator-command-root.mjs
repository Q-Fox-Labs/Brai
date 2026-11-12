// ABOUTME: Проверяет настоящий root → runuser → Git/gh на изолированных Ansible fixtures без секретов.
// ABOUTME: Читает подготовленные repository/profile, создаёт только свои synthetic archive fixtures, без БД и изменения пользователей.
import assert from 'node:assert/strict';
import path from 'node:path';
import {readFile,writeFile,mkdtemp,lstat,chown,chmod,rename,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {canonical} from '../../src/contracts.mjs';
import {verifyCleanupArchive} from '../../src/cleanup-archive.mjs';
import {command} from '../../src/git.mjs';
import {withOperatorCommands,createCleanupArchiveDirectory} from '../../src/operator-command.mjs';

assert.equal(process.geteuid?.(),0,'native operator fixture requires real root');
const user=process.env.CODEWORKS_OPERATOR_FIXTURE_USER,repo=process.env.CODEWORKS_OPERATOR_FIXTURE_REPOSITORY,editor=process.env.CODEWORKS_OPERATOR_FIXTURE_GH_EDITOR;
assert.ok(typeof user==='string'&&typeof repo==='string'&&path.isAbsolute(repo)&&typeof editor==='string'&&editor.length,'explicit isolated user, repository and non-secret gh editor are required');
const saved={HOME:process.env.HOME,GH_TOKEN:process.env.GH_TOKEN,GITHUB_TOKEN:process.env.GITHUB_TOKEN,GH_CONFIG_DIR:process.env.GH_CONFIG_DIR,CODEWORKS_DATABASE_URL:process.env.CODEWORKS_DATABASE_URL};
Object.assign(process.env,{HOME:'/root',GH_TOKEN:'fixture-root-token-not-secret',GITHUB_TOKEN:'fixture-root-github-token-not-secret',GH_CONFIG_DIR:'/root/fixture-profile-that-must-not-be-read',CODEWORKS_DATABASE_URL:'fixture-db-sentinel-not-a-url'});
try{
  await assert.rejects(withOperatorCommands(undefined,()=>command('git',['-C',repo,'status','--porcelain'])),/OPERATOR_USER_REQUIRED/);
  await withOperatorCommands(user,async()=>{
    const status=await command('git',['-C',repo,'status','--porcelain']);
    assert.equal(status.stdout,'','fixture repository must remain clean');
    assert.match((await command('git',['-C',repo,'rev-parse','HEAD'])).stdout,/^[0-9a-f]{40}$/);
    assert.equal((await command('gh',['config','get','editor'])).stdout,editor,'gh must read the configured user profile, not root HOME/GH_CONFIG_DIR');
    assert.equal(process.geteuid(),0,'operator and database process remain root');
  });
  const agentRepo=process.env.CODEWORKS_OPERATOR_FIXTURE_AGENT_REPOSITORY;
  if(agentRepo){
    assert.ok(path.isAbsolute(agentRepo));
    await withOperatorCommands('agent',async()=>{
      assert.equal((await command('git',['-C',agentRepo,'status','--porcelain'])).stdout,'');
      assert.match((await command('git',['-C',agentRepo,'rev-parse','HEAD'])).stdout,/^[0-9a-f]{40}$/);
    });
  }
  const archiveBuild=await withOperatorCommands(user,()=>createCleanupArchiveDirectory()),privateRoot=await mkdtemp('/tmp/codeworks-operator-private-');
  try{
    const identity=await lstat(archiveBuild);assert.notEqual(identity.uid,0,'fresh Git directory belongs to the configured user');
    const ref=(await withOperatorCommands(user,()=>command('git',['-C',repo,'symbolic-ref','HEAD']))).stdout;
    const head=(await withOperatorCommands(user,()=>command('git',['-C',repo,'rev-parse',ref]))).stdout;
    const bundle=archiveBuild+'/fixture.bundle';
    await withOperatorCommands(user,()=>command('git',['-C',repo,'bundle','create',bundle,ref]));
    const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
    const source={reviewed:true,disposition:{type:'archived'}},sourceDigest=hash(canonical(source));
    const receipt=async(directory,bundlePath,owner)=>{
      const bundleInfo={path:bundlePath,sha256:hash(await readFile(bundlePath)),heads:[{ref,oid:head}]},receiptPath=directory+'/receipt.json',authorization_ref='isolated-owner-fixture';
      const bytes=JSON.stringify({authorization_ref,source_manifest_sha256:sourceDigest,bundle:bundleInfo});
      await writeFile(receiptPath,bytes,{mode:0o600});if(owner)await chown(receiptPath,owner.uid,owner.gid);
      const archive={...bundleInfo,authorization_ref,receipt:{path:receiptPath,sha256:hash(bytes)}};
      return {archive,manifest:{...source,disposition:{type:'archived',archive}}};
    };
    const readable=await receipt(archiveBuild,bundle,identity);
    await withOperatorCommands(user,()=>verifyCleanupArchive({cleanup_archive_roots:[archiveBuild],cleanup_archive_uid:identity.uid},{branch:{oid:head}},readable.archive,{manifest:readable.manifest}));
    // AIDEV-NOTE: Только synthetic fixture превращается в root-private до начала отрицательной проверки.
    const privateBundle=privateRoot+'/fixture.bundle';await rename(bundle,privateBundle);await chown(privateBundle,0,0);await chmod(privateBundle,0o600);
    const proof=await receipt(privateRoot,privateBundle),before=await lstat(privateBundle),bytes=await readFile(privateBundle),receiptBytes=await readFile(proof.archive.receipt.path);
    await assert.rejects(withOperatorCommands(user,()=>verifyCleanupArchive({cleanup_archive_roots:[privateRoot],cleanup_archive_uid:0},{branch:{oid:head}},proof.archive,{manifest:proof.manifest})),{code:'ARCHIVE_ACCESS_FORBIDDEN'});
    const after=await lstat(privateBundle);
    for(const key of ['dev','ino','uid','gid','mode','size','mtimeMs'])assert.equal(after[key],before[key],'private source identity and permissions remain unchanged');
    assert.deepEqual(await readFile(privateBundle),bytes);assert.deepEqual(await readFile(proof.archive.receipt.path),receiptBytes);
  }finally{await rm(archiveBuild,{recursive:true,force:true});await rm(privateRoot,{recursive:true,force:true});}
  const legacyRoot=await mkdtemp('/tmp/codeworks-operator-legacy-');
  try{
    await chmod(legacyRoot,0o755);const invalidManifest=legacyRoot+'/invalid.json';await writeFile(invalidManifest,'{}',{mode:0o644});
    const operator=fileURLToPath(new URL('../../src/operator.mjs',import.meta.url));
    const cliAsAgent=args=>new Promise((resolve,reject)=>{
      const child=spawn('/usr/sbin/runuser',['--user','agent','--',process.execPath,operator,...args],{cwd:'/',env:{PATH:'/usr/bin:/bin',CODEWORKS_DATABASE_URL:'postgresql://fixture:fixture@127.0.0.1:1/unused',CODEWORKS_OPERATOR_USER:'root'},stdio:['ignore','pipe','pipe']});
      let stdout='',stderr='';const timer=setTimeout(()=>child.kill('SIGKILL'),15000);
      child.stdout.on('data',chunk=>{stdout+=chunk;});child.stderr.on('data',chunk=>{stderr+=chunk;});
      child.once('error',error=>{clearTimeout(timer);reject(error);});
      child.once('close',code=>{clearTimeout(timer);resolve({code,stdout,stderr});});
    });
    const legacy=await cliAsAgent(['cleanup-preflight','--project','fixture','--manifest',invalidManifest]);
    assert.equal(legacy.code,1);assert.equal(legacy.stderr.trim(),'Owner operation failed: INVALID_MANIFEST','non-root legacy CLI reaches the original manifest validation without DB I/O');
    const privateRepair=await cliAsAgent(['cleanup-resume-preflight','--project','fixture','--request-json','{"obligation_id":"00000000-0000-4000-8000-000000000001"}']);
    assert.equal(privateRepair.code,1);assert.equal(privateRepair.stderr.trim(),'Owner operation failed: OWNER_REQUIRED');
    const completion=await cliAsAgent(['write-completion-import','--receipt',legacyRoot+'/missing-receipt']);
    assert.equal(completion.code,1);assert.equal(completion.stderr.trim(),'Owner operation failed: NATIVE_COMPLETION_UNVERIFIED','legacy import reaches its unchanged root-owned proof boundary without DB I/O');
    const attest=await cliAsAgent(['write-completion-attest','--call','00000000-0000-4000-8000-000000000001','--source',legacyRoot+'/missing-source','--receipt',legacyRoot+'/missing-receipt']);
    assert.equal(attest.code,1);assert.equal(attest.stderr.trim(),'Owner operation failed: OWNER_REQUIRED');
  }finally{await rm(legacyRoot,{recursive:true,force:true});}
  const privateProof=process.env.CODEWORKS_OPERATOR_FIXTURE_PRIVATE_ARCHIVE_MANIFEST;
  if(privateProof){
    assert.ok(path.isAbsolute(privateProof));
    const fixture=JSON.parse(await readFile(privateProof,'utf8'));
    await assert.rejects(withOperatorCommands(user,()=>verifyCleanupArchive(fixture.project,fixture.expected,fixture.archive,{manifest:fixture.manifest})),{code:'ARCHIVE_ACCESS_FORBIDDEN'});
  }
  console.log(JSON.stringify({root_operator:true,git_user_verified:true,gh_profile_verified:true,missing_policy_refused:true,agent_repository_verified:!!agentRepo,private_archive_refused:true,archive_verifier_user_verified:true,legacy_agent_cli_preserved:true,legacy_completion_cli_preserved:true,nonroot_private_cli_refused:true}));
}finally{
  for(const [key,value] of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
}
