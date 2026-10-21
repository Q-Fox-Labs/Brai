// ABOUTME: Проверяет реальное исполнение CI plan через локальные command и registry ports.
// ABOUTME: Каждый запуск работает в собственном Git fixture под tmp этого worktree.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {executePlan, recipeFiles, selectWork} from './pipeline.mjs';
import {execute} from '../components/cli.mjs';
import {discover, digestFiles, fingerprints} from '../components/graph.mjs';

const repoRoot=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const sha256=value=>createHash('sha256').update(value).digest('hex');

function fixture(t,{checkScript='export {};',mutateAfterCheck,build=false}={}) {
  const parent=join(repoRoot,'tmp/execution-test');mkdirSync(parent,{recursive:true});
  const root=mkdtempSync(join(parent,'fixture-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const put=(path,value)=>{const target=join(root,path);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,value);};
  for(const path of recipeFiles) {
    const target=join(root,path);mkdirSync(dirname(target),{recursive:true});cpSync(join(repoRoot,path),target);
  }
  put('services/probe/component.json',JSON.stringify({
    formatVersion:1,id:'probe',type:'program',status:'active',environments:['prod'],executableSources:build?[]:['services/probe/main.mjs'],
    inputs:{build:build?['services/probe/build.mjs']:[],runtime:build?[]:['services/probe/main.mjs'],checks:['services/probe/check.mjs']},dependencies:[],
    commands:{build:build?'node build.mjs':null,check:'node check.mjs'},
    delivery:{kind:'ready-files',files:build?['services/probe/dist']:['services/probe/main.mjs'],entrypoints:build?['services/probe/dist/main.mjs']:[],smokeImports:[],systemRequirements:[]},
    deploy:{units:[],migrations:[],health:null},npm:{workspaces:[]},
  }));
  if(build)put('services/probe/build.mjs',"import{mkdirSync,writeFileSync}from'node:fs';mkdirSync('dist',{recursive:true});writeFileSync('dist/main.mjs','export const value=1;\\n');\n");
  else put('services/probe/main.mjs','export const value=1;\n');
  put('services/probe/check.mjs',checkScript);
  const git=(...args)=>execFileSync('git',['-C',root,...args],{stdio:'pipe'});
  git('init','-q');git('add','.');
  git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture');
  const source=git('rev-parse','HEAD').toString().trim();
  return {root,put,source,mutateAfterCheck};
}

function makePlan(root,source,{artifactHit=false,checkHit=false,buildHit=false,artifact=null,check=null,build=null,variant='production'}={}) {
  const graph=discover(root,{allowMissingBuildOutputs:true}),component=graph.components.get(graph.order[0]);
  const recipe=digestFiles(root,recipeFiles),base=fingerprints(root,component,{variant});
  const keys={...base,artifact:sha256(base.artifact+recipe),checks:sha256(base.checks+recipe)};
  const items=[{id:component.id,keys,hasBuild:!!component.commands.build,hasCheck:true,hasNpm:false,artifactHit,checkHit,buildHit,artifact,check,build}];
  return {format:'brai-ci-plan-v1',source,recipe,target:variant==='development'?'dev':'prod',variant,items,sets:selectWork(items)};
}

function ports(root,{mutateAfterCheck,snapshotPayload}={}) {
  const actions=[],dockerActions=[],results=[];
  const commands=async(executable,args)=>{
    if(executable==='docker') {
      const action=args[0];dockerActions.push(action);
      if(action==='pull'||action==='rm')return {stdout:'',stderr:''};
      if(action==='create')return {stdout:'a'.repeat(64)+'\n',stderr:''};
      if(action==='cp') {
        if(!snapshotPayload)throw Error('BUILD_SNAPSHOT_FIXTURE_REQUIRED');
        const destination=args[2];mkdirSync(destination,{recursive:true});
        for(const name of readdirSync(snapshotPayload))cpSync(join(snapshotPayload,name),join(destination,name),{recursive:true});
        return {stdout:'',stderr:''};
      }
      throw Error(`UNEXPECTED_DOCKER_COMMAND: ${action}`);
    }
    const action=args[1],id=args[2];actions.push(action);
    const result=await execute(root,action,[id],{includeDependencies:false});
    results.push({action,result});
    if(action==='check')mutateAfterCheck?.();
    return result;
  };
  const publications=[];
  const registry={reference:(id,tag)=>`fake://${id}/${tag}`,async publish(id,tag,context,metadata) {
    const result={reference:`fake://${id}/${tag}`,digest:'sha256:'+sha256(`${id}:${tag}`),bytes:id==='release'?0:128,metadata};
    publications.push({id,tag,context,metadata,result});return result;
  }};
  return {actions,dockerActions,commands,publications,registry,results};
}

function config(source,runId='42') {return {repository:'owner/repo',source,runId,attempt:'1'};}

test('failed component check publishes no registry object',async t=>{
  const f=fixture(t,{checkScript:'process.exit(1);\n'}),p=makePlan(f.root,f.source),io=ports(f.root);
  await assert.rejects(executePlan(config(f.source),io.registry,p,{repositoryRoot:f.root,commands:io.commands}));
  assert.deepEqual(io.actions,['check']);assert.deepEqual(io.publications,[]);
});

test('cold execution checks and packages once; all-hit repeat runs no component commands',async t=>{
  const f=fixture(t),p=makePlan(f.root,f.source),first=ports(f.root);
  await executePlan(config(f.source),first.registry,p,{repositoryRoot:f.root,commands:first.commands});
  assert.deepEqual(first.actions,['check','package']);
  assert.equal(first.publications.filter(x=>x.tag.startsWith('input-')).length,1);
  assert.equal(first.publications.filter(x=>x.tag.startsWith('check-')).length,1);
  assert.equal(first.publications.filter(x=>x.id==='release').length,1);
  const artifact=first.publications.find(x=>x.tag.startsWith('input-')).result;
  const check=first.publications.find(x=>x.tag.startsWith('check-')).result;

  const reusedPlan=makePlan(f.root,f.source,{artifactHit:true,checkHit:true,artifact,check});
  const second=ports(f.root);
  await executePlan(config(f.source,'43'),second.registry,reusedPlan,{repositoryRoot:f.root,commands:second.commands});
  assert.deepEqual(second.actions,[]);
  assert.deepEqual(second.publications.map(x=>x.id),['release'],'a repeat may publish only the new composition');
});

test('build snapshot reuse restores its seal and packages without rebuilding',async t=>{
  const f=fixture(t,{build:true}),coldPlan=makePlan(f.root,f.source),cold=ports(f.root);
  assert.deepEqual(coldPlan.sets.build,['probe']);
  await executePlan(config(f.source),cold.registry,coldPlan,{repositoryRoot:f.root,commands:cold.commands});
  assert.deepEqual(cold.actions,['build','check','package']);
  assert.equal(cold.results.flatMap(x=>x.result).filter(x=>x.compiled).length,1);
  assert.equal(cold.results.flatMap(x=>x.result).filter(x=>x.packaged).length,1);
  const snapshot=cold.publications.find(x=>x.tag.startsWith('build-'));
  assert.ok(snapshot,'cold build publishes its generated output snapshot');
  const snapshotPayload=join(snapshot.context,'payload');
  assert.equal(readFileSync(join(snapshotPayload,'services/probe/dist/main.mjs'),'utf8'),'export const value=1;\n');
  const check=cold.publications.find(x=>x.tag.startsWith('check-')).result;

  rmSync(join(f.root,'services/probe/dist'),{recursive:true,force:true});
  rmSync(join(f.root,'tmp/component-state/probe.json'),{force:true});
  const reusedPlan=makePlan(f.root,f.source,{buildHit:true,checkHit:true,check,build:snapshot.result});
  assert.deepEqual(reusedPlan.sets.build,[],'a build hit is excluded from build work');
  assert.deepEqual(reusedPlan.sets.package,['probe'],'runtime miss still packages the component');
  assert.deepEqual(reusedPlan.sets.check,[]);
  const restored=ports(f.root,{snapshotPayload});
  await executePlan(config(f.source,'44'),restored.registry,reusedPlan,{repositoryRoot:f.root,commands:restored.commands});
  assert.deepEqual(restored.dockerActions,['pull','create','cp','rm']);
  assert.deepEqual(restored.actions,['package'],'restored build output passes its receipt without rebuilding');
  assert.equal(restored.results.flatMap(x=>x.result).filter(x=>x.compiled).length,0);
  assert.equal(restored.results.flatMap(x=>x.result).filter(x=>x.packaged).length,1);
  assert.equal(readFileSync(join(f.root,'services/probe/dist/main.mjs'),'utf8'),'export const value=1;\n');
  assert.equal(restored.publications.filter(x=>x.tag.startsWith('build-')).length,0);
  assert.equal(restored.publications.filter(x=>x.tag.startsWith('input-')).length,1);
  const runtimeContext=restored.publications.find(x=>x.tag.startsWith('input-')).context;
  assert.equal(readFileSync(join(runtimeContext,'payload/services/probe/dist/main.mjs'),'utf8'),'export const value=1;\n');
});

test('CI refuses a lost receipt before check or package instead of implicitly compiling again',async t=>{
  for(const loseAfter of ['build','check'])await t.test(loseAfter,async t=>{
    const f=fixture(t,{build:true});
    f.put('services/probe/build.mjs',"import{mkdirSync,writeFileSync,appendFileSync}from'node:fs';mkdirSync('dist',{recursive:true});writeFileSync('dist/main.mjs','export const value=1;\\n');appendFileSync('compile-count','1');\n");
    const p=makePlan(f.root,f.source),io=ports(f.root);
    const commands=async(executable,args,options)=>{
      const result=await io.commands(executable,args,options);
      if(args[1]===loseAfter)rmSync(join(f.root,'tmp/component-state/probe.json'));
      return result;
    };
    await assert.rejects(executePlan(config(f.source),io.registry,p,{repositoryRoot:f.root,commands}),/ENOENT/);
    assert.deepEqual(io.actions,loseAfter==='build'?['build']:['build','check']);
    assert.equal(readFileSync(join(f.root,'services/probe/compile-count'),'utf8'),'1');
    assert.equal(io.results.flatMap(x=>x.result).filter(x=>x.compiled).length,1);
    assert.equal(io.results.flatMap(x=>x.result).filter(x=>x.packaged).length,0);
    assert.deepEqual(io.publications,[]);
  });
});

test('source changes made by a check reject the plan before publication',async t=>{
  const f=fixture(t),mutateAfterCheck=()=>f.put('services/probe/main.mjs','export const value=2;\n');
  const p=makePlan(f.root,f.source),io=ports(f.root,{mutateAfterCheck});
  await assert.rejects(executePlan(config(f.source),io.registry,p,{repositoryRoot:f.root,commands:io.commands}),/CHECK_CHANGED_SOURCE: probe/);
  assert.deepEqual(io.publications,[]);
});

test('recipe changes made by a check reject the plan before publication',async t=>{
  const f=fixture(t),mutateAfterCheck=()=>f.put('.github/workflows/codeworks.yml','name: changed\n');
  const p=makePlan(f.root,f.source),io=ports(f.root,{mutateAfterCheck});
  await assert.rejects(executePlan(config(f.source),io.registry,p,{repositoryRoot:f.root,commands:io.commands}),/CHECK_CHANGED_RECIPE/);
  assert.deepEqual(io.publications,[]);
});


test('DEV web output receipt uses the effective planned variant for final verification',async t=>{
  const f=fixture(t,{build:true}),path=join(f.root,'services/probe/component.json');
  const descriptor=JSON.parse(readFileSync(path,'utf8'));descriptor.id='web';f.put('services/probe/component.json',JSON.stringify(descriptor));
  const plan=makePlan(f.root,f.source,{variant:'development'}),io=ports(f.root);
  const commands=async(executable,args,options)=>{
    const before=process.env.BRAI_WEB_VARIANT;process.env.BRAI_WEB_VARIANT=options.env.BRAI_WEB_VARIANT;
    try{return await io.commands(executable,args,options);}finally{if(before===undefined)delete process.env.BRAI_WEB_VARIANT;else process.env.BRAI_WEB_VARIANT=before;}
  };
  await executePlan(config(f.source),io.registry,plan,{repositoryRoot:f.root,commands});
  assert.deepEqual(io.actions,['build','check','package']);
  const production=fingerprints(f.root,discover(f.root).components.get('web'),{variant:'production'});
  assert.notEqual(plan.items[0].keys.build,production.build);
});

test('standalone image smoke failure occurs before any registry publication',async t=>{
  const f=fixture(t),descriptor=JSON.parse(readFileSync(join(f.root,'services/probe/component.json'),'utf8'));
  descriptor.type='container';descriptor.delivery.kind='oci-context';descriptor.delivery.entrypoints=['services/probe/main.mjs'];f.put('services/probe/component.json',JSON.stringify(descriptor));
  const plan=makePlan(f.root,f.source),io=ports(f.root),docker=[];
  const commands=async(executable,args,options)=>{
    if(executable!=='docker')return io.commands(executable,args,options);
    docker.push(args[0]);if(args[0]==='run')throw Error('STANDALONE_SMOKE_FAILED');
    return {stdout:'',stderr:''};
  };
  await assert.rejects(executePlan(config(f.source),io.registry,plan,{repositoryRoot:f.root,commands}),/STANDALONE_SMOKE_FAILED/);
  assert.deepEqual(docker,['buildx','run']);assert.deepEqual(io.publications,[]);
});
