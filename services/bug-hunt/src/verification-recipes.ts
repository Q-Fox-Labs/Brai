// ABOUTME: Готовит фиксированные synthetic recipes из разрешённых Git blobs двух принятых commits.
// ABOUTME: Компиляция выполняется локально; скрипт не запускает тесты, сеть и checkout не изменяет.
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir,writeFile,readFile,realpath} from 'node:fs/promises';
import {dirname,isAbsolute,join,posix,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import ts from 'typescript';
import {treeDigest} from './verification-runner.js';
import {verificationHash as hash} from './verification-store.js';
const digest=(value:Buffer)=>createHash('sha256').update(value).digest('hex');
const commits=(value:string)=>/^[a-f0-9]{40}$/.test(value);
const env={PATH:'/usr/bin:/bin',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_NO_REPLACE_OBJECTS:'1',GIT_NO_LAZY_FETCH:'1',GIT_OPTIONAL_LOCKS:'0',HOME:'/nonexistent'};

/** Создаёт новый каталог, не перезаписывая прежнюю квалифицированную поставку. */
export async function prepareRecipes(repo:string,fixed:string,baseline:string,out:string){
 if(!isAbsolute(repo)||!isAbsolute(out)||!commits(fixed)||!commits(baseline)||fixed===baseline)throw Error('INVALID_RECIPE_INPUT');
 if(ts.version!=='5.9.3')throw Error('UNSUPPORTED_COMPILER');
 const repoRoot=await realpath(repo),outParent=await realpath(dirname(out));
 if(outParent===repoRoot||outParent.startsWith(repoRoot+'/'))throw Error('OUTPUT_INSIDE_REPOSITORY');
 // AIDEV-NOTE: Root доверяет только явно переданному repo; safe.directory не попадает в глобальный config.
 const git=(commit:string,path:string)=>{
  const tree=execFileSync('/usr/bin/git',['--no-replace-objects','-c','safe.directory='+repo,'-C',repo,'ls-tree','-z',commit,'--',path],{env,maxBuffer:4096,stdio:['ignore','pipe','pipe']}).toString('utf8');
  const m=/^100(?:644|755) blob ([a-f0-9]{40})\t([^\0]+)\0$/.exec(tree);
  if(!m||m[2]!==path)throw Error('UNSUPPORTED_GIT_OBJECT:'+path);
  return execFileSync('/usr/bin/git',['--no-replace-objects','-c','safe.directory='+repo,'-C',repo,'cat-file','blob',m[1]],{env,maxBuffer:1048576});
 };
 const baselineIdentity=git(baseline,'services/bug-hunt/src/identity.ts'),fixedIdentity=git(fixed,'services/bug-hunt/src/identity.ts');
 if(digest(baselineIdentity)!=='08e2eab15e1fd9db3a19268caeaf0622da8268d9f8b5296015e9313cb8ff559c'||fixedIdentity.toString('utf8')!==baselineIdentity.toString('utf8').replace('reviewer:body.user.role==="admin"','reviewer:body.user.role==="admin"||body.user.role==="creator"'))throw Error('UNSUPPORTED_REVIEWER_SOURCE');
 const lock=git(fixed,'package-lock.json'),baselineLock=git(baseline,'package-lock.json');
 for(const content of [lock,baselineLock])if(JSON.parse(content.toString('utf8')).packages?.['node_modules/typescript']?.version!==ts.version)throw Error('UNSUPPORTED_COMPILER_LOCK');
 // Resolve the installed compiler as Node does, including a shared dependency symlink.
 const compiler=await import('node:module').then(({createRequire})=>createRequire(import.meta.url).resolve('typescript'));
 const compilerSha=digest(await readFile(compiler));
 await mkdir(out,{mode:0o700});
 const sources=[{id:'bug-hunt',repository:repo,components:['bug-hunt'],commits:[baseline,fixed],paths:['services/bug-hunt/src/identity.ts','services/bug-hunt/schemas/messages.schema.json','services/bug-hunt/schemas/verification-v3.schema.json','services/bug-hunt/CONTRACT.md','services/bug-hunt/VERIFICATION.md','services/auth/ROLES.md'],externalAllowed:true}];
 const recipes:any[]=[],runnerRecipes:any[]=[],provenance:any[]=[];
 const harnesses=['reviewer-role.mjs','dto-contract.mjs'];
 for(const name of harnesses)await writeFile(join(out,name),git(fixed,'services/bug-hunt/recipes/'+name),{mode:0o400,flag:'wx'});
 const setup=async(commit:string,name:string,sourcePath:string,requirementPath:string,fixtureRef:string,fixture:unknown,harnessName:string,expected:string,claim:string,kind:'confirms_claim'|'refutes_claim',observation:Record<string,string>,build:boolean)=>{
  const root=join(out,name),source=git(commit,sourcePath),requirement=git(commit,requirementPath),fixtureText=JSON.stringify(fixture),fixtureDir=join(root,'fixtures');
  if(requirement.toString('utf8').split('\n').length>200)throw Error('UNSUPPORTED_REQUIREMENT_LENGTH');
  await mkdir(fixtureDir,{recursive:true,mode:0o700});
  const put=async(path:string,data:Buffer|string)=>{const target=join(root,path);await mkdir(posix.dirname(target),{recursive:true,mode:0o700});await writeFile(target,data,{mode:0o400,flag:'wx'});};
  const relative=sourcePath.slice('services/bug-hunt/'.length);await put(relative,source);await put('fixtures/'+fixtureRef+'.json',fixtureText);
  const files:Record<string,{source_sha256:string;compiled_sha256:string}>={};
  if(build){
   const todo=['identity.ts'],seen=new Set<string>();
   while(todo.length){const file=todo.pop()!;if(seen.has(file))continue;seen.add(file);
    if(!/^[a-z0-9-]+\.ts$/.test(file))throw Error('UNSUPPORTED_IMPORT:'+file);
    const text=(file==='identity.ts'?source:git(commit,'services/bug-hunt/src/'+file)).toString('utf8');
    if(file!=='identity.ts')await put('src/'+file,text);
    const output=ts.transpileModule(text,{fileName:file,compilerOptions:{target:ts.ScriptTarget.ES2023,module:ts.ModuleKind.ESNext}}).outputText;
    await put('build/'+file.replace(/\.ts$/,'.js'),output);files[file]={source_sha256:hash(text),compiled_sha256:hash(output)};
    for(const dep of ts.preProcessFile(text,true,true).importedFiles){if(dep.fileName.startsWith('.')){const next=posix.normalize(posix.join(posix.dirname(file),dep.fileName)).replace(/\.js$/,'.ts');todo.push(next);}}
   }
   await put('schemas/messages.schema.json',git(commit,'services/bug-hunt/schemas/messages.schema.json'));
   await put('package.json',JSON.stringify({type:'module'}));
  }
  const sourceHash=digest(source),requirementHash=digest(requirement),tree=await treeDigest(root),harness=join(out,harnessName),oracle={requirement_sha256:requirementHash,expected,version:'registry-oracle-v1',[kind]:claim};
  recipes.push({ref:name,recipe_id:build?'reviewer-role':'dto-contract',recipe_version:'1',source_id:'bug-hunt',source_commit:commit,source_sha256:sourceHash,source_tree_sha256:tree,source_path:sourcePath,requirement_path:requirementPath,requirement_sha256:requirementHash,expected,fixture_ref:fixtureRef,[kind]:claim,observation});
  runnerRecipes.push({id:build?'reviewer-role':'dto-contract',version:'1',harness,harness_sha256:digest(await readFile(harness)),source_root:root,source_file:relative,source_id:'bug-hunt',source_commit:commit,source_sha256:sourceHash,source_tree_sha256:tree,fixture_refs:[fixtureRef],fixture_sha256:{[fixtureRef]:hash(fixtureText)},oracle});
  provenance.push({ref:name,commit,source_path:sourcePath,source_sha256:sourceHash,requirement_path:requirementPath,requirement_sha256:requirementHash,compiler_version:build?ts.version:null,compiler_sha256:build?compilerSha:null,lock_sha256:digest(commit===baseline?baselineLock:lock),files});
 };
 const reviewerClaim='Creator cannot review bug reports';
 const obs={title:reviewerClaim,operation:'Open review as an active creator',expected:'reviewer',observed:'non-reviewer'};
 const fixture={now:0,expiresAt:'2999-01-01T00:00:00.000Z'};
 await setup(baseline,'reviewer-baseline','services/bug-hunt/src/identity.ts','services/auth/ROLES.md','creator-reviewer',fixture,'reviewer-role.mjs','reviewer',reviewerClaim,'confirms_claim',obs,true);
 await setup(fixed,'reviewer-fixed','services/bug-hunt/src/identity.ts','services/auth/ROLES.md','creator-reviewer',fixture,'reviewer-role.mjs','reviewer',reviewerClaim,'refutes_claim',obs,true);
 const v1='Report without a title is accepted';
 await setup(fixed,'dto-v1','services/bug-hunt/schemas/messages.schema.json','services/bug-hunt/CONTRACT.md','missing-title',{schema:'schemas/messages.schema.json',definition:'report',input:{request_id:'synthetic',observation:{operation:'operation',expected:'expected',observed:'observed'}}},'dto-contract.mjs','rejected',v1,'refutes_claim',{title:v1,operation:'Submit a report without a title',expected:'accepted',observed:'rejected'},false);
 const v3='A pending investigation target is rejected';
 await setup(fixed,'dto-v3','services/bug-hunt/schemas/verification-v3.schema.json','services/bug-hunt/VERIFICATION.md','pending-target',{schema:'schemas/verification-v3.schema.json',definition:'run-request',input:{request_id:'synthetic',target:{kind:'pending'}}},'dto-contract.mjs','accepted',v3,'refutes_claim',{title:v3,operation:'Submit a pending investigation target',expected:'rejected',observed:'accepted'},false);
 const result={sources,recipes,runnerRecipes,provenance};await writeFile(join(out,'registry.json'),JSON.stringify(result,null,2)+'\n',{mode:0o400,flag:'wx'});return result;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const args=process.argv.slice(2);if(args.length!==8||args.some((v,i)=>i%2===0&&!['--repo','--commit','--baseline-commit','--out'].includes(v))||new Set(args.filter((_,i)=>i%2===0)).size!==4)throw Error('INVALID_RECIPE_INPUT');
 const values=Object.fromEntries(args.filter((_,i)=>i%2===0).map((key,i)=>[key,args[i*2+1]]));
 await prepareRecipes(values['--repo'],values['--commit'],values['--baseline-commit'],values['--out']);
}
