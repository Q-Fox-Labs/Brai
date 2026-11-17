// ABOUTME: Проверяет реальный prepared reviewer recipe в физическом runner без БД и модели.
// ABOUTME: Не монтирует Git и не изменяет принятые файлы каталога; повреждение проверяет на копии.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {cp,mkdir,mkdtemp,writeFile,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,isAbsolute,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createRunner,treeDigest,fileDigest} from '../../dist/verification-runner.js';
import {verificationHash as hash} from '../../dist/verification-store.js';
const path=process.env.BUG_HUNT_RECIPE_REGISTRY,deps=process.env.BUG_HUNT_RECIPE_DEPENDENCIES_ROOT;
assert.ok(path&&isAbsolute(path),'BUG_HUNT_RECIPE_REGISTRY is required');
assert.ok(deps&&isAbsolute(deps),'BUG_HUNT_RECIPE_DEPENDENCIES_ROOT is required');
const registry=JSON.parse(readFileSync(path,'utf8'));

test('physical runner binds actual compiled reviewer and preserves tombstone',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'runner-real-proof-'));
 const node=await realpath(process.execPath),stateRoot=join(dir,'state');await mkdir(stateRoot);
 const template=registry.recipes.find(r=>r.ref==='reviewer-baseline');assert.ok(template);
 const binding=registry.runnerRecipes.find(r=>r.id===template.recipe_id&&r.source_commit===template.source_commit&&r.source_tree_sha256===template.source_tree_sha256);assert.ok(binding);
 const config={socket:join(dir,'unused.sock'),stateRoot,node,nodeRoot:dirname(dirname(node)),dependenciesRoot:deps,dependencies_sha256:await treeDigest(deps,2147483648),node_sha256:await fileDigest(node),recipes:[...registry.runnerRecipes].reverse()};
 const diagnostics=[],runner=createRunner(config,e=>diagnostics.push({exit_code:e.exit_code}));
 const scope={installation_id:'synthetic',owner_id:'synthetic',investigation_id:randomUUID()},oracle={requirement_id:randomUUID(),...binding.oracle};
 const body={execution_id:randomUUID(),scope,recipe_id:binding.id,recipe_version:binding.version,source_id:binding.source_id,source_commit:binding.source_commit,source_sha256:binding.source_sha256,source_tree_sha256:binding.source_tree_sha256,oracle,oracle_sha256:hash(oracle),fixture_ref:binding.fixture_refs[0]};
 const make=b=>({...b,spec_sha256:hash(b),deadline_at:new Date(Date.now()+120000).toISOString()});
 const spec=make(body);
 try{
  const mismatch={...body,execution_id:randomUUID(),source_commit:'f'.repeat(40)};
  await assert.rejects(runner.start(make(mismatch)),e=>e.code==='RECIPE_NOT_ALLOWED');
  const badOracle={...body,execution_id:randomUUID(),oracle:{...oracle,expected:'unrelated'}};badOracle.oracle_sha256=hash(badOracle.oracle);
  await assert.rejects(runner.start(make(badOracle)),e=>e.code==='RECIPE_NOT_ALLOWED');
  await runner.prepare(spec);await runner.start(spec);
  let receipt;do{await new Promise(r=>setTimeout(r,25));receipt=await runner.get(scope,spec.execution_id);}while(!receipt?.finished_at);
  assert.equal(receipt.state,'completed',JSON.stringify(diagnostics));assert.equal(receipt.outcome,'reproduced');assert.equal(receipt.cleanup,'done');assert.equal(receipt.assertions[0].actual,'non-reviewer');
  assert.deepEqual(await runner.start(spec),receipt);
  const source=join(dir,'source-copy');await cp(binding.source_root,source,{recursive:true});await writeFile(join(source,'unexpected.mjs'),'changed sibling');
  const altered=createRunner({...config,recipes:[{...binding,source_root:source}]});
  await assert.rejects(altered.start(make({...body,execution_id:randomUUID()})),e=>e.code==='INPUT_TREE_INTEGRITY');
  const restarted=createRunner(config);assert.deepEqual(await restarted.get(scope,spec.execution_id),receipt);
  await assert.rejects(restarted.get({...scope,owner_id:'foreign'},spec.execution_id),e=>e.code==='NOT_FOUND');
  await assert.rejects(runner.start({...spec,fixture_ref:'other'}),e=>e.code==='IDEMPOTENCY_CONFLICT');
 }finally{await runner.cancel(scope,spec.execution_id).catch(()=>{});await rm(dir,{recursive:true,force:true});}
});
