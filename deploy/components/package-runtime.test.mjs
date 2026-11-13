// ABOUTME: Проверяет переносимость, замкнутость npm-зависимостей и неизменяемость поставок компонентов.
// ABOUTME: Использует небольшие временные репозитории без сети и установки пакетов.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { packageComponent, verifyPackage } from './package-runtime.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'brai-package-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (key, value) => {
    const path = join(root, key);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, typeof value === 'string' ? value : `${JSON.stringify(value)}\n`);
    chmodSync(path, 0o644);
  };
  const component = {
    id: 'fixture', type: 'program', directory: 'services/example',
    delivery: { kind: 'ready-files', files: ['services/example/main.mjs'], entrypoints: ['services/example/main.mjs'], smokeImports: ['services/example/main.mjs'], systemRequirements: ['Node.js 24.22.1'] },
  };
  write('services/example/main.mjs', 'export const value = 42;\n');
  return { root, write, component, build: () => packageComponent(root, component, 'tmp/output') };
}

test('Next standalone copies only traced output with safe modes and rejects secret or link output', async t => {
  const {root,write,component,build}=fixture(t);
  component.id='web';component.directory='apps/web';
  component.delivery={kind:'oci-context',strategy:'next-standalone',files:['apps/web/.next/standalone','apps/web/.next/static','apps/web/public'],entrypoints:['apps/web/server.js'],smokeImports:[],systemRequirements:['Node.js 24.22.1'],command:['node','server.js']};
  write('apps/web/.next/standalone/apps/web/server.js','console.log("ready");\n');
  write('apps/web/.next/standalone/node_modules/traced/index.js','module.exports=1;\n');
  write('apps/web/.next/static/test.js','static');write('apps/web/public/test.txt','public');
  const source=join(root,'apps/web/.next/standalone/node_modules/traced/index.js');chmodSync(source,0o600);
  const previous=process.umask(0o077);let artifact;
  try {artifact=await build();} finally {process.umask(previous);}
  for(const directory of ['', 'apps', 'apps/web', 'node_modules', 'node_modules/traced'])assert.equal(statSync(join(artifact.path,directory)).mode & 0o777,0o755,directory);
  assert.equal(readFileSync(join(artifact.path,'node_modules/traced/index.js'),'utf8'),'module.exports=1;\n');
  assert.equal(statSync(join(artifact.path,'node_modules/traced/index.js')).mode&0o777,0o644);
  assert.notEqual(statSync(source).ino,statSync(join(artifact.path,'node_modules/traced/index.js')).ino);
  assert.deepEqual(artifact.runtime.command,['node','server.js']);
  chmodSync(join(artifact.path,'node_modules'),0o700);
  assert.throws(()=>verifyPackage(artifact.path,'web'),/IMMUTABLE_DIRECTORY_MODE/);
  chmodSync(join(artifact.path,'node_modules'),0o755);
  write('apps/web/.next/standalone/.env.local','secret');
  await assert.rejects(build(),/FORBIDDEN_DELIVERY_FILE/);
  rmSync(join(root,'apps/web/.next/standalone/.env.local'));
  symlinkSync('/etc/passwd',join(root,'apps/web/.next/standalone/escape'));
  await assert.rejects(build(),/DELIVERY_SYMLINK/);
});

test('deterministic payloads preserve layout and mode; existing payload is verified', async t => {
  const { root, write, component, build } = fixture(t);
  write('services/neighbor/contract.mjs', 'export const value = 42;\n');
  write('services/example/main.mjs', "export { value } from '../neighbor/contract.mjs';\n");
  component.delivery.files.push('services/neighbor/contract.mjs');
  const first = await build();
  const second = await build();
  assert.deepEqual(second, first);
  assert.equal(first.format, 'brai-component-runtime-v1');
  assert.equal(first.files.length, 2);
  assert.equal(first.files.find(file => file.path.endsWith('main.mjs')).mode, 0o644);
  assert.equal(first.path, join(root, 'tmp/output', `fixture-${first.payloadHash}`));
  const diskManifest = JSON.parse(readFileSync(join(first.path, 'artifact-manifest.json'), 'utf8'));
  assert.equal(diskManifest.path, undefined);
  assert.equal(diskManifest.systemRequirements[0], 'Node.js 24.22.1');
  chmodSync(join(root, 'services/example/main.mjs'), 0o755);
  const executable = await build();
  assert.notEqual(executable.payloadHash, first.payloadHash);
  writeFileSync(join(executable.path, 'services/example/main.mjs'), 'export const value = 0;\n');
  await assert.rejects(build(), /IMMUTABLE_OUTPUT_MISMATCH/);
  assert.match(readFileSync(join(executable.path, 'services/example/main.mjs'), 'utf8'), /value = 0/);
});

