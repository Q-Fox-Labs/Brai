// ABOUTME: Проверяет доставку единственного readonly proof через shell runner в build subprocess.
// ABOUTME: Не использует привилегированный оператор и действующий DEV.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {closeSync,mkdtempSync,openSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

test('publisher proof FD survives the real component shell',t=>{
  const root=mkdtempSync(join(tmpdir(),'brai-proof-fd-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const proof=join(root,'proof');writeFileSync(proof,'proof-bytes');const fd=openSync(proof,'r');
  try {
    const script=`import {runComponentCommand} from ${JSON.stringify(pathToFileURL(join(import.meta.dirname,'cli.mjs')).href)}; runComponentCommand(${JSON.stringify(root)},{directory:'.'},"node -e 'process.stdout.write(require(\\\"fs\\\").readFileSync(3,\\\"utf8\\\"))'");`;
    const child=spawnSync(process.execPath,['--input-type=module','--eval',script],{env:{...process.env,BRAI_PUBLISHER_PROOF_FD:'3'},stdio:['ignore','pipe','pipe',fd],encoding:'utf8'});
    assert.equal(child.status,0,child.stderr);assert.equal(child.stdout,'proof-bytes');
  } finally {closeSync(fd);}
});
