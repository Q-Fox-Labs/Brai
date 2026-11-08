// ABOUTME: Проверяет фактическую immutable поставку ядра, а не только строку в descriptor.
// ABOUTME: Использует публичный Codeworks CLI и isolated Python import без исходного дерева.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('immutable Artifacts delivery contains the exact reviewed ownership kernel', {timeout:90000},()=>{
 const root=fileURLToPath(new URL('../../../',import.meta.url));
 const cli=fileURLToPath(new URL('../../codeworks/components/cli.mjs',import.meta.url));
 const packaged=spawnSync(process.execPath,[cli,'package','artifacts','--only'],{cwd:root,encoding:'utf8',timeout:60000,maxBuffer:16*1024*1024});
 assert.equal(packaged.status,0,packaged.stderr);
 const record=JSON.parse(packaged.stdout).find(row=>row.id==='artifacts');
 assert.equal(record.artifact.componentId,'artifacts');
 const kernel='services/artifacts/ownership_migration.py';
 const rows=record.artifact.files.filter(row=>row.path===kernel);
 assert.equal(rows.length,1);
 const path=join(record.artifact.path,kernel),bytes=readFileSync(path);
 const sha=createHash('sha256').update(bytes).digest('hex');
 assert.equal(sha,'a59747e4ee28719d19bde43fd070fd98b9179041553105e4d6d42c2bc7896933');
 assert.equal(rows[0].sha256,sha);assert.equal(rows[0].size,bytes.length);assert.equal(rows[0].symlink,undefined);
 const isolated=mkdtempSync(join(tmpdir(),'artifacts-kernel-import-'));
 try{
  const result=spawnSync('python3',['-B','-c',
   "import importlib.util,sys; s=importlib.util.spec_from_file_location('accepted_kernel',sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); assert set(m.TABLES)=={'artifacts','references','outputs','relations','links'}; assert callable(m.migration_sql); print('ISOLATED_KERNEL_OK')",path],
   {cwd:isolated,encoding:'utf8',timeout:10000,env:{...process.env,PYTHONPATH:'',PYTHONNOUSERSITE:'1'}});
  assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/ISOLATED_KERNEL_OK/);
 }finally{rmSync(isolated,{recursive:true,force:true});}
});
