// ABOUTME: Готовит каталог из двух синтетических Git commits с настоящим исходником Bug Hunt.
// ABOUTME: Проверяет compiled natsPrincipal и запрет неподдерживаемого отсутствующего объекта.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import {prepareRecipes} from '../dist/verification-recipes.js';
const project=resolve(import.meta.dirname,'../../..');
test('catalog compiles pinned baseline and corrected reviewer implementation',async()=>{
 const tmp=join(project,'tmp');await mkdir(tmp,{recursive:true});const root=await mkdtemp(join(tmp,'recipe-catalog-')),repo=join(root,'repo'),out=join(root,'out');await mkdir(repo);
 const git=(...args)=>execFileSync('/usr/bin/git',args,{cwd:repo,encoding:'utf8'}).trim();
 const paths=['package-lock.json','services/bug-hunt/src/identity.ts','services/bug-hunt/src/config.ts','services/bug-hunt/src/contracts.ts','services/bug-hunt/src/generations.ts','services/bug-hunt/src/processing.ts','services/bug-hunt/src/projection.ts','services/bug-hunt/src/verification.ts','services/bug-hunt/schemas/messages.schema.json','services/bug-hunt/schemas/verification-v3.schema.json','services/bug-hunt/CONTRACT.md','services/bug-hunt/VERIFICATION.md','services/auth/ROLES.md','services/bug-hunt/recipes/dto-contract.mjs'];
 const put=async(path,content)=>{await mkdir(resolve(repo,path,'..'),{recursive:true});await writeFile(join(repo,path),content);};
 try{
  git('init','-q');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
  for(const path of paths){let text=await readFile(join(project,path),'utf8');if(path==='services/bug-hunt/src/identity.ts')text=text.replace('reviewer:body.user.role==="admin"||body.user.role==="creator"','reviewer:body.user.role==="admin"');await put(path,text);}git('add','.');git('commit','-qm','baseline');const baseline=git('rev-parse','HEAD');
  await put('services/bug-hunt/src/identity.ts',await readFile(join(project,'services/bug-hunt/src/identity.ts')));
  await put('services/bug-hunt/recipes/reviewer-role.mjs',await readFile(join(project,'services/bug-hunt/recipes/reviewer-role.mjs')));
  git('add','.');git('commit','-qm','fixed');const fixed=git('rev-parse','HEAD');
  const result=await prepareRecipes(repo,fixed,baseline,out);assert.equal(result.recipes.length,4);
  for(const [name,expected] of [['reviewer-baseline',false],['reviewer-fixed',true]]){
   const {natsPrincipal}=await import(pathToFileURL(join(out,name,'build/identity.js')).href);
   const wire=async()=>({status:200,body:{user:{id:'synthetic',role:'creator',status:'active'},session:{userId:'synthetic',expiresAt:'2999-01-01T00:00:00Z'}}});
   assert.equal((await natsPrincipal(wire,{kind:'web',headers:{cookie:'synthetic'}})).reviewer,expected);
  }
  for(const [name,expected] of [['dto-v1',false],['dto-v3',true]]){
   const entry=result.runnerRecipes.find(r=>r.source_root.endsWith('/'+name));
   const fixture=JSON.parse(await readFile(join(entry.source_root,'fixtures',entry.fixture_refs[0]+'.json'),'utf8'));
   const schema=JSON.parse(await readFile(join(entry.source_root,fixture.schema),'utf8'));
   const ajv=new Ajv({strict:false});addFormats(ajv);ajv.addSchema(schema,'source');
   assert.equal(ajv.compile({$ref:'source#/definitions/'+fixture.definition})(fixture.input),expected);
  }
  await assert.rejects(prepareRecipes(repo,'a'.repeat(40),baseline,join(root,'missing')));
 }finally{await rm(root,{recursive:true,force:true});}
});
