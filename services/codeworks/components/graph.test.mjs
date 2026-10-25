// ABOUTME: Acceptance fixtures exercise discovery, graph, lifecycle and separate build/check identities.
// ABOUTME: Изолированные Git fixtures не читают live-данные основной копии.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, rmSync, chmodSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { discover, fingerprints, sourceFiles } from './graph.mjs';
import { execute } from './cli.mjs';
const repository=resolve(import.meta.dirname,'../../..');
function put(root,path,text) {mkdirSync(dirname(join(root,path)),{recursive:true});writeFileSync(join(root,path),text);}
function descriptor(id) {
 const dir='services/'+id;
 return {formatVersion:1,id,type:'program',status:'active',environments:['dev','prod'],executableSources:[dir+'/main.mjs'],inputs:{build:[dir+'/build.mjs'],runtime:[dir+'/main.mjs'],checks:[dir+'/tests.mjs']},dependencies:[],commands:{build:'node build.mjs',check:'node tests.mjs'},delivery:{kind:'ready-files',files:[dir+'/main.mjs'],entrypoints:[dir+'/main.mjs'],smokeImports:[],systemRequirements:['node:24.22.1']},deploy:{units:[id],migrations:[],health:null},npm:{workspaces:[]}};
}
function fixture(t) {
 mkdirSync(join(repository,'tmp'),{recursive:true});
 const root=mkdtempSync(join(repository,'tmp','component-fixture-'));
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 execFileSync('git',['init','-q',root],{stdio:'pipe'});
 put(root,'services/codeworks/schemas/component.schema.json',readFileSync(join(repository,'services/codeworks/schemas/component.schema.json')));
 return root;
}
function add(root,id,edit=()=>{}) {
 const d=descriptor(id);edit(d);
 put(root,'services/'+id+'/component.json',JSON.stringify(d));
 put(root,'.gitignore', '/docs/user-agent/usercustom/\n');
 put(root,'AGENTS.md','[Docs](docs/README.md)');
 put(root,'docs/README.md','[Components](components/README.md) [Environment](environment/README.md) [Agent](user-agent/README.md)');
 put(root,'docs/environment/README.md','# Environment');
 put(root,'docs/user-agent/README.md','# Agent');
 const previous=(()=>{try{return readFileSync(join(root,'docs/components/README.md'),'utf8');}catch{return '# Components\n';}})();
 put(root,'docs/components/README.md',previous+'\n['+id+']('+id+'.md)');
 put(root,'docs/components/'+id+'.md','retired when applicable: [Technical](../../services/'+id+'/README.md)');
 put(root,'services/'+id+'/README.md','# Technical');

 put(root,'services/'+id+'/main.mjs','export const value=1;\n');
 put(root,'services/'+id+'/build.mjs',"import{appendFileSync}from'node:fs';appendFileSync('build-count','1');\n");
 put(root,'services/'+id+'/tests.mjs',"import assert from 'node:assert/strict';assert.equal(1,1);\n");return d;
}
function save(root,id,d){put(root,'services/'+id+'/component.json',JSON.stringify(d));}
test('Git source boundary excludes unreadable ignored live directories and keeps tracked and new executable gates',t=>{
 const root=fixture(t);add(root,'probe');
 put(root,'.gitignore','.private-live/\nservices/probe/generated/\n');
 put(root,'.private-live/main.py','#!/usr/bin/env python3\n');
 put(root,'services/probe/generated/main.mjs','throw Error("live data");');
 for(const path of ['.private-live','services/probe/generated']) {
  chmodSync(join(root,path),0o000);
 }
 try {
  assert.deepEqual(discover(root).order,['probe']);
  assert.ok(!sourceFiles(root).some(path=>path.includes('private-live')||path.includes('generated')));
  put(root,'tools/new-worker.py','#!/usr/bin/env python3\nprint(42)\n');chmodSync(join(root,'tools/new-worker.py'),0o755);
  assert.throws(()=>discover(root),/MISSING_EXECUTABLE/);
  execFileSync('git',['-C',root,'add','tools/new-worker.py']);
  put(root,'.gitignore','tools/\n.private-live/\nservices/probe/generated/\n');
  assert.throws(()=>discover(root),/MISSING_EXECUTABLE/);
  rmSync(join(root,'tools'),{recursive:true});
  assert.deepEqual(discover(root).order,['probe']);
 } finally {for(const path of ['.private-live','services/probe/generated'])chmodSync(join(root,path),0o700);}
});
test('new described component enters pipeline without workflow editing; build once across build/check/package',async t=>{
 const root=fixture(t);add(root,'probe');
 assert.deepEqual(discover(root).order,['probe']);
 await execute(root,'build',['probe']);await execute(root,'check',['probe']);
 const result=await execute(root,'package',['probe']);
 assert.equal(readFileSync(join(root,'services/probe/build-count'),'utf8'),'1');
 assert.ok(result[0].artifact.payloadHash);assert.equal(result[0].compiled,false);
 put(root,'services/probe/tests.mjs','// changed tests only\n');
 const second=await execute(root,'package',['probe']);assert.equal(second[0].artifact.payloadHash,result[0].artifact.payloadHash);assert.equal(second[0].compiled,false);assert.equal(second[0].packaged,false);
 put(result[0].artifact.path,'services/probe/main.mjs','export const value=9;');await assert.rejects(execute(root,'package',['probe']),/IMMUTABLE_OUTPUT_MISMATCH/);
});
test('strict schema, missing npm owner and missing executable are rejected',t=>{
 const root=fixture(t),d=add(root,'probe');d.typo=true;save(root,'probe',d);
 assert.throws(()=>discover(root),/COMPONENT_SCHEMA/);delete d.typo;save(root,'probe',d);
 put(root,'services/new/package.json','{}');assert.throws(()=>discover(root),/MISSING_COMPONENT/);
 rmSync(join(root,'services/new'),{recursive:true});put(root,'services/probe/sub/main.mjs','export{};');assert.throws(()=>discover(root),/MISSING_EXECUTABLE/);
 rmSync(join(root,'services/probe/sub'),{recursive:true});put(root,'services/probe/package.json',JSON.stringify({scripts:{start:'node extra.mjs'}}));assert.throws(()=>discover(root),/UNDECLARED_EXECUTABLE_SCRIPT/);
});
test('unknown dependencies and cycles are rejected',t=>{
 const root=fixture(t),a=add(root,'a',d=>d.dependencies=[{id:'missing',inputs:[],delivery:[]}]);
 assert.throws(()=>discover(root),/UNKNOWN_DEPENDENCY/);
 const b=add(root,'b',d=>d.dependencies=[{id:'a',inputs:[],delivery:[]}]);
 a.dependencies[0].id='b';save(root,'a',a);assert.throws(()=>discover(root),/COMPONENT_CYCLE/);
});
test('literal neighbor imports require declared exact build input',t=>{
 const root=fixture(t),a=add(root,'a');add(root,'b');
 put(root,'services/a/main.mjs',"import{value}from'../b/main.mjs';export{value};\n");
 assert.throws(()=>discover(root),/UNDECLARED_IMPORT/);
 a.dependencies=[{id:'b',inputs:['services/b/main.mjs'],delivery:['services/b/main.mjs']}];save(root,'a',a);
 assert.deepEqual(discover(root).order,['b','a']);
});
test('shared contract touches consumer while test-only edits preserve build/runtime fingerprint',t=>{
 const root=fixture(t);add(root,'b');const a=add(root,'a',d=>d.dependencies=[{id:'b',inputs:['services/b/contract.json'],delivery:['services/b/contract.json']}]);put(root,'services/b/contract.json','{}');
 let before=fingerprints(root,a);put(root,'services/a/tests.mjs','// changed test\n');let after=fingerprints(root,a);
 assert.equal(before.build,after.build);assert.equal(before.runtime,after.runtime);assert.notEqual(before.checks,after.checks);
 put(root,'services/b/contract.json','{"revision":2}');const changed=fingerprints(root,a);assert.notEqual(changed.build,after.build);assert.notEqual(changed.runtime,after.runtime);
});
test('removal requires retirement; rename retains explicit tombstone and prevents ID reuse',t=>{
 const root=fixture(t),a=add(root,'a');
 const git=(...args)=>execFileSync('git',['-C',root,...args],{stdio:'pipe'});
 git('init','-q');git('add','.');git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture');
 a.deploy.units=[];save(root,'a',a);assert.throws(()=>discover(root,{base:'HEAD'}),/DEPLOY_UNIT_REMOVED_WITHOUT_RETIREMENT/);a.deploy.units=['a'];
 rmSync(join(root,'services/a'),{recursive:true});assert.throws(()=>discover(root,{base:'HEAD'}),/REMOVED_WITHOUT_RETIREMENT/);
 a.status='retired';a.reason='Replaced explicitly';a.renamedTo='b';a.inputs={build:[],runtime:[],checks:[]};a.executableSources=[];save(root,'a',a);add(root,'b');assert.deepEqual(discover(root,{base:'HEAD'}).order,['b']);
 a.renamedTo='unknown';save(root,'a',a);assert.throws(()=>discover(root,{base:'HEAD'}),/INVALID_RENAME/);
 a.renamedTo='b';save(root,'a',a);git('add','.');git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','retire');a.status='active';delete a.renamedTo;save(root,'a',a);assert.throws(()=>discover(root,{base:'HEAD'}),/RETIRED_ID_REUSED/);
});

