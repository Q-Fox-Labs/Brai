// ABOUTME: Проверяет повторное использование mtime только при совпадении SHA-256 исходника.
// ABOUTME: Изменение байтов и структуры каталогов обязательно даёт новые времена.
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,rmSync,statSync,utimesSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {snapshotSources,snapshotDirectories,verifySources} from './source-snapshot.mjs';

test('stable source and directory times require matching bytes and entries',t=>{
  const root=mkdtempSync(join(tmpdir(),'brai-snapshot-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const repo=join(root,'repo');mkdirSync(repo);execFileSync('git',['-C',repo,'init','-q']);
  mkdirSync(join(repo,'app'));writeFileSync(join(repo,'app','one.js'),'first');
  const one=join(root,'one');mkdirSync(one);
  const files=snapshotSources(repo,one),dirs=snapshotDirectories(one);
  assert.ok(verifySources(repo,files));
  const two=join(root,'two');mkdirSync(two);
  const unchanged=snapshotSources(repo,two,{files}),unchangedDirs=snapshotDirectories(two,{dirs});
  assert.equal(unchanged['app/one.js'].mtimeMs,files['app/one.js'].mtimeMs);
  assert.equal(unchangedDirs.app.mtimeMs,dirs.app.mtimeMs);
  writeFileSync(join(repo,'app','one.js'),'other');
  utimesSync(join(repo,'app','one.js'),files['app/one.js'].mtimeMs/1000,files['app/one.js'].mtimeMs/1000);
  writeFileSync(join(repo,'app','two.js'),'added');
  assert.equal(verifySources(repo,files),false);
  const three=join(root,'three');mkdirSync(three);
  const changed=snapshotSources(repo,three,{files}),changedDirs=snapshotDirectories(three,{dirs});
  assert.notEqual(changed['app/one.js'].sha256,files['app/one.js'].sha256);
  assert.notEqual(changed['app/one.js'].mtimeMs,files['app/one.js'].mtimeMs);
  assert.notEqual(changedDirs.app.sha256,dirs.app.sha256);
  assert.ok(statSync(join(three,'app','two.js')).isFile());
});
