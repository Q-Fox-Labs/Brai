// ABOUTME: Проверяет выбор точной привязки до запуска физического runner.
// ABOUTME: Два binding имеют одинаковый рецепт, но разные commit и oracle.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createRunner} from '../dist/verification-runner.js';
import {verificationHash as hash} from '../dist/verification-store.js';

test('runner selects the complete binding and rejects mismatched oracle',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'runner-binding-'));
 try{
  const source=join(dir,'source'),state=join(dir,'state'),harness=join(dir,'harness');await mkdir(source);await mkdir(state);await writeFile(join(source,'index.mjs'),'source');await writeFile(harness,'unexpected');
  const oracle={requirement_id:randomUUID(),requirement_sha256:'b'.repeat(64),expected:'accepted',version:'test',confirms_claim:'claim'};
  const {requirement_id,...bound}=oracle;
  const entry={id:'recipe',version:'1',source_id:'source',source_root:source,source_file:'index.mjs',source_commit:'a'.repeat(40),source_sha256:hash('source'),source_tree_sha256:'c'.repeat(64),harness,harness_sha256:hash('different'),fixture_refs:['fixture'],fixture_sha256:{},oracle:bound};
  const runner=createRunner({stateRoot:state,nodeRoot:'/runtime',node:'/runtime/node',dependenciesRoot:'/deps',recipes:[{...entry,source_commit:'d'.repeat(40)},entry]});
  const body={execution_id:randomUUID(),scope:{installation_id:'synthetic',owner_id:'synthetic',investigation_id:randomUUID()},recipe_id:'recipe',recipe_version:'1',source_id:'source',source_commit:entry.source_commit,source_sha256:entry.source_sha256,source_tree_sha256:entry.source_tree_sha256,oracle,oracle_sha256:hash(oracle),fixture_ref:'fixture'};
  const spec=b=>({...b,spec_sha256:hash(b),deadline_at:new Date(Date.now()+10000).toISOString()});
  await assert.rejects(runner.start(spec(body)),e=>e.code==='RECIPE_INTEGRITY');
  const altered={...body,execution_id:randomUUID(),oracle:{...oracle,expected:'rejected'}};altered.oracle_sha256=hash(altered.oracle);
  await assert.rejects(runner.start(spec(altered)),e=>e.code==='RECIPE_NOT_ALLOWED');
  await assert.rejects(runner.start(spec({...body,execution_id:randomUUID(),source_commit:'e'.repeat(40)})),e=>e.code==='RECIPE_NOT_ALLOWED');
 }finally{await rm(dir,{recursive:true,force:true});}
});