test('removing one active deploy unit requires its explicit retired tombstone',t=>{
 const root=fixture(t),active=add(root,'probe',d=>d.deploy.units=['probe','old-worker']);
 const git=(...args)=>execFileSync('git',['-C',root,...args],{stdio:'pipe'});
 git('add','.');git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture');
 active.deploy.units=['probe'];save(root,'probe',active);
 assert.throws(()=>discover(root,{base:'HEAD'}),/DEPLOY_UNIT_REMOVED_WITHOUT_RETIREMENT: probe/);
 const retired={...descriptor('old-worker'),status:'retired',reason:'Worker retired explicitly',executableSources:[],inputs:{build:[],runtime:[],checks:[]},commands:{build:null,check:null},delivery:{kind:'ready-files',files:[],entrypoints:[],smokeImports:[],systemRequirements:[]}};
 save(root,'old-worker',retired);
 const graph=discover(root,{base:'HEAD'});
 assert.deepEqual(graph.order,['probe']);assert.equal(graph.components.get('old-worker').status,'retired');
 assert.deepEqual(graph.components.get('old-worker').deploy.units,['old-worker']);
 retired.deploy.units=['different-worker'];save(root,'old-worker',retired);
 assert.throws(()=>discover(root,{base:'HEAD'}),/DEPLOY_UNIT_REMOVED_WITHOUT_RETIREMENT: probe/);
});
test('retired package metadata admits development scripts but rejects runtime scripts and bins',t=>{
 const root=fixture(t),retired={...descriptor('probe'),status:'retired',reason:'Runtime removed',executableSources:[],inputs:{build:[],runtime:[],checks:[]},commands:{build:null,check:null},delivery:{kind:'ready-files',files:[],entrypoints:[],smokeImports:[],systemRequirements:[]}};
 save(root,'probe',retired);
 const metadata={name:'@fixture/probe',private:true,scripts:{test:'node --test',lint:'node tools/lint.mjs'}};
 put(root,'services/probe/package.json',JSON.stringify(metadata));
 assert.deepEqual(discover(root).order,[]);
 for(const runtime of [
  {bin:'worker.mjs'},{bin:{worker:'worker.mjs'}},
  ...['start','start:worker','mcp','migrate','health','trusted'].map(name=>({scripts:{[name]:'node worker.mjs'}})),
 ]){
  put(root,'services/probe/package.json',JSON.stringify({...metadata,...runtime}));
  assert.throws(()=>discover(root),/MISSING_COMPONENT: services\/probe\/package.json/);
 }
 put(root,'services/probe/package.json',JSON.stringify(metadata));
 rmSync(join(root,'services/probe/component.json'));
 assert.throws(()=>discover(root),/MISSING_COMPONENT: services\/probe\/package.json/);
});