test('first-party delivery removes group and other write access without changing source', async t => {
  const {root, build} = fixture(t);
  const source = join(root, 'services/example/main.mjs');
  chmodSync(source, 0o664);
  const regular = await build();
  const file = join(regular.path, 'services/example/main.mjs');
  assert.equal(statSync(source).mode & 0o777, 0o664);
  assert.equal(statSync(file).mode & 0o777, 0o644);
  assert.equal(regular.files.find(item => item.path === 'services/example/main.mjs').mode, 0o644);
  chmodSync(source, 0o775);
  const executable = await build();
  assert.equal(statSync(source).mode & 0o777, 0o775);
  assert.equal(statSync(join(executable.path, 'services/example/main.mjs')).mode & 0o777, 0o755);
});

test('private sources and umask 077 produce service-readable canonical files', async t => {
  const {root,write,component,build}=fixture(t);
  const app={name:'@brai/example',version:'1.0.0',type:'module',dependencies:{dep:'1.0.0'}};
  write('services/example/package.json',app);
  write('services/example/migrations/001.sql','CREATE TABLE fixture (id integer);\n');
  write('services/example/tool.mjs','export const tool = true;\n');
  write('node_modules/dep/package.json',{name:'dep',version:'1.0.0'});
  write('node_modules/dep/index.js','module.exports = 1;\n');
  write('node_modules/dep/bin.js','#!/usr/bin/env node\n');
  write('package-lock.json',{lockfileVersion:3,packages:{'services/example':app,'node_modules/dep':{name:'dep',version:'1.0.0'}}});
  component.delivery.files.push('services/example/package.json','services/example/migrations','services/example/tool.mjs');
  component.npm={workspaces:['services/example']};
  for(const file of ['services/example/main.mjs','services/example/migrations/001.sql','node_modules/dep/index.js'])chmodSync(join(root,file),0o600);
  for(const file of ['services/example/tool.mjs','node_modules/dep/bin.js'])chmodSync(join(root,file),0o700);
  const previous=process.umask(0o077);let artifact;
  try {artifact=await build();} finally {process.umask(previous);}
  for(const row of artifact.files.filter(row=>!row.symlink)) {
    assert.ok([0o644,0o755].includes(row.mode),row.path);
    assert.equal(row.mode & 0o444,0o444,row.path);
    assert.equal(statSync(join(artifact.path,row.path)).mode & 0o777,row.mode,row.path);
  }
  for(const file of ['services/example/main.mjs','services/example/migrations/001.sql','node_modules/dep/index.js']) {
    assert.equal(statSync(join(artifact.path,file)).mode & 0o777,0o644);
    assert.equal(artifact.files.find(row=>row.path===file).mode,0o644);
    assert.equal(statSync(join(root,file)).mode & 0o777,0o600);
  }
  for(const file of ['services/example/tool.mjs','node_modules/dep/bin.js']) {
    assert.equal(statSync(join(artifact.path,file)).mode & 0o777,0o755);
    assert.equal(artifact.files.find(row=>row.path===file).mode,0o755);
    assert.equal(statSync(join(root,file)).mode & 0o777,0o700);
  }
  assert.notEqual(statSync(join(artifact.path,'node_modules/dep/index.js')).ino,statSync(join(root,'node_modules/dep/index.js')).ino);
  verifyPackage(artifact.path,'fixture');
  assert.equal((await build()).payloadHash,artifact.payloadHash);
});

test('npm closure preserves workspace-local and nested lock paths and omits dev packages', async t => {
  const { write, component, build } = fixture(t);
  const manifest = { name: '@brai/example', version: '1.0.0', type: 'module', dependencies: { outer: '1.0.0' }, devDependencies: { unrelated: '1.0.0' } };
  write('services/example/package.json', manifest);
  write('services/example/main.mjs', "import { value } from 'outer'; if (value !== 7) throw Error('wrong nested dependency');\n");
  component.delivery.files.push('services/example/package.json');
  component.npm = { workspaces: ['services/example'] };
  const outer = 'services/example/node_modules/outer';
  const inner = `${outer}/node_modules/inner`;
  write(`${outer}/package.json`, { name: 'outer', version: '1.0.0', type: 'module', exports: './index.js' });
  write(`${outer}/index.js`, "export { value } from 'inner';\n");
  write(`${inner}/package.json`, { name: 'inner', version: '2.0.0', type: 'module', exports: './index.js' });
  write(`${inner}/index.js`, 'export const value = 7;\n');
  write('node_modules/unrelated/package.json', { name: 'unrelated', version: '1.0.0' });
  write('package-lock.json', { lockfileVersion: 3, packages: {
    'services/example': manifest,
    [outer]: { version: '1.0.0', integrity: 'sha512-outer', dependencies: { inner: '2.0.0' } },
    [inner]: { version: '2.0.0', integrity: 'sha512-inner' },
    'node_modules/unrelated': { version: '1.0.0', dev: true },
  } });
  const result = await build();
  assert.deepEqual(result.runtimePackages.map(item => item.lockKey), [outer, inner]);
  assert.ok(existsSync(join(result.path, inner, 'index.js')));
  assert.ok(!existsSync(join(result.path, 'node_modules/unrelated')));
  assert.equal(result.runtimePackages[0].integrity, 'sha512-outer');
});

