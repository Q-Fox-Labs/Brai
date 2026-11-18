// ABOUTME: Проверяет scoped Git trust и запрет promisor lazy fetch в reader и Root recipe preparation.
// ABOUTME: Другой владелец моделируется Git test-флагом; missing blobs и fetch наблюдаются настоящим Git без сети.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,unlink,access,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
const gitEnv={PATH:'/usr/bin:/bin',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',HOME:'/nonexistent'};
test('operator repository is trusted per command when Git detects a different owner',async()=>{
 const root=await mkdtemp(join(tmpdir(),'bug-hunt-git-owner-')),repo=join(root,'repo');await mkdir(repo);
 const git=(...args)=>execFileSync('/usr/bin/git',args,{cwd:repo,env:gitEnv,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 try{
  git('init','-q');git('config','user.email','fixture@example.invalid');git('config','user.name','Fixture');
  await mkdir(join(repo,'services/auth'),{recursive:true});await mkdir(join(repo,'services/bug-hunt/src'),{recursive:true});
  await writeFile(join(repo,'services/auth/ROLES.md'),'immutable synthetic source\n');await writeFile(join(repo,'services/bug-hunt/src/identity.ts'),'synthetic baseline\n');git('add','.');git('commit','-qm','baseline');const baseline=git('rev-parse','HEAD');
  await writeFile(join(repo,'services/bug-hunt/src/identity.ts'),'synthetic fixed\n');git('add','.');git('commit','-qm','fixed');const fixed=git('rev-parse','HEAD');
  assert.throws(()=>execFileSync('/usr/bin/git',['--no-replace-objects','-C',repo,'ls-tree',baseline],{env:{...gitEnv,GIT_TEST_ASSUME_DIFFERENT_OWNER:'1'},stdio:['ignore','pipe','pipe']}),error=>error.status!==0&&error.stderr.toString().includes('dubious ownership'));
  const child=String.raw`
   import assert from 'node:assert/strict';
   import cp from 'node:child_process';
   import {syncBuiltinESMExports} from 'node:module';
   import {promisify} from 'node:util';
   import {pathToFileURL} from 'node:url';
   const [repo,baseline,fixed,out,sourceModule,recipeModule]=process.argv.slice(1),calls=[];
   const originalSync=cp.execFileSync,originalAsync=promisify(cp.execFile);
   const options=(args,value)=>{
    assert.deepEqual(args.slice(0,5),['--no-replace-objects','-c','safe.directory='+repo,'-C',repo]);
    assert.ok(['ls-tree','cat-file'].includes(args[5]));assert.equal(value.env.GIT_CONFIG_NOSYSTEM,'1');assert.equal(value.env.GIT_CONFIG_GLOBAL,'/dev/null');assert.equal(value.env.HOME,'/nonexistent');
    calls.push(args);return {...value,env:{...value.env,GIT_TEST_ASSUME_DIFFERENT_OWNER:'1'}};
   };
   cp.execFileSync=(file,args,value)=>originalSync(file,args,file==='/usr/bin/git'?options(args,value):value);
   const wrapper=()=>{throw Error('expected promisified execFile');};
   wrapper[promisify.custom]=(file,args,value)=>originalAsync(file,args,file==='/usr/bin/git'?options(args,value):value);
   cp.execFile=wrapper;syncBuiltinESMExports();
   const {sourceReader}=await import(pathToFileURL(sourceModule));
   const {prepareRecipes}=await import(pathToFileURL(recipeModule));
   const reader=sourceReader([{id:'registered',repository:repo,components:['auth'],paths:['services/auth/ROLES.md'],commits:[baseline],externalAllowed:true}]);
   const value=await reader.read({source:{id:'registered',component_id:'auth',commit:baseline}},'registered','services/auth/ROLES.md');assert.equal(value.text,'immutable synthetic source\n');
   await assert.rejects(prepareRecipes(repo,fixed,baseline,out),error=>error.message==='UNSUPPORTED_REVIEWER_SOURCE');
   assert.equal(calls.filter(args=>args[5]==='ls-tree').length,3);assert.equal(calls.filter(args=>args[5]==='cat-file').length,3);
   process.stdout.write(JSON.stringify({sourceRead:true,recipeSourceGate:true,commands:calls.length}));`;
  const output=execFileSync(process.execPath,['--input-type=module','-e',child,repo,baseline,fixed,join(root,'out'),fileURLToPath(new URL('../dist/verification-sources.js',import.meta.url)),fileURLToPath(new URL('../dist/verification-recipes.js',import.meta.url))],{encoding:'utf8',stdio:['ignore','pipe','pipe']});
  assert.deepEqual(JSON.parse(output),{sourceRead:true,recipeSourceGate:true,commands:6});
 }finally{await rm(root,{recursive:true,force:true});}
});
test('missing promisor blobs fail source reads and recipe preparation without invoking fetch',async()=>{
 const root=await mkdtemp(join(tmpdir(),'bug-hunt-git-promisor-')),repo=join(root,'repo'),remote=join(root,'remote.git'),marker=join(root,'fetch-invoked'),uploadpack=join(root,'upload-pack'),positiveTrace=join(root,'control.trace'),productTrace=join(root,'product.trace');await mkdir(repo);
 const git=(...args)=>execFileSync('/usr/bin/git',args,{cwd:repo,env:gitEnv,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 const shellQuote=value=>"'"+value.replaceAll("'","'\\''")+"'";
 try{
  git('init','-q');git('config','user.email','fixture@example.invalid');git('config','user.name','Fixture');git('init','--bare','-q',remote);
  await mkdir(join(repo,'services/auth'),{recursive:true});await mkdir(join(repo,'services/bug-hunt/src'),{recursive:true});
  await writeFile(join(repo,'services/auth/ROLES.md'),'synthetic immutable requirement\n');await writeFile(join(repo,'services/bug-hunt/src/identity.ts'),'synthetic baseline identity\n');git('add','.');git('commit','-qm','baseline');const baseline=git('rev-parse','HEAD');
  const sourceBlob=git('rev-parse',baseline+':services/auth/ROLES.md'),recipeBlob=git('rev-parse',baseline+':services/bug-hunt/src/identity.ts');
  await writeFile(join(repo,'services/bug-hunt/src/identity.ts'),'synthetic fixed identity\n');git('add','.');git('commit','-qm','fixed');const fixed=git('rev-parse','HEAD');
  await writeFile(uploadpack,"#!/bin/sh\nprintf '%s\\n' FETCH > "+shellQuote(marker)+"\nexit 1\n",{mode:0o700});
  git('config','core.repositoryformatversion','1');git('config','extensions.partialClone','origin');git('config','remote.origin.url',remote);git('config','remote.origin.promisor','true');git('config','remote.origin.partialclonefilter','blob:none');git('config','remote.origin.uploadpack',uploadpack);git('config','protocol.file.allow','always');
  for(const blob of [sourceBlob,recipeBlob])await unlink(join(repo,'.git/objects',blob.slice(0,2),blob.slice(2)));
  // Положительный контроль доказывает, что этот missing blob действительно вызывает implicit fetch.
  assert.throws(()=>execFileSync('/usr/bin/git',['-C',repo,'cat-file','blob',sourceBlob],{env:{...gitEnv,GIT_TRACE2_EVENT:positiveTrace},stdio:['ignore','pipe','pipe']}),error=>error.status!==0);
  assert.equal((await readFile(marker,'utf8')).trim(),'FETCH');const control=(await readFile(positiveTrace,'utf8')).trim().split('\n').map(JSON.parse);assert.ok(control.some(event=>event.event==='child_start'&&event.argv?.includes('fetch')));await unlink(marker);
  const child=String.raw`
   import assert from 'node:assert/strict';
   import cp from 'node:child_process';
   import {syncBuiltinESMExports} from 'node:module';
   import {promisify} from 'node:util';
   import {pathToFileURL} from 'node:url';
   const [repo,baseline,fixed,out,trace,sourceModule,recipeModule]=process.argv.slice(1),originalSync=cp.execFileSync,originalAsync=promisify(cp.execFile);
   const observed=value=>{assert.equal(value.env.GIT_NO_LAZY_FETCH,'1');return {...value,env:{...value.env,GIT_TRACE2_EVENT:trace}};};
   cp.execFileSync=(file,args,value)=>originalSync(file,args,file==='/usr/bin/git'?observed(value):value);
   const wrapper=()=>{throw Error('expected promisified execFile');};wrapper[promisify.custom]=(file,args,value)=>originalAsync(file,args,file==='/usr/bin/git'?observed(value):value);cp.execFile=wrapper;syncBuiltinESMExports();
   const {sourceReader}=await import(pathToFileURL(sourceModule));const {prepareRecipes}=await import(pathToFileURL(recipeModule));
   const reader=sourceReader([{id:'registered',repository:repo,components:['auth'],paths:['services/auth/ROLES.md'],commits:[baseline],externalAllowed:true}]);
   await assert.rejects(reader.read({source:{id:'registered',component_id:'auth',commit:baseline}},'registered','services/auth/ROLES.md'),error=>error.code==='SOURCE_UNAVAILABLE');
   await assert.rejects(prepareRecipes(repo,fixed,baseline,out),error=>Number.isInteger(error.status)&&error.status!==0);
   process.stdout.write(JSON.stringify({sourceRejected:true,recipeRejected:true}));`;
  const out=join(root,'out'),output=execFileSync(process.execPath,['--input-type=module','-e',child,repo,baseline,fixed,out,productTrace,fileURLToPath(new URL('../dist/verification-sources.js',import.meta.url)),fileURLToPath(new URL('../dist/verification-recipes.js',import.meta.url))],{encoding:'utf8',stdio:['ignore','pipe','pipe']});
  assert.deepEqual(JSON.parse(output),{sourceRejected:true,recipeRejected:true});await assert.rejects(access(marker),error=>error.code==='ENOENT');await assert.rejects(access(out),error=>error.code==='ENOENT');
  const trace=(await readFile(productTrace,'utf8')).trim().split('\n').map(JSON.parse);assert.ok(trace.length>0);assert.equal(trace.some(event=>event.event==='child_start'&&event.argv?.includes('fetch')),false);
 }finally{await rm(root,{recursive:true,force:true});}
});