// These are executable behavior regressions: assert delivered bytes, not only key inequality.
test('build config and effective dependency delivery cannot reuse stale payload',async t=>{
 const root=fixture(t);
 const d=add(root,'probe',d=>{
  d.inputs.build.push('services/probe/config.json');
  d.delivery.files=['services/probe/dist'];d.delivery.entrypoints=['services/probe/dist/main.mjs'];
 });
 put(root,'services/probe/config.json','{"value":1}');
 put(root,'services/probe/build.mjs',"import{mkdirSync,readFileSync,writeFileSync,appendFileSync}from'node:fs';mkdirSync('dist',{recursive:true});writeFileSync('dist/main.mjs','export const value='+JSON.parse(readFileSync('config.json')).value+';');appendFileSync('build-count','1');");
 const first=(await execute(root,'package',['probe']))[0];
 put(root,'services/probe/config.json','{"value":2}');
 const second=(await execute(root,'package',['probe']))[0];
 assert.equal(second.compiled,true);assert.equal(second.packaged,true);
 assert.notEqual(first.artifact.payloadHash,second.artifact.payloadHash);
 assert.equal(readFileSync(join(second.artifact.path,'services/probe/dist/main.mjs'),'utf8'),'export const value=2;');
 add(root,'neighbor');put(root,'services/neighbor/extra.json','{"revision":1}');
 // AIDEV-NOTE: Явный исходный mode сохраняет проверку смены прав при umask 0077.
 chmodSync(join(root,'services/neighbor/extra.json'),0o644);
 d.dependencies=[{id:'neighbor',inputs:[],delivery:[]}];save(root,'probe',d);
 const before=(await execute(root,'package',['probe'])).find(x=>x.id==='probe');
 d.dependencies[0].delivery=['services/neighbor/extra.json'];save(root,'probe',d);
 const added=(await execute(root,'package',['probe'])).find(x=>x.id==='probe');
 assert.notEqual(before.runtime,added.runtime);assert.equal(added.packaged,true);
 assert.equal(readFileSync(join(added.artifact.path,'services/neighbor/extra.json'),'utf8'),'{"revision":1}');
 put(root,'services/neighbor/extra.json','{"revision":2}');
 const changed=(await execute(root,'package',['probe'])).find(x=>x.id==='probe');
 assert.equal(changed.compiled,false);assert.equal(changed.packaged,true);
 assert.equal(readFileSync(join(changed.artifact.path,'services/neighbor/extra.json'),'utf8'),'{"revision":2}');
 const repeat=(await execute(root,'package',['probe'])).find(x=>x.id==='probe');assert.equal(repeat.packaged,false);
 chmodSync(join(root,'services/neighbor/extra.json'),0o600);
 const modeChanged=(await execute(root,'package',['probe'])).find(x=>x.id==='probe');assert.equal(modeChanged.packaged,true);assert.notEqual(modeChanged.artifact.payloadHash,repeat.artifact.payloadHash);
});
test('executable admission covers package bins, runtime flags and executable shebang files',t=>{
 const root=fixture(t),d=add(root,'probe');put(root,'services/probe/extra.mjs','export {};');
 for(const manifest of [
  {bin:{probe:'extra.mjs'}},{bin:'extra.mjs'},
  {scripts:{start:'node --enable-source-maps "extra.mjs"'}},
  {scripts:{'start:worker':"node --require init.cjs --conditions=production extra.mjs"}},
  {scripts:{start:'python3 -B helper.py'}},
 ]){put(root,'services/probe/package.json',JSON.stringify(manifest));assert.throws(()=>discover(root),/UNDECLARED_EXECUTABLE_(BIN|SCRIPT)/);}
 rmSync(join(root,'services/probe/package.json'));
 put(root,'tools/package.json',JSON.stringify({bin:{worker:'worker.py'}}));assert.throws(()=>discover(root),/MISSING_COMPONENT/);rmSync(join(root,'tools'),{recursive:true});
 put(root,'tools/arbitrary-name.py','#!/usr/bin/env python3\nprint(42)\n');chmodSync(join(root,'tools/arbitrary-name.py'),0o755);
 assert.throws(()=>discover(root),/MISSING_EXECUTABLE/);rmSync(join(root,'tools'),{recursive:true});
 put(root,'services/probe/helper.py','#!/usr/bin/env python3\nprint(42)\n');chmodSync(join(root,'services/probe/helper.py'),0o755);
 assert.throws(()=>discover(root),/MISSING_EXECUTABLE/);
 d.executableSources.push('services/probe/helper.py');d.inputs.runtime.push('services/probe/helper.py');save(root,'probe',d);assert.deepEqual(discover(root).order,['probe']);
});
test('validation rejects missing own and dependency delivery files before execution',t=>{
 const root=fixture(t),d=add(root,'probe');d.delivery.files.push('services/probe/missing.json');save(root,'probe',d);
 assert.throws(()=>discover(root),/DELIVERY_NOT_FOUND/);d.delivery.files.pop();add(root,'neighbor');
 d.dependencies=[{id:'neighbor',inputs:[],delivery:['services/neighbor/missing.json']}];save(root,'probe',d);
 assert.throws(()=>discover(root),/DELIVERY_NOT_FOUND/);
});
test('generated output corruption is rejected until explicit build restores source bytes; legacy is not adopted',async t=>{
 const root=fixture(t);add(root,'probe',d=>{d.delivery.files=['services/probe/dist'];d.delivery.entrypoints=['services/probe/dist/main.mjs'];});
 put(root,'services/probe/build.mjs',"import{mkdirSync,copyFileSync,appendFileSync}from'node:fs';mkdirSync('dist',{recursive:true});copyFileSync('main.mjs','dist/main.mjs');appendFileSync('build-count','1');");
 const first=(await execute(root,'package',['probe']))[0],statePath=join(root,'tmp/component-state/probe.json');
 const trusted=readFileSync(statePath,'utf8');
 put(root,'services/probe/dist/main.mjs','export const value=999;');
 await assert.rejects(execute(root,'package',['probe']),/BUILD_OUTPUT_MISMATCH/);
 assert.equal(readFileSync(statePath,'utf8'),trusted);assert.equal(readFileSync(join(root,'services/probe/build-count'),'utf8'),'1');
 assert.equal(readFileSync(join(first.artifact.path,'services/probe/dist/main.mjs'),'utf8'),'export const value=1;\n');
 const restored=(await execute(root,'build',['probe']))[0];assert.equal(restored.compiled,true);assert.equal(restored.build,first.build);
 assert.equal(readFileSync(join(root,'services/probe/dist/main.mjs'),'utf8'),'export const value=1;\n');
 const repeated=(await execute(root,'package',['probe']))[0];assert.equal(repeated.compiled,false);assert.equal(repeated.packaged,false);assert.equal(repeated.artifact.payloadHash,first.artifact.payloadHash);
 const legacy=JSON.parse(readFileSync(statePath));delete legacy.outputDigest;writeFileSync(statePath,JSON.stringify(legacy));
 await assert.rejects(execute(root,'package',['probe']),/BUILD_OUTPUT_UNVERIFIED/);
 assert.equal(readFileSync(join(root,'services/probe/build-count'),'utf8'),'11');
 assert.equal((await execute(root,'build',['probe']))[0].compiled,true);
 // A check must not mutate trusted output and then have run/package attest it.
 put(root,'services/probe/tests.mjs',"import{writeFileSync}from'node:fs';writeFileSync('dist/main.mjs','export const value=999;');");
 await assert.rejects(execute(root,'run',['probe']),/BUILD_OUTPUT_MISMATCH/);
 assert.equal(readFileSync(join(first.artifact.path,'services/probe/dist/main.mjs'),'utf8'),'export const value=1;\n');
});

