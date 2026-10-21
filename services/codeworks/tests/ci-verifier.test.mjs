// ABOUTME: Проверяет недоверенные CI labels, точные run/job/recipe и immutable run-bound digest proof.
// ABOUTME: GitHub/GHCR здесь явные doubles; реальную публикацию эта suite не подтверждает.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,generateKeyPairSync} from 'node:crypto';
import {signCatalog} from '../ci/catalog.mjs';
import {verifyCI,recipeFiles,downloadProof} from '../src/ci-verifier.mjs';
import {digestFiles} from '../components/graph.mjs';
import {createGitHub} from '../src/github.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..'),workflow='.github/workflows/codeworks.yml';
const hash=value=>createHash('sha256').update(value).digest('hex');
function fixture() {
  const repository='fixture/repository',sha='a'.repeat(40),runId='123',digest='sha256:'+'b'.repeat(64),artifactDigest='sha256:'+'c'.repeat(64),checkDigest='sha256:'+'d'.repeat(64),recipe=digestFiles(root,recipeFiles);
  const project={github:{repository,ci:{check_name:'Codeworks components',app_id:42,workflow_sha256:hash(readFileSync(resolve(root,workflow))),recipe_sha256:recipe}}};
  const check={id:17,name:'Codeworks components',app:{id:42},head_sha:sha,status:'completed',conclusion:'success',details_url:`https://github.com/${repository}/actions/runs/${runId}/job/9`};
  const run={head_sha:sha,path:workflow,event:'push',status:'completed',conclusion:'success',run_attempt:1,repository:{full_name:repository}};
  const job={id:9,name:check.name,head_sha:sha,status:'completed',conclusion:'success',labels:['ubuntu-24.04'],check_run_url:`https://api.github.com/repos/${repository}/check-runs/17`};
  const meta=(kind,key)=>({format:'brai-ci-object-v1',repository,source:sha,runId,attempt:'1',recipe,kind,key});
  const objects={release:{reference:`ghcr.io/${repository}-components/release@${digest}`,digest,metadata:meta('composition','key')},artifact:{digest:artifactDigest,reference:`ghcr.io/${repository}-components/probe@${artifactDigest}`,metadata:meta('runtime','1'.repeat(64))},check:{digest:checkDigest,reference:`ghcr.io/${repository}-components/probe@${checkDigest}`,metadata:meta('check','2'.repeat(64))}};
  const composition={format:'brai-release-composition-v1',repository,source:sha,runId,attempt:'1',workflow,recipe,billing:{state:'hard-stop-confirmed'},components:[{id:'probe',keys:{artifact:'1'.repeat(64),checks:'2'.repeat(64)},artifact:objects.artifact,check:objects.check}]};
  const proof={published:structuredClone(objects.release),composition:structuredClone(composition)};
  const artifact={id:5,name:'codeworks-proof-123-1',expired:false,digest:'sha256:'+'e'.repeat(64),size_in_bytes:1000,workflow_run:{id:123,head_sha:sha}};
  const f={project,sha,check,run,job,objects,composition,proof,artifact,alterFile:false,annotations:[]};
  const api=async endpoint=>{
    if(endpoint.startsWith('contents/')) {
      const path=endpoint.slice('contents/'.length).split('?')[0];
      const content=readFileSync(resolve(root,path));return {encoding:'base64',content:(f.alterFile&&path.endsWith('pipeline.mjs')?Buffer.from('changed recipe'):content).toString('base64')};
    }
    if(endpoint.includes('/annotations?'))return structuredClone(f.annotations);
    if(endpoint.includes('/jobs?'))return {total_count:1,jobs:[structuredClone(f.job)]};
    if(endpoint.includes('/artifacts?'))return {total_count:1,artifacts:[structuredClone(f.artifact)]};
    if(endpoint.startsWith('actions/runs/'))return structuredClone(f.run);
    throw Error('UNEXPECTED_API: '+endpoint);
  };
  const registry={lookup:async(id,ref)=>structuredClone(id==='release'?f.objects.release:ref===artifactDigest?f.objects.artifact:f.objects.check),readJSON:async()=>structuredClone(f.composition)};
  f.ports={api,registry,readProof:async()=>structuredClone(f.proof)};
  f.verify=()=>verifyCI(f.project,f.sha,[f.check],f.ports);return f;
}
test('exact successful workflow, job, source recipe and run-bound GHCR digests produce owner evidence',async()=>{
  const f=fixture(),result=await f.verify();assert.equal(result.verified,true);assert.equal(result.evidence.head_sha,f.sha);assert.equal(result.evidence.composition_digest,f.objects.release.digest);assert.equal(result.evidence.run_id,'123');
});
test('wrong check, workflow, runner, head, repository or immutable composition cannot pass',async t=>{
  const cases={
    app:f=>f.check.app.id++,head:f=>f.check.head_sha='f'.repeat(40),pending:f=>f.check.status='in_progress',failed:f=>f.check.conclusion='failure',
    run:f=>f.run.head_sha='f'.repeat(40),repository:f=>f.run.repository.full_name='foreign/repository',workflow:f=>f.run.path='foreign.yml',event:f=>f.run.event='pull_request',
    runner:f=>f.job.labels=['self-hosted'],job:f=>f.job.check_run_url+='0',recipe:f=>f.alterFile=true,
    label:f=>f.objects.release.metadata.runId='999',composition:f=>f.composition.source='f'.repeat(40),digest:f=>f.proof.published.digest='sha256:'+'9'.repeat(64),
    payload:f=>f.objects.artifact.metadata.key='foreign-key',proof:f=>f.proof.composition.components[0].artifact.digest='sha256:'+'9'.repeat(64),
  };
  for(const [name,alter]of Object.entries(cases))await t.test(name,async()=>{const f=fixture();alter(f);assert.equal((await f.verify()).verified,false);});
});
test('billing failure remains an explicit blocked CI state without installed evidence',async()=>{
  const f=fixture();f.check.conclusion='failure';f.annotations=[{message:'The job was not started because spending limit was reached.'}];
  assert.deepEqual(await f.verify(),{verified:false,state:'CI_BILLING_BLOCKED'});
});
test('missing or expired mandatory digest proof fails closed; registry labels alone are insufficient',async()=>{
  const f=fixture();f.artifact.expired=true;await assert.rejects(f.verify(),/CI_PROOF_IDENTITY/);
});
test('GitHub adapter exposes unavailable verifier as awaiting CI, never a successful check',async()=>{
  const f=fixture();f.project.github.required_checks=[{name:'Codeworks components',app_id:42}];
  const adapter=createGitHub({run:async(_exe,args)=>{
    if(args[0]==='auth')throw Error('auth unavailable');
    return {stdout:JSON.stringify({total_count:1,check_runs:[f.check]})};
  }});
  const rows=await adapter.checks(f.project,f.sha);assert.equal(rows[0].conclusion,null);assert.equal(rows[0].ci_state,'CI_VERIFICATION_UNAVAILABLE');assert.equal(rows[0].ci_verified,false);
});
function zip(content) {
  const name=Buffer.from('ci-result.json'),data=Buffer.from(JSON.stringify(content));
  const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50);local.writeUInt32LE(data.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(name.length,26);
  const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50);central.writeUInt32LE(data.length,20);central.writeUInt32LE(data.length,24);central.writeUInt16LE(name.length,28);
  return Buffer.concat([local,name,data,central,name,Buffer.alloc(22)]);
}
test('proof download checks immutable archive digest before parsing one bounded JSON',async()=>{
  const bytes=zip({composition:{source:'exact'}}),artifact={id:3,digest:'sha256:'+hash(bytes),size_in_bytes:bytes.length};
  const fetcher=async()=>({ok:true,arrayBuffer:async()=>bytes});
  assert.deepEqual(await downloadProof({repository:'fixture/repository',token:'fixture'},artifact,{fetcher}),{composition:{source:'exact'}});
  await assert.rejects(downloadProof({repository:'fixture/repository',token:'fixture'},{...artifact,digest:'sha256:'+'0'.repeat(64)},{fetcher}),/CI_PROOF_DIGEST_MISMATCH/);
});


