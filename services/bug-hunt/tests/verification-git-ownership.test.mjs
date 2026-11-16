// ABOUTME: Проверяет точечный safe.directory в source reader и Root recipe preparation настоящим Git.
// ABOUTME: Git test-флаг включает проверку другого владельца без Root, chown или изменения глобального config.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
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
