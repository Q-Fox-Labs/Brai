// ABOUTME: Проверяет настоящий runner и namespaces без модели или рабочей БД.
// ABOUTME: Собственные synthetic files и UUID позволяют проверить квитанцию и потерянный ACK.
import test from "node:test";
import assert from "node:assert/strict";
import {mkdir,mkdtemp,writeFile,realpath,rm} from "node:fs/promises";
import {readFileSync} from "node:fs";
import {dirname,join} from "node:path";
import {fileURLToPath} from "node:url";
import {randomUUID} from "node:crypto";
import {createRunner,treeDigest,fileDigest} from "../../dist/verification-runner.js";
import {verificationHash as hash} from "../../dist/verification-store.js";
test("physical runner receipt, lost ACK, owner boundary and tombstone",{timeout:15000},async()=>{
 const root=fileURLToPath(new URL("../../../../tmp/",import.meta.url));await mkdir(root,{recursive:true});const dir=await mkdtemp(join(root,"runner-proof-"));
 const source=join(dir,"source");await mkdir(join(source,"fixtures"),{recursive:true});
 const impl='export const evaluate = value => value > 0 ? "accepted" : "rejected";\n',fixture=JSON.stringify({module:"index.mjs",input:0});
 await writeFile(join(source,"index.mjs"),impl);await writeFile(join(source,"fixtures/zero.json"),fixture);
 const harness=fileURLToPath(new URL("../../recipes/regression.mjs",import.meta.url)),node=await realpath(process.execPath),stateRoot=join(dir,"state");await mkdir(stateRoot);
 const deps=join(dir,"deps");await mkdir(deps);const source_tree_sha256=await treeDigest(source);
 const config={socket:join(dir,"unused.sock"),stateRoot,node,nodeRoot:dirname(dirname(node)),dependenciesRoot:deps,dependencies_sha256:await treeDigest(deps),node_sha256:await fileDigest(node),recipes:[{id:"regression",version:"1",harness,harness_sha256:hash(readFileSync(harness,"utf8")),source_root:source,source_file:"index.mjs",source_commit:"a".repeat(40),source_sha256:hash(impl),source_tree_sha256,fixture_refs:["zero"],fixture_sha256:{zero:hash(fixture)}}]};
 const diagnostics=[],runner=createRunner(config,e=>diagnostics.push(e));
 const scope={installation_id:"synthetic",owner_id:"synthetic",investigation_id:randomUUID()},oracle={requirement_id:randomUUID(),requirement_sha256:"b".repeat(64),expected:"accepted",version:"fixture",confirms_claim:"Zero rejected"};
 const body={execution_id:randomUUID(),scope,recipe_id:"regression",recipe_version:"1",source_id:"fixture",source_commit:"a".repeat(40),source_sha256:hash(impl),source_tree_sha256,oracle,oracle_sha256:hash(oracle),fixture_ref:"zero"};
 const spec={...body,spec_sha256:hash(body),deadline_at:new Date(Date.now()+10000).toISOString()};
 try{
  await runner.prepare(spec);await runner.start(spec);
  let receipt;for(let n=0;n<200;n++){receipt=await runner.get(scope,spec.execution_id);if(receipt?.finished_at)break;await new Promise(r=>setTimeout(r,25));}
  assert.equal(receipt.state,"completed",JSON.stringify(diagnostics));assert.equal(receipt.outcome,"reproduced");assert.equal(receipt.cleanup,"done");assert.equal(receipt.assertions[0].actual,"rejected");
  assert.deepEqual(await runner.start(spec),receipt);
  await writeFile(join(source,"helper.mjs"),"changed sibling");
  const changed={...body,execution_id:randomUUID()};await assert.rejects(runner.start({...changed,spec_sha256:hash(changed),deadline_at:spec.deadline_at}),e=>e.code==="INPUT_TREE_INTEGRITY");
  const restarted=createRunner(config);assert.deepEqual(await restarted.get(scope,spec.execution_id),receipt);
  await assert.rejects(restarted.get({...scope,owner_id:"foreign"},spec.execution_id),e=>e.code==="NOT_FOUND");
  await assert.rejects(runner.start({...spec,fixture_ref:"other"}),e=>e.code==="IDEMPOTENCY_CONFLICT");
 }finally{await runner.cancel(scope,spec.execution_id).catch(()=>{});await rm(dir,{recursive:true,force:true});}
});