test('workspace links include only explicitly selected contracts and verify linked manifests', async t => {
  const { root, write, component, build } = fixture(t);
  const manifest = { name: '@brai/example', version: '1.0.0', type: 'module', dependencies: { '@brai/contracts': '1.0.0' } };
  const contracts = { name: '@brai/contracts', version: '1.0.0', type: 'module', exports: { './contracts': './contracts.mjs' } };
  write('services/example/package.json', manifest);
  write('services/contracts/package.json', contracts);
  write('services/contracts/contracts.mjs', 'export const value = 42;\n');
  write('services/contracts/private.mjs', "throw Error('private implementation must not be copied');\n");
  write('services/example/main.mjs', "export { value } from '@brai/contracts/contracts';\n");
  mkdirSync(join(root, 'node_modules/@brai'), { recursive: true });
  symlinkSync('../../services/contracts', join(root, 'node_modules/@brai/contracts'));
  write('package-lock.json', { lockfileVersion: 3, packages: {
    'services/example': manifest, 'services/contracts': contracts,
    'node_modules/@brai/contracts': { link: true, resolved: 'services/contracts' },
  } });
  component.delivery.files.push('services/example/package.json', 'services/contracts/package.json', 'services/contracts/contracts.mjs');
  component.npm = { workspaces: ['services/example'] };
  const result = await build();
  assert.equal(result.runtimePackages[0].target, 'services/contracts');
  assert.ok(!existsSync(join(result.path, 'services/contracts/private.mjs')));
  write('services/contracts/package.json', { ...contracts, dependencies: { missing: '1.0.0' } });
  await assert.rejects(build(), /WORKSPACE_LOCK_MISMATCH: services\/contracts: dependencies/);
});

test('smoke cannot resolve an omitted dependency from repository node_modules', async t => {
  const { write, build } = fixture(t);
  write('node_modules/omitted/package.json', { name: 'omitted', version: '1.0.0', type: 'module', exports: './index.js' });
  write('node_modules/omitted/index.js', 'export const value = 1;\n');
  write('services/example/main.mjs', "import 'omitted';\n");
  await assert.rejects(build(), /ARTIFACT_SMOKE_FAILED.*|ERR_MODULE_NOT_FOUND/s);
});

test('isolated smoke follows workspace links inside the payload, not the original stage', async t => {
  const { root, write, component, build } = fixture(t);
  const app = { name: '@brai/example', version: '1.0.0', type: 'module', dependencies: { '@brai/contracts': '1.0.0' } };
  const contracts = { name: '@brai/contracts', version: '1.0.0', type: 'module', exports: './index.mjs' };
  write('services/example/package.json', app);
  write('services/contracts/package.json', contracts);
  write('services/contracts/index.mjs', "import 'omitted';\n");
  write('services/example/main.mjs', "import '@brai/contracts';\n");
  write('node_modules/omitted/package.json', { name: 'omitted', version: '1.0.0', type: 'module', exports: './index.mjs' });
  write('node_modules/omitted/index.mjs', 'export {};\n');
  mkdirSync(join(root, 'node_modules/@brai'), { recursive: true });
  symlinkSync('../../services/contracts', join(root, 'node_modules/@brai/contracts'));
  write('package-lock.json', { lockfileVersion: 3, packages: {
    'services/example': app, 'services/contracts': contracts,
    'node_modules/@brai/contracts': { link: true, resolved: 'services/contracts' },
  } });
  component.npm = { workspaces: ['services/example'] };
  component.delivery.files.push('services/example/package.json', 'services/contracts/package.json', 'services/contracts/index.mjs');
  await assert.rejects(build(), /ARTIFACT_SMOKE_FAILED.*ERR_MODULE_NOT_FOUND/s);
});