test('reference documentation leaves runtime keys unchanged while packaged instructions change them',t=>{
 const root=fixture(t),d=add(root,'probe');
 put(root,'docs/user-agent/instructions/context.md','accepted behavior\n');
 d.inputs.runtime.push('docs/user-agent/instructions/context.md');
 d.delivery.files.push('docs/user-agent/instructions/context.md');
 save(root,'probe',d);
 const before=fingerprints(root,discover(root).components.get('probe'));
 put(root,'docs/components/probe.md','Updated user guide');
 const reference=fingerprints(root,discover(root).components.get('probe'));
 assert.equal(reference.runtime,before.runtime);assert.equal(reference.artifact,before.artifact);
 put(root,'docs/user-agent/instructions/context.md','new behavior\n');
 const changed=fingerprints(root,discover(root).components.get('probe'));
 assert.notEqual(changed.runtime,before.runtime);assert.notEqual(changed.artifact,before.artifact);
});

test('cold source plan excludes generated bundle; built delivery admits its exact runtime reference',async t=>{
 const root=fixture(t),d=add(root,'probe');
 put(root,'services/probe/main.mjs',"export const bundle=new URL('./dist/workflows.js',import.meta.url);\n");
 put(root,'services/probe/build.mjs',"import{mkdirSync,writeFileSync}from'node:fs';mkdirSync('dist',{recursive:true});writeFileSync('dist/workflows.js','module.exports={};');\n");
 d.delivery.files.push('services/probe/dist/workflows.js');save(root,'probe',d);
 assert.throws(()=>discover(root),/DELIVERY_NOT_FOUND/);
 const cold=(await execute(root,'plan',['probe']))[0];
 await execute(root,'build',['probe']);
 const built=(await execute(root,'plan',['probe']))[0];
 for(const key of ['build','artifact','checks'])assert.equal(cold[key],built[key]);
 assert.notEqual(cold.runtime,built.runtime);
 assert.deepEqual(discover(root).order,['probe']);
 const pkg=(await execute(root,'package',['probe']))[0];
 assert.equal(readFileSync(join(pkg.artifact.path,'services/probe/dist/workflows.js'),'utf8'),'module.exports={};');
 put(root,'services/probe/dist/other.js','module.exports={};');
 put(root,'services/probe/main.mjs',"export const bundle=new URL('./dist/other.js',import.meta.url);\n");
 assert.throws(()=>discover(root),/UNDECLARED_LOCAL_INPUT/);
});
