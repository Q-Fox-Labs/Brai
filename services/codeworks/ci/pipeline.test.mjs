// ABOUTME: Проверяет чистые решения CI-планировщика и устойчивость content keys.
// ABOUTME: Fixtures изолированы в tmp worktree и не обращаются к GitHub или registry.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {bounded, reusable, selectWork, buildSnapshotTag} from './pipeline.mjs';
import {fingerprints} from '../components/graph.mjs';
import {lockInputs} from '../components/lock-inputs.mjs';

const repoRoot=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
test('build discovery separates accepted CI recipes without changing the sealed receipt key',()=>{
  const key='a'.repeat(64),first=buildSnapshotTag(key,'b'.repeat(64));
  assert.match(first,/^build-[0-9a-f]{64}$/);
  assert.equal(first,buildSnapshotTag(key,'b'.repeat(64)));
  assert.notEqual(first,buildSnapshotTag(key,'c'.repeat(64)));
});
function fixture(t) {
  const parent=join(repoRoot,'tmp/pipeline-test');mkdirSync(parent,{recursive:true});
  const root=mkdtempSync(join(parent,'fixture-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const put=(path,value)=>{const target=join(root,path);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,value);};
  const pkg={name:'@brai/probe',version:'1.0.0',dependencies:{'parent-pkg':'1.0.0'}};
  put('services/probe/package.json',JSON.stringify(pkg));
  put('services/probe/main.mjs','export const value=1;\n');
  put('services/probe/check.mjs','export const check=1;\n');
  put('services/codeworks/ci/toolchain.json',JSON.stringify({node:'24.21.0',npm:'11.19.0',nodeBase:'node:24.21.0-bookworm-slim'}));
  put('package-lock.json',JSON.stringify({lockfileVersion:3,packages:{
    'services/probe':{name:pkg.name,version:pkg.version,dependencies:pkg.dependencies},
    'node_modules/parent-pkg':{version:'1.0.0',dependencies:{'child-pkg':'1.0.0'}},
    'node_modules/child-pkg':{version:'1.0.0'},
    'node_modules/unrelated-pkg':{version:'1.0.0'},
  }}));
  const component={
    id:'probe',formatVersion:1,commands:{build:'node build.mjs',check:'node check.mjs'},
    inputs:{build:['services/probe/main.mjs'],runtime:['services/probe/main.mjs'],checks:['services/probe/check.mjs']},
    dependencies:[],npm:{workspaces:['services/probe']},
    delivery:{kind:'files',files:['services/probe/main.mjs'],entrypoints:[],systemRequirements:[]},
  };
  return {root,put,component};
}

test('lock closure ignores unrelated entries and changes keys for selected transitive inputs',t=>{
  const {root,put,component}=fixture(t),before=fingerprints(root,component);
  const selected=lockInputs(root,component.npm.workspaces);
  assert.deepEqual(selected.map(x=>x.key),['node_modules/child-pkg','node_modules/parent-pkg','services/probe']);

  put('package-lock.json',JSON.stringify({lockfileVersion:3,packages:{
    'services/probe':{name:'@brai/probe',version:'1.0.0',dependencies:{'parent-pkg':'1.0.0'}},
    'node_modules/parent-pkg':{version:'1.0.0',dependencies:{'child-pkg':'1.0.0'}},
    'node_modules/child-pkg':{version:'1.0.0'},'node_modules/unrelated-pkg':{version:'9.9.9'},
  }}));
  const unrelated=fingerprints(root,component);
  assert.deepEqual(unrelated,before,'unselected package-lock entries must not affect any key');

  put('package-lock.json',JSON.stringify({lockfileVersion:3,packages:{
    'services/probe':{name:'@brai/probe',version:'1.0.0',dependencies:{'parent-pkg':'1.0.0'}},
    'node_modules/parent-pkg':{version:'1.0.0',dependencies:{'child-pkg':'1.0.0'}},
    'node_modules/child-pkg':{version:'2.0.0'},'node_modules/unrelated-pkg':{version:'9.9.9'},
  }}));
  const transitive=fingerprints(root,component);
  assert.notEqual(transitive.build,unrelated.build);
  assert.notEqual(transitive.runtime,unrelated.runtime);
  assert.notEqual(transitive.checks,unrelated.checks);
});

test('check-only source changes do not invalidate build or runtime, while variant and platform are scoped',t=>{
  const {root,put,component}=fixture(t),before=fingerprints(root,component);
  put('services/probe/check.mjs','export const check=2;\n');
  const checked=fingerprints(root,component);
  assert.equal(checked.build,before.build);assert.equal(checked.runtime,before.runtime);
  assert.notEqual(checked.checks,before.checks);

  const dev=fingerprints(root,component,{variant:'development'});
  const prod=fingerprints(root,component,{variant:'production'});
  assert.deepEqual(dev,prod,'non-web components do not use the web variant');
  const web={...component,id:'web'};
  const webDev=fingerprints(root,web,{variant:'development'});
  const webProd=fingerprints(root,web,{variant:'production'});
  assert.notEqual(webDev.build,webProd.build);assert.notEqual(webDev.runtime,webProd.runtime);assert.notEqual(webDev.checks,webProd.checks);
  const otherPlatform=fingerprints(root,web,{variant:'development',platform:'linux/arm64'});
  assert.notEqual(webDev.build,otherPlatform.build);assert.notEqual(webDev.runtime,otherPlatform.runtime);assert.notEqual(webDev.checks,otherPlatform.checks);
});

test('lock closure rejects absent, unsupported, mismatched, and unresolved lock data',t=>{
  const {root,put,component}=fixture(t);
  rmSync(join(root,'package-lock.json'));
  assert.throws(()=>fingerprints(root,component));
  put('package-lock.json',JSON.stringify({lockfileVersion:1,dependencies:{}}));
  assert.throws(()=>lockInputs(root,component.npm.workspaces),/UNSUPPORTED_PACKAGE_LOCK/);
  put('package-lock.json',JSON.stringify({lockfileVersion:3,packages:{}}));
  assert.throws(()=>lockInputs(root,component.npm.workspaces),/LOCK_WORKSPACE_ENTRY_MISSING/);
  put('package-lock.json',JSON.stringify({lockfileVersion:3,packages:{
    'services/probe':{name:'@brai/probe',version:'1.0.0',dependencies:{'parent-pkg':'1.0.0'}},
  }}));
  assert.throws(()=>lockInputs(root,component.npm.workspaces),/LOCK_ENTRY_MISSING/);
});

test('selectWork separates complete artifact reuse from a check-only miss',()=>{
  const reused=selectWork([{id:'done',artifactHit:true,checkHit:true,hasBuild:true,hasCheck:true,hasNpm:true}]);
  assert.deepEqual(reused,{build:[],check:[],package:[],reuse:['done'],needsDependencies:false});
  const checkOnly=selectWork([{id:'cached-artifact',artifactHit:true,checkHit:false,hasBuild:true,hasCheck:true,hasNpm:true}]);
  assert.deepEqual(checkOnly,{build:[],check:['cached-artifact'],package:[],reuse:['cached-artifact'],needsDependencies:true});
});

test('bounded runs at most two tasks and starts no queued work after a failure',async()=>{
  const started=[],active={count:0,max:0};let releaseFirst;
  const first=new Promise(resolveFirst=>{releaseFirst=resolveFirst;});
  const run=bounded([0,1,2,3],async item=>{
    started.push(item);active.count++;active.max=Math.max(active.max,active.count);
    try{if(item===0)await first;if(item===1)throw Error('worker failed');return item;}
    finally{active.count--;}
  },2);
  await new Promise(resolveTick=>setImmediate(resolveTick));
  releaseFirst();
  await assert.rejects(run,/worker failed/);
  assert.deepEqual(started,[0,1]);assert.equal(active.max,2);
});

test('reusable accepts only a successful matching run identity',async()=>{
  const repository='owner/repo',metadata={format:'brai-ci-object-v1',repository,key:'a'.repeat(64),kind:'runtime',recipe:'b'.repeat(64),runId:'123',attempt:'2',source:'c'.repeat(40)};
  const digest='sha256:'+'d'.repeat(64),hit={metadata,digest},expected={id:'probe',key:metadata.key,kind:metadata.kind,recipe:metadata.recipe};
  const valid={repository:{full_name:repository},head_sha:metadata.source,path:'.github/workflows/codeworks.yml',event:'push',status:'completed',conclusion:'success',run_attempt:2};
  const proof={composition:{components:[{id:'probe',keys:{artifact:metadata.key,checks:metadata.key},artifact:{digest},check:{digest}}]}};
  const readRecipe=async(source,recipe)=>{assert.equal(source,metadata.source);assert.equal(recipe,expected.recipe);return true;};
  const readOriginProof=async(runId,attempt,source)=>{assert.equal(runId,metadata.runId);assert.equal(attempt,metadata.attempt);assert.equal(source,metadata.source);return proof;};
  const validOptions={repository,readRun:async()=>valid,readRecipe,readOriginProof};
  assert.equal(await reusable(hit,expected,validOptions),true);
  assert.equal(await reusable(hit,expected,{...validOptions,readRecipe:async()=>false}),false,'changed recipe inputs make the object non-reusable');
  const wrongProof={composition:{components:[{...proof.composition.components[0],artifact:{digest:'sha256:'+'e'.repeat(64)}}]}};
  assert.equal(await reusable(hit,expected,{...validOptions,readOriginProof:async()=>wrongProof}),false,'label digest must match the artifact recorded by its origin run');
  for(const [label,change] of [
    ['repository',doc=>doc.repository.full_name='other/repo'],
    ['head',doc=>doc.head_sha='d'.repeat(40)],
    ['workflow',doc=>doc.path='.github/workflows/other.yml'],
    ['run attempt',doc=>doc.run_attempt=1],
    ['conclusion',doc=>doc.conclusion='failure'],
    ['status',doc=>doc.status='in_progress'],
  ]) {
    const doc=structuredClone(valid);change(doc);
    assert.equal(await reusable(hit,expected,{...validOptions,readRun:async()=>doc}),false,label);
  }
  await assert.rejects(reusable(hit,expected,{...validOptions,repository:'other/repo'}),/REUSE_IDENTITY_MISMATCH/);
  for(const mutate of [m=>m.runId='not-a-number',m=>m.source='bad',m=>m.key='wrong']) {
    const malformed={metadata:{...metadata}};mutate(malformed.metadata);
    await assert.rejects(reusable(malformed,expected,validOptions),/REUSE_IDENTITY_MISMATCH/);
  }
  const zeroAttempt={metadata:{...metadata,attempt:'0'}};
  assert.equal(await reusable(zeroAttempt,expected,validOptions),false);
});