test('delivery rejects secrets, model weights, tests, unbuilt source and symlink escapes', async t => {
  const { root, write, component, build } = fixture(t);
  for (const key of ['services/example/.env.local', 'services/example/credentials.json', 'services/example/model.gguf', 'services/example/model.bin', 'services/example/tests/example.mjs', 'services/example/source.ts']) {
    write(key, 'unused');
    component.delivery.files = ['services/example/main.mjs', key];
    await assert.rejects(build(), /FORBIDDEN_DELIVERY_FILE|UNBUILT_DELIVERY_SOURCE/);
  }
  symlinkSync('/etc/hosts', join(root, 'services/example/escape.mjs'));
  component.delivery.files = ['services/example/main.mjs', 'services/example/escape.mjs'];
  await assert.rejects(build(), /DELIVERY_SYMLINK_ESCAPE/);
  await assert.rejects(packageComponent(root, component, '../outside'), /OUTPUT_MUST_BE_UNDER_ROOT_TMP/);
});

test('OCI context uses only copied files and starts the selected entrypoint', async t => {
  const { component, build } = fixture(t);
  component.delivery.kind = 'oci-context';
  const result = await build();
  const docker = readFileSync(join(result.path, 'Dockerfile'), 'utf8');
  assert.match(docker, /FROM node:24\.22\.1-bookworm-slim/);
  assert.match(docker, /COPY \. \/app/);
  assert.match(docker, /CMD \["node","main.mjs"\]/);
  assert.doesNotMatch(docker, /RUN|npm|tsc/);
  component.delivery.command = ['node', '../../node_modules/next/dist/bin/next', 'start'];
  const custom = await build();
  assert.match(readFileSync(join(custom.path, 'Dockerfile'), 'utf8'), /CMD \["node","\.\.\/\.\.\/node_modules\/next\/dist\/bin\/next","start"\]/);
});

test('optional packages incompatible with this platform are omitted', async t => {
  const { write, component, build } = fixture(t);
  const manifest = { name: '@brai/example', version: '1.0.0', optionalDependencies: { foreign: '1.0.0' } };
  write('services/example/package.json', manifest);
  write('node_modules/foreign/package.json', { name: 'foreign', version: '1.0.0' });
  write('package-lock.json', { lockfileVersion: 3, packages: {
    'services/example': manifest,
    'node_modules/foreign': { version: '1.0.0', os: [`!${process.platform}`] },
  } });
  component.delivery.files.push('services/example/package.json');
  component.npm = { workspaces: ['services/example'] };
  assert.deepEqual((await build()).runtimePackages, []);
});

test('JSON smoke imports use the Node import attribute', async t => {
  const { write, component, build } = fixture(t);
  write('services/example/runtime.json', { version: 1 });
  component.delivery.files.push('services/example/runtime.json');
  component.delivery.smokeImports = ['services/example/runtime.json'];
  assert.equal((await build()).files.length, 2);
});

test('installed optional integration peers are excluded unless declared by the consumer', async t => {
  const {write,component,build}=fixture(t);
  component.delivery.files.push('services/example/package.json');component.npm={workspaces:['services/example']};
  const app={name:'@brai/example',version:'1.0.0',type:'module',dependencies:{owner:'1.0.0'}};
  const owner={version:'1.0.0',peerDependencies:{integration:'1.0.0'},peerDependenciesMeta:{integration:{optional:true}}};
  write('services/example/package.json',app);
  write('node_modules/owner/package.json',{name:'owner',...owner,type:'module',exports:'./index.js'});write('node_modules/owner/index.js','export const value=1;');
  write('node_modules/integration/package.json',{name:'integration',version:'1.0.0'});write('node_modules/integration/index.js','module.exports=1;');
  const lock={lockfileVersion:3,packages:{'services/example':app,'node_modules/owner':owner,'node_modules/integration':{version:'1.0.0'}}};write('package-lock.json',lock);
  let result=await build();assert.deepEqual(result.runtimePackages.map(x=>x.lockKey),['node_modules/owner']);
  app.dependencies.integration='1.0.0';write('services/example/package.json',app);write('package-lock.json',lock);
  result=await build();assert.deepEqual(result.runtimePackages.map(x=>x.lockKey),['node_modules/integration','node_modules/owner']);
});

test('runtime launch contract changes receive their own immutable identity', async t=>{
 const {component,build}=fixture(t);const first=await build();
 component.delivery.command=['node','main.mjs','--mode=second'];component.delivery.systemRequirements.push('external runtime v2');
 const second=await build();assert.notEqual(second.payloadHash,first.payloadHash);assert.deepEqual(second.runtime.command,component.delivery.command);
});

