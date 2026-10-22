// ABOUTME: Проверяет переносимость, замкнутость npm-зависимостей и неизменяемость поставок компонентов.
// ABOUTME: Использует небольшие временные репозитории без сети и установки пакетов.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { packageComponent } from './package-runtime.mjs';

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
