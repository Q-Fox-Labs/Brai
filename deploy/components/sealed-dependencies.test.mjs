// ABOUTME: Проверяет точное совпадение выбранных npm-пакетов с immutable closure.
// ABOUTME: Настоящее происхождение receipt проверяется отдельно до вызова helper.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,symlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {sealedInventory} from './sealed-dependencies.mjs';
import {dependencyInventory} from './cli.mjs';

const hash=s=>createHash('sha256').update(s).digest('hex');
test('sealed inventory binds package paths, selected lock entries and toolchain',t=>{
  const base=mkdtempSync(join(tmpdir(),'brai-sealed-inventory-'));
  t.after(()=>rmSync(base,{recursive:true,force:true}));
  const root=join(base,'checkout'),generation=join(base,'generation');
  mkdirSync(join(root,'node_modules'),{recursive:true});
  mkdirSync(join(generation,'node_modules/sample'),{recursive:true});
  symlinkSync(join(generation,'node_modules/sample'),join(root,'node_modules/sample'));
  const entry={version:'1.0.0'},entries=[{key:'node_modules/sample',entry}];
  const lock=JSON.stringify({packages:{'node_modules/sample':entry}}),tool=JSON.stringify({nodeAbi:process.versions.modules,glibc:`glibc ${process.report.getReport().header.glibcVersionRuntime}`});
  writeFileSync(join(generation,'package-lock.json'),lock);
  writeFileSync(join(generation,'.brai-toolchain.json'),tool);
  writeFileSync(join(generation,'.brai-closure.json'),JSON.stringify({packages:['node_modules/sample']}));
  const proof={contentSha256:'content',lockSha256:hash(lock),toolchainSha256:hash(tool),node:process.versions.node};
  const identity=sealedInventory(root,entries,proof,generation);assert.match(identity,/^[0-9a-f]{64}$/);
  assert.equal(sealedInventory(root,[{key:'node_modules/sample',entry:{version:'2.0.0'}}],proof,generation),null);
  assert.equal(sealedInventory(root,entries,{...proof,lockSha256:'changed'},generation),null);
  assert.equal(sealedInventory(root,entries,{...proof,toolchainSha256:'changed'},generation),null);
  writeFileSync(join(generation,'.brai-closure.json'),JSON.stringify({packages:[]}));
  assert.equal(sealedInventory(root,entries,proof,generation),null);
  writeFileSync(join(generation,'.brai-closure.json'),JSON.stringify({packages:['node_modules/sample']}));
  const old=process.env.NODE_OPTIONS;process.env.NODE_OPTIONS='--no-warnings';
  try {assert.equal(sealedInventory(root,entries,proof,generation),null);} finally {if(old===undefined)delete process.env.NODE_OPTIONS;else process.env.NODE_OPTIONS=old;}
  rmSync(join(root,'node_modules/sample'));mkdirSync(join(root,'node_modules/sample'));
  assert.equal(sealedInventory(root,entries,proof,generation),null);
});

test('invalid publisher proof falls back to scanning mutable package bytes',t=>{
  const root=mkdtempSync(join(tmpdir(),'brai-unsealed-inventory-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  mkdirSync(join(root,'node_modules/sample'),{recursive:true});
  const manifest={name:'fixture',version:'1.0.0',dependencies:{sample:'1.0.0'}},entry={version:'1.0.0'};
  writeFileSync(join(root,'package.json'),JSON.stringify(manifest));
  writeFileSync(join(root,'package-lock.json'),JSON.stringify({lockfileVersion:3,packages:{'':manifest,'node_modules/sample':entry}}));
  writeFileSync(join(root,'node_modules/.brai-worktree.json'),JSON.stringify({dependencyRoot:'/tmp/fake-generation'}));
  const file=join(root,'node_modules/sample/index.js');writeFileSync(file,'one');
  const previous=process.env.BRAI_PUBLISHER_PROOF_FD;process.env.BRAI_PUBLISHER_PROOF_FD='3';
  try {
    const c={npm:{workspaces:['.']}},first=dependencyInventory(root,c,true);
    assert.match(first,/^[0-9a-f]{64}$/);
    writeFileSync(file,'two');assert.notEqual(dependencyInventory(root,c,true),first);
    const old=process.env.NODE_OPTIONS;process.env.NODE_OPTIONS='--no-warnings';
    try {assert.equal(dependencyInventory(root,c,true),null);} finally {if(old===undefined)delete process.env.NODE_OPTIONS;else process.env.NODE_OPTIONS=old;}
  } finally {if(previous===undefined)delete process.env.BRAI_PUBLISHER_PROOF_FD;else process.env.BRAI_PUBLISHER_PROOF_FD=previous;}
});