test('personal documentation is rejected even through a selected parent directory', async t => {
  const {write,component,build}=fixture(t);
  write('docs/user-agent/usercustom/personal.md','local only');
  component.delivery.files.push('docs/user-agent');
  await assert.rejects(build(), /FORBIDDEN_DELIVERY_FILE: docs\/user-agent\/usercustom/);
});


test('code-only releases retain independent dependency bytes', async t => {
  const {root, write, component, build} = fixture(t);
  const app = {name:'@brai/example', version:'1.0.0', type:'module', dependencies:{dep:'1.0.0'}};
  write('services/example/package.json', app);
  write('node_modules/dep/package.json', {name:'dep', version:'1.0.0', type:'module', exports:'./index.js'});
  write('prepared-dep/index.js', 'export const value = 7;\n');
  symlinkSync('../../prepared-dep/index.js', join(root, 'node_modules/dep/index.js'));
  write('package-lock.json', {lockfileVersion:3, packages:{'services/example':app,'node_modules/dep':{version:'1.0.0'}}});
  component.delivery.files.push('services/example/package.json');
  component.npm = {workspaces:['services/example']};
  write('services/example/main.mjs', "import {value} from 'dep'; export const result = value;\n");
  const first = await build();
  write('services/example/main.mjs', "import {value} from 'dep'; export const result = value + 1;\n");
  const second = await build();
  const source = join(root,'prepared-dep/index.js');
  const oldDependency = join(first.path,'node_modules/dep/index.js');
  const newDependency = join(second.path,'node_modules/dep/index.js');
  const identity = path => {const {dev,ino} = statSync(path); return [dev,ino];};
  assert.notEqual(first.payloadHash, second.payloadHash);
  assert.ok(lstatSync(oldDependency).isFile());
  assert.notDeepEqual(identity(oldDependency), identity(source));
  assert.notDeepEqual(identity(newDependency), identity(source));
  assert.notDeepEqual(identity(join(first.path,'services/example/main.mjs')), identity(join(second.path,'services/example/main.mjs')));
  assert.notDeepEqual(identity(join(second.path,'services/example/main.mjs')), identity(join(root,'services/example/main.mjs')));
  verifyPackage(first.path, 'fixture'); verifyPackage(second.path, 'fixture');
  writeFileSync(source, 'export const value = 8;\n');
  verifyPackage(first.path, 'fixture'); verifyPackage(second.path, 'fixture');
  assert.equal(readFileSync(oldDependency,'utf8'),'export const value = 7;\n');
  assert.equal(readFileSync(newDependency,'utf8'),'export const value = 7;\n');
});


test('shared dependencies reject group-writable sources without changing their mode', async t => {
  const {root,write,component,build}=fixture(t);
  const app={name:'@brai/example',version:'1.0.0',dependencies:{dep:'1.0.0'}};
  write('services/example/package.json',app);
  write('node_modules/dep/package.json',{name:'dep',version:'1.0.0'});
  write('package-lock.json',{lockfileVersion:3,packages:{'services/example':app,'node_modules/dep':{version:'1.0.0'}}});
  component.npm={workspaces:['services/example']};
  const source=join(root,'node_modules/dep/package.json'); chmodSync(source,0o664);
  await assert.rejects(build(),/PACKAGING_SOURCE_PERMISSIONS/);
  assert.equal(statSync(source).mode & 0o777,0o664);
});

test('smoke cannot mutate prepared dependency files through the read-only package', async t => {
  const {root,write,component,build}=fixture(t);
  const app={name:'@brai/example',version:'1.0.0',type:'module',dependencies:{dep:'1.0.0'}};
  write('services/example/package.json',app);
  write('node_modules/dep/package.json',{name:'dep',version:'1.0.0',type:'module',exports:'./index.js'});
  write('node_modules/dep/index.js',"import {writeFileSync} from 'node:fs'; try { writeFileSync(new URL('./index.js', import.meta.url), 'corrupted'); throw Error('write succeeded'); } catch (error) { if (!['EROFS','EACCES'].includes(error.code)) throw error; } export const value = 7;\n");
  write('services/example/main.mjs',"import {value} from 'dep'; if(value !== 7) throw Error('bad dependency');\n");
  write('package-lock.json',{lockfileVersion:3,packages:{'services/example':app,'node_modules/dep':{version:'1.0.0'}}});
  component.npm={workspaces:['services/example']};
  const source=join(root,'node_modules/dep/index.js'),before=readFileSync(source,'utf8');
  await build(); assert.equal(readFileSync(source,'utf8'),before);
});
