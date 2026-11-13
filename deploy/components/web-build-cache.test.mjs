// ABOUTME: Проверяет перенос только целого compiler cache отдельными inode.
// ABOUTME: Подмена cache после receipt запрещает публикацию и восстановление.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {copyFileSync,existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,statSync,symlinkSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {cacheIdentity,cacheOperation,saveWebCacheMetadata} from './web-build-cache.mjs';

test('compiler cache copy is independent and requires exact recorded bytes',t=>{
  const root=mkdtempSync(join(tmpdir(),'brai-web-cache-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const source=join(root,'source'),store=join(root,'store'),destination=join(root,'destination'),identity='a'.repeat(64);
  mkdirSync(join(source,'turbopack','version'),{recursive:true});mkdirSync(join(store,identity),{recursive:true});mkdirSync(destination);
  writeFileSync(join(source,'turbopack','version','CURRENT'),JSON.stringify({max_sequence_number:1}));
  writeFileSync(join(source,'turbopack','version','00000001.meta'),'committed');
  writeFileSync(join(source,'turbopack','version','00000001.sst'),'valid');
  writeFileSync(join(source,'.tsbuildinfo'),'types');
  saveWebCacheMetadata(source,{identity,files:{},dirs:{}});
  cacheOperation('publish',source,identity,store);
  cacheOperation('restore',destination,identity,store);
  const restored=join(destination,'turbopack','version','00000001.sst');
  assert.equal(readFileSync(restored,'utf8'),'valid');
  assert.equal(readFileSync(join(destination,'.tsbuildinfo'),'utf8'),'types');
  assert.notEqual(statSync(restored).ino,statSync(join(source,'turbopack','version','00000001.sst')).ino);
  assert.notEqual(statSync(join(destination,'.tsbuildinfo')).ino,statSync(join(source,'.tsbuildinfo')).ino);
  writeFileSync(join(source,'turbopack','version','00000001.sst'),'changed');
  assert.throws(()=>cacheOperation('publish',source,identity,store),/WEB_CACHE_CHANGED/);
  writeFileSync(join(store,identity,'snapshot','turbopack','version','00000001.sst'),'tampered');
  const another=join(root,'another');mkdirSync(another);
  cacheOperation('restore',another,identity,store);
  assert.equal(existsSync(join(another,'turbopack','version','00000001.sst')),false);
  rmSync(join(store,identity,'snapshot','turbopack'),{recursive:true});
  symlinkSync(join(source,'turbopack'),join(store,identity,'snapshot','turbopack'));
  assert.throws(()=>cacheOperation('restore',another,identity,store),/WEB_CACHE_PATH_INVALID/);
  const receipt=join(store,identity,'snapshot','.brai-source-snapshot.json');
  const secret=join(root,'secret');writeFileSync(secret,'private');rmSync(receipt);symlinkSync(secret,receipt);
  assert.throws(()=>cacheOperation('restore',another,identity,store));
  assert.throws(()=>cacheOperation('restore',another,'../escape',store),/WEB_CACHE_IDENTITY_INVALID/);
});

test('uncommitted compiler state cannot produce cache metadata',t=>{
  const root=mkdtempSync(join(tmpdir(),'brai-web-uncommitted-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  mkdirSync(join(root,'turbopack','version'),{recursive:true});
  writeFileSync(join(root,'turbopack','version','CURRENT'),JSON.stringify({max_sequence_number:2}));
  writeFileSync(join(root,'turbopack','version','00000001.meta'),'old');
  writeFileSync(join(root,'.tsbuildinfo'),'types');
  saveWebCacheMetadata(root,{identity:'a'.repeat(64),files:{},dirs:{}});
  assert.equal(existsSync(join(root,'.brai-source-snapshot.json')),false);
});

test('publisher cache is not qualified by an environment flag without the fixed proof FD',()=>{
  const old=process.env.BRAI_PUBLISHER_PROOF_FD;
  process.env.BRAI_PUBLISHER_PROOF_FD='3';
  try {assert.equal(cacheIdentity('/var/lib/brai-dev/host-publisher/11111111-1111-4111-8111-111111111111/checkout',{},[]),null);}
  finally {if(old===undefined)delete process.env.BRAI_PUBLISHER_PROOF_FD;else process.env.BRAI_PUBLISHER_PROOF_FD=old;}
});

test('publisher accepts only the mounted readonly receipt and sealed paths inside a real namespace',t=>{
  const root=mkdtempSync(join(tmpdir(),'brai-sealed-proof-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const id='f6dd5556-83f6-4e66-8589-9cb923e723de',job=join(root,'job'),generation=join(root,'generation'),code=join(root,'code');
  for(const path of [join(job,'checkout'),join(job,'repo/.git/codeworks-dependencies/prepared'),join(generation,'node_modules'),code])mkdirSync(path,{recursive:true});
  mkdirSync(join(job,'checkout/apps/web'),{recursive:true});
  for(const name of ['package.json','apps/web/package.json','apps/web/next.config.ts','apps/web/tsconfig.json','apps/web/postcss.config.mjs'])writeFileSync(join(job,'checkout',name),'{}\n');
  const hash='a'.repeat(64),mount=`/opt/brai-shared/immutable-files-v1/npm-${hash}`,base=`/var/lib/brai-dev/host-publisher/${id}`;
  const tool=JSON.stringify({nodeAbi:process.versions.modules,glibc:`glibc ${process.report.getReport().header.glibcVersionRuntime}`})+'\n';
  writeFileSync(join(generation,'.brai-toolchain.json'),tool);
  const lock=JSON.stringify({packages:{}})+'\n';writeFileSync(join(generation,'package-lock.json'),lock);
  writeFileSync(join(generation,'.brai-closure.json'),JSON.stringify({packages:[]}));
  mkdirSync(join(job,'checkout/node_modules'));writeFileSync(join(job,'checkout/node_modules/.brai-worktree.json'),JSON.stringify({dependencyRoot:base+'/repo/.git/codeworks-dependencies/prepared'}));
  const proof={format:'brai-dev-dependency-generation-v1',root:mount,lockSha256:createHash('sha256').update(lock).digest('hex'),contentSha256:hash,toolchainSha256:createHash('sha256').update(tool).digest('hex'),platform:'linux',arch:'x64',node:process.versions.node,npm:'11.19.1',relativeRoots:['node_modules']};
  const receipt=join(root,'receipt');writeFileSync(receipt,JSON.stringify(proof));
  copyFileSync(join(import.meta.dirname,'web-build-cache.mjs'),join(code,'web-build-cache.mjs'));
  copyFileSync(join(import.meta.dirname,'source-snapshot.mjs'),join(code,'source-snapshot.mjs'));
  copyFileSync(join(import.meta.dirname,'sealed-dependencies.mjs'),join(code,'sealed-dependencies.mjs'));
  writeFileSync(join(code,'graph.mjs'),'export const sourceFiles=()=>[];\n');
  writeFileSync(join(code,'lock-inputs.mjs'),'export const lockInputs=()=>[];\n');
  writeFileSync(join(code,'build-web-standalone.mjs'),'// fixture\n');
  writeFileSync(join(code,'probe.mjs'),`import {cacheIdentity} from './web-build-cache.mjs';const value=cacheIdentity(${JSON.stringify(base+'/checkout')},{},[${JSON.stringify(base+'/repo/.git/codeworks-dependencies/prepared/node_modules')}]);console.log(value??'unqualified');`);
  const toolroot='/usr/local/libexec/brai-dev-release/check-tools';
  const args=['--unshare-pid','--unshare-net','--tmpfs','/','--ro-bind','/usr','/usr','--ro-bind',toolroot,toolroot,'--symlink','usr/bin','/bin','--symlink','usr/lib','/lib','--symlink','usr/lib64','/lib64','--proc','/proc','--dev','/dev','--dir','/code','--ro-bind',code,'/code','--dir','/publisher-proof','--ro-bind',receipt,'/publisher-proof/receipt.json','--dir','/opt','--dir','/opt/brai-shared','--dir','/opt/brai-shared/immutable-files-v1','--ro-bind',generation,mount,'--dir','/var','--dir','/var/lib','--dir','/var/lib/brai-dev','--dir','/var/lib/brai-dev/host-publisher','--dir',base,'--ro-bind',job,base,'--ro-bind',generation,base+'/repo/.git/codeworks-dependencies/prepared','--clearenv','--setenv','BRAI_PUBLISHER_PROOF_FD','3','--'];
  const run=path=>spawnSync('/usr/bin/bwrap',[...args,'/bin/sh','-c',`exec 3<${path}; exec ${toolroot}/bin/node /code/probe.mjs`],{encoding:'utf8'});
  const accepted=run('/publisher-proof/receipt.json');assert.equal(accepted.status,0,accepted.stderr);assert.match(accepted.stdout.trim(),/^[a-f0-9]{64}$/);
  const rejected=run('/code/graph.mjs');assert.equal(rejected.status,0,rejected.stderr);assert.equal(rejected.stdout.trim(),'unqualified');
  writeFileSync(join(generation,'package-lock.json'),'{}\n');
  const changed=run('/publisher-proof/receipt.json');assert.equal(changed.status,0,changed.stderr);assert.equal(changed.stdout.trim(),'unqualified');
});
