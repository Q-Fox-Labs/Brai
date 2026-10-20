// ABOUTME: Проверяет preflight полного batch на настоящем Python file worker.
// ABOUTME: Невалидная поздняя операция не должна оставить раннюю запись.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

test('batch preflight rejects invalid late operations before writing earlier files',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'codeworks-files-'));
  try {
    await mkdir(path.join(root,'directory'));
    await writeFile(path.join(root,'existing.txt'),'preserved');
    const invalid=[
      {op:'rename',path:'existing.txt'},
      {op:'write',path:'directory',content:'invalid'},
      {op:'delete',path:'directory'},
      {op:'symlink',path:'existing.txt',target:'directory'},
    ];
    for(const operation of invalid) {
      const result=spawnSync('/usr/bin/python3',[fileURLToPath(new URL('../src/agent-files.py',import.meta.url))],{input:JSON.stringify({root,action:'batch',operations:[{op:'write',path:'partial.txt',content:'must not appear'},operation]}),encoding:'utf8',timeout:5000});
      assert.equal(result.status,1);
      assert.deepEqual(JSON.parse(result.stdout),{error:'FILE_OPERATION_REJECTED'});
      await assert.rejects(readFile(path.join(root,'partial.txt')));
      assert.equal(await readFile(path.join(root,'existing.txt'),'utf8'),'preserved');
    }
  } finally {await rm(root,{recursive:true,force:true});}
});