test('durable owner proof survives Actions artifact expiry, preserving the exact digest',async()=>{
  const f=fixture();let saved;
  f.ports.saveVerified=async proof=>{saved=structuredClone(proof);};
  assert.equal((await f.verify()).verified,true);
  f.artifact.expired=true;f.ports.readProof=async()=>{throw Error('expired transport');};
  f.ports.readVerified=async()=>saved;
  assert.equal((await f.verify()).verified,true);
  saved.published.digest='sha256:'+'0'.repeat(64);
  assert.equal((await f.verify()).verified,false);
});

test('owner-pinned signed catalog verifies reused digests and rejects a substituted transport key',async()=>{
  const f=fixture(),{privateKey,publicKey}=generateKeyPairSync('ed25519');
  f.project.github.ci.reuse_public_key=publicKey.export({type:'spki',format:'pem'});
  const entries=['artifact','check'].map(kind=>({id:'probe',digest:f.objects[kind].digest,...Object.fromEntries(['repository','recipe','kind','key','source','runId','attempt'].map(k=>[k,f.objects[kind].metadata[k]]))}));
  const doc=signCatalog({format:'brai-verified-ci-catalog-v1',repository:f.project.github.repository,recipe:f.project.github.ci.recipe_sha256,entries},privateKey);
  const digest='sha256:'+'f'.repeat(64);
  f.composition.reuseCatalog={digest,reference:`ghcr.io/${f.project.github.repository}-components/catalog@${digest}`};
  f.proof.composition=structuredClone(f.composition);
  f.ports.registry.readJSON=async id=>structuredClone(id==='catalog'?doc:f.composition);
  assert.equal((await f.verify()).verified,true);
  const foreign=generateKeyPairSync('ed25519');
  f.ports.registry.readJSON=async id=>id==='catalog'?signCatalog(doc.catalog,foreign.privateKey):structuredClone(f.composition);
  assert.equal((await f.verify()).state,'CI_CATALOG_UNTRUSTED');
});
