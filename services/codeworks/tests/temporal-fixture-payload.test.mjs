// ABOUTME: Проверяет точное независимое копирование immutable test payload.
// ABOUTME: Воспроизводит relative workspace links и режимы без внешних сервисов и package installation.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readlink,symlink,chmod,stat,rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {copyFixtureTree} from './integration/temporal-fixture-payload.mjs';
test('fixture copy preserves relative symlink bytes, modes and independent file contents',async t=>{
  const tmp=fileURLToPath(new URL('../../../tmp/',import.meta.url));await mkdir(tmp,{recursive:true});
  const root=await mkdtemp(tmp+'fixture-copy-');t.after(()=>rm(root,{recursive:true,force:true}));
  const source=root+'/source',destination=root+'/destination';
  await mkdir(source+'/packages/leaf',{recursive:true});await mkdir(source+'/node_modules/@fixture',{recursive:true});
  await writeFile(source+'/packages/leaf/index.js','original');await chmod(source+'/packages/leaf/index.js',0o440);
  await symlink('../../packages/leaf',source+'/node_modules/@fixture/leaf');
  copyFixtureTree(source,destination);
  assert.equal(await readlink(destination+'/node_modules/@fixture/leaf'),'../../packages/leaf');
  assert.equal((await stat(destination+'/packages/leaf/index.js')).mode&0o777,0o440);
  await chmod(destination+'/packages/leaf/index.js',0o600);await writeFile(destination+'/packages/leaf/index.js','updated-copy');
  assert.equal(await readFile(source+'/packages/leaf/index.js','utf8'),'original');
  assert.throws(()=>copyFixtureTree(source,destination),/FIXTURE_COPY_PATH_INVALID/);
});
