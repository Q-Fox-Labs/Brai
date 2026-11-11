// ABOUTME: Проверяет недоверенные CI labels, точные run/job/recipe и immutable run-bound digest proof.
// ABOUTME: GitHub/GHCR здесь явные doubles; реальную публикацию эта suite не подтверждает.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,generateKeyPairSync} from 'node:crypto';
import {signCatalog} from '../ci/catalog.mjs';
import {verifyCI,recipeFiles,downloadProof,loadRunProof} from '../src/ci-verifier.mjs';
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
  const f=fixture();f.artifact.expired=true;await assert.rejects(f.verify(),/CI_PROOF_UNAVAILABLE/);
});
test('absent or expired cache proof is unavailable, while foreign or duplicate proof fails identity',async()=>{
  const f=fixture(),readProof=async()=>f.proof;
  for(const artifacts of [[],[{...f.artifact,expired:true}]])await assert.rejects(loadRunProof(async()=>({total_count:artifacts.length,artifacts}),readProof,'123',1,f.sha),/CI_PROOF_UNAVAILABLE/);
  for(const artifacts of [[f.artifact,f.artifact],[{...f.artifact,workflow_run:{id:124,head_sha:f.sha}}]])await assert.rejects(loadRunProof(async()=>({total_count:artifacts.length,artifacts}),readProof,'123',1,f.sha),/CI_PROOF_IDENTITY_MISMATCH/);
});
test('GitHub adapter exposes unavailable verifier as awaiting CI, never a successful check',async()=>{
  const f=fixture();f.project.github.required_checks=[{name:'Codeworks components',app_id:42}];
  const adapter=createGitHub({run:async(_exe,args)=>{
    if(args[0]==='auth')throw Error('auth unavailable');
    return {stdout:JSON.stringify({total_count:1,check_runs:[f.check]})};
  }});
  const rows=await adapter.checks(f.project,f.sha);assert.equal(rows[0].conclusion,null);assert.equal(rows[0].ci_state,'CI_VERIFICATION_UNAVAILABLE');assert.equal(rows[0].ci_verified,false);
});
test('separate canonical push suites select the latest exact run and immutable proof, never an older success',async t=>{
  for(const state of ['success','queued','failure','wrong-workflow','same-run','duplicate-id','wrong-url','wrong-job','wrong-digest'])await t.test(state,async()=>{
    const f=fixture(),older={...f.check,id:16,details_url:f.check.details_url.replace('/123/','/122/'),conclusion:'failure'};
    let checks=[older,f.check];
    if(['queued','failure','wrong-workflow'].includes(state))checks.push({...f.check,id:18,details_url:f.check.details_url.replace('/123/','/124/'),status:state==='queued'?'queued':'completed',conclusion:state==='queued'?null:state==='failure'?'failure':'success'});
    if(state==='same-run')older.details_url=f.check.details_url;
    if(state==='duplicate-id')older.id=f.check.id;
    if(state==='wrong-url')older.details_url='https://foreign.invalid/run/122';
    if(state==='wrong-job')f.job.check_run_url+='0';
    if(state==='wrong-digest')f.proof.published.digest='sha256:'+'9'.repeat(64);
    const reads=[],adapter=createGitHub({registryFactory:()=>f.ports.registry,evidenceStore:{read:async(_project,id,attempt)=>{reads.push([id,attempt]);return f.proof;},save:async()=>{}},run:async(_exe,args)=>{
      if(args[0]==='auth')return {stdout:'fixture'};
      const endpoint=args.at(-1).slice(('repos/'+f.project.github.repository+'/').length);
      let value;
      if(endpoint.startsWith('commits/'))value={total_count:checks.length,check_runs:checks};
      else if(/^actions\/runs\/\d+$/.test(endpoint)){const id=Number(endpoint.split('/').at(-1));value={...f.run,id,...(id===124&&state==='wrong-workflow'?{path:'foreign.yml'}:{})};}
      else value=await f.ports.api(endpoint);
      return {stdout:JSON.stringify(value)};
    }});
    const rows=await adapter.checks(f.project,f.sha);
    if(state==='success'){
      assert.equal(rows.length,1);assert.equal(rows[0].ci_verified,true);assert.equal(rows[0].ci_evidence.run_id,'123');assert.equal(rows[0].ci_evidence.composition_digest,f.objects.release.digest);assert.deepEqual(reads,[['123',1]]);
    }else{
      assert(rows.every(row=>!row.ci_verified));
      if(['queued','failure'].includes(state)){assert.equal(rows.length,1);assert.equal(rows[0].ci_state,'EXACT_CI_SUCCESS_REQUIRED');assert.deepEqual(reads,[]);}
      if(['wrong-workflow','same-run','duplicate-id','wrong-url'].includes(state))assert(rows.every(row=>row.ci_state==='EXACT_CI_CHECK_REQUIRED'));
    }
  });
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
  f.composition.reuseCatalog={digest,reference:`ghcr.io/${f.project.github.repository}-components/catalog-v1@${digest}`};
  f.proof.composition=structuredClone(f.composition);
  f.ports.registry.readJSON=async id=>structuredClone(id==='catalog-v1'?doc:f.composition);
  assert.equal((await f.verify()).verified,true);
  const foreign=generateKeyPairSync('ed25519');
  f.ports.registry.readJSON=async id=>id==='catalog-v1'?signCatalog(doc.catalog,foreign.privateKey):structuredClone(f.composition);
  assert.equal((await f.verify()).state,'CI_CATALOG_UNTRUSTED');
});


test('repeated gates reuse immutable reads but re-read live CI and reject a new failed attempt',async()=>{
  const f=fixture(),counts={contents:0,objects:0,checks:0,runs:0};let saved=structuredClone(f.proof);
  let transient=true;
  const adapter=createGitHub({evidenceStore:{read:async()=>saved,save:async(_p,proof)=>{saved=structuredClone(proof);}},registryFactory:()=>({
    ...f.ports.registry,lookup:async(id,ref)=>{if(ref.startsWith('sha256:')){counts.objects++;if(transient){transient=false;throw Error('temporary read failure');}}return f.ports.registry.lookup(id,ref);},
  }),run:async(_exe,args)=>{
    if(args[0]==='auth')return {stdout:'fixture'};
    const endpoint=args.at(-1).slice(('repos/'+f.project.github.repository+'/').length);
    if(endpoint.startsWith('commits/')){counts.checks++;return {stdout:JSON.stringify({total_count:1,check_runs:[f.check]})};}
    if(endpoint.startsWith('contents/'))counts.contents++;
    if(endpoint.startsWith('actions/runs/'))counts.runs++;
    return {stdout:JSON.stringify(await f.ports.api(endpoint))};
  }});
  assert.equal((await adapter.checks(f.project,f.sha))[0].ci_verified,false);
  assert.equal((await adapter.checks(f.project,f.sha))[0].ci_verified,true);
  const cold={...counts};assert.equal(cold.contents,0);assert(cold.objects>0);
  assert.equal((await adapter.checks(f.project,f.sha))[0].ci_verified,true);
  assert.equal(counts.contents,cold.contents);assert.equal(counts.objects,cold.objects);
  assert.equal(counts.checks,3);assert(counts.runs>cold.runs);
  f.check.status='queued';f.check.conclusion=null;
  assert.equal((await adapter.checks(f.project,f.sha))[0].ci_verified,false);
  f.check.status='completed';f.check.conclusion='failure';
  assert.equal((await adapter.checks(f.project,f.sha))[0].ci_verified,false);
  f.check.conclusion='success';f.run.run_attempt=2;
  assert.equal((await adapter.checks(f.project,f.sha))[0].ci_verified,false);
  f.run.run_attempt=1;f.project.github.ci.recipe_sha256='0'.repeat(64);
  assert.equal((await adapter.checks(f.project,f.sha))[0].ci_verified,false);
});

test('activity cancellation propagates instead of becoming unavailable CI',async()=>{
  const {withExecutionContext}=await import('../src/execution-context.mjs');
  const f=fixture(),controller=new AbortController(),reason=Error('activity deadline');
  const adapter=createGitHub({run:async(_exe,args)=>{
    if(args[0]==='auth'){controller.abort(reason);throw reason;}
    return {stdout:JSON.stringify({total_count:1,check_runs:[f.check]})};
  }});
  await assert.rejects(withExecutionContext({signal:controller.signal},()=>adapter.checks(f.project,f.sha)),error=>error===reason);
});

function multiSourceFixture() {
  const f=fixture(),origins=new Map(),objects=new Map();
  f.composition.components=Array.from({length:10},(_,i)=>{
    const id='probe-'+i,source=(i+1).toString(16).padStart(40,'0'),runId=String(200+i);
    const component={id,keys:{artifact:'1'.repeat(64),checks:'2'.repeat(64)}};
    for(const kind of ['artifact','check']) {
      const object=structuredClone(f.objects[kind]);
      object.digest='sha256:'+(2*i+(kind==='artifact'?1:2)).toString(16).padStart(64,'0');
      object.reference='ghcr.io/'+f.project.github.repository+'-components/'+id+'@'+object.digest;
      Object.assign(object.metadata,{source,runId});
      component[kind]=object;objects.set(id+'/'+object.digest,object);
    }
    const proof={composition:{...structuredClone(f.composition),source,runId,components:[structuredClone(component)]}};
    origins.set(runId,{source,proof});return component;
  });
  f.proof.composition=structuredClone(f.composition);
  const api=f.ports.api;
  f.ports.api=async endpoint=>{
    const id=endpoint.match(/^actions\/runs\/(\d+)\//)?.[1],origin=origins.get(id);
    if(origin&&endpoint.includes('/attempts/'))return {...structuredClone(f.run),head_sha:origin.source};
    return api(endpoint);
  };
  f.ports.registry.lookup=async(id,ref)=>structuredClone(id==='release'?f.objects.release:objects.get(id+'/'+ref));
  f.origins=origins;return f;
}

test('fresh adapters reuse durable recipes for ten sources while checking every origin live',async t=>{
  const f=multiSourceFixture(),records=new Map();let calls=[];
  const key=(p,id,attempt)=>JSON.stringify([p.github.repository,p.github.ci,String(id),String(attempt)]);
  const store={
    read:async(p,id,attempt)=>structuredClone(records.get(key(p,id,attempt))??null),
    save:async(p,proof)=>records.set(key(p,proof.composition.runId,proof.composition.attempt),structuredClone(proof)),
  };
  for(const [id,origin]of f.origins)records.set(key(f.project,id,1),origin.proof);
  f.ports.readVerified=(id,attempt)=>store.read(f.project,id,attempt);
  f.ports.saveVerified=proof=>store.save(f.project,proof);
  const api=f.ports.api;f.ports.api=async endpoint=>{calls.push(endpoint);return api(endpoint);};
  assert.equal((await f.verify()).state,'CI_VERIFIED');
  assert.equal(calls.filter(c=>c.startsWith('contents/')).length,recipeFiles.length*11+1);
  const pass=async()=>{
    calls=[];
    const adapter=createGitHub({evidenceStore:store,registryFactory:()=>f.ports.registry,run:async(_exe,args)=>{
      if(args[0]==='auth')return {stdout:'fixture'};
      const endpoint=args.at(-1).slice(('repos/'+f.project.github.repository+'/').length);
      if(endpoint.startsWith('commits/')){calls.push(endpoint);return {stdout:JSON.stringify({total_count:1,check_runs:[f.check]})};}
      return {stdout:JSON.stringify(await f.ports.api(endpoint))};
    }});
    return (await adapter.checks(f.project,f.sha))[0];
  };
  for(let i=0;i<3;i++) {
    assert.equal((await pass()).ci_verified,true);
    assert.equal(calls.filter(c=>c.startsWith('contents/')).length,0,'new adapter must reuse verified recipes');
    assert.equal(calls.filter(c=>c.startsWith('commits/')).length,1);
    assert.equal(calls.filter(c=>/^actions\/runs\/\d+\/attempts\/1$/.test(c)).length,10);
    assert.equal(calls.filter(c=>c.includes('/jobs?')).length,1);
  }
  assert.equal(calls.length,13);
  t.diagnostic('Ten reused sources, fresh adapter: 13 live GitHub GETs; 143 repeated recipe GETs removed.');
  f.origins.get('200').source='f'.repeat(40);
  assert.equal((await pass()).ci_state,'CI_REUSE_ORIGIN_UNVERIFIED');
  f.origins.get('200').source='1'.padStart(40,'0');
  f.proof.composition.components[0].artifact.digest='sha256:'+'9'.repeat(64);
  records.set(key(f.project,'123',1),structuredClone(f.proof));
  assert.equal((await pass()).ci_state,'CI_RUN_DIGEST_MISMATCH');
});

test('full policy change or a new attempt invalidates durable recipe reuse',async()=>{
  const f=fixture(),records=new Map(),calls=[];
  const key=(p,id,attempt)=>JSON.stringify([p.github.repository,p.github.ci,String(id),String(attempt)]);
  f.ports.readVerified=async(id,attempt)=>structuredClone(records.get(key(f.project,id,attempt))??null);
  f.ports.saveVerified=async proof=>records.set(key(f.project,proof.composition.runId,proof.composition.attempt),structuredClone(proof));
  const api=f.ports.api;f.ports.api=async endpoint=>{calls.push(endpoint);return api(endpoint);};
  assert.equal((await f.verify()).verified,true);
  calls.length=0;assert.equal((await f.verify()).verified,true);assert(!calls.some(c=>c.startsWith('contents/')));
  f.project.github.ci.workflow_sha256='0'.repeat(64);
  assert.equal((await f.verify()).state,'CI_WORKFLOW_UNTRUSTED');assert(calls.some(c=>c.startsWith('contents/')));
  f.project.github.ci.workflow_sha256=hash(readFileSync(resolve(root,workflow)));
  f.project.github.ci.recipe_sha256='0'.repeat(64);
  assert.equal((await f.verify()).state,'CI_RECIPE_UNTRUSTED');
  f.project.github.ci.recipe_sha256=digestFiles(root,recipeFiles);
  f.run.run_attempt=2;calls.length=0;
  assert.equal((await f.verify()).state,'CI_COMPOSITION_IDENTITY_MISMATCH');assert(calls.some(c=>c.startsWith('contents/')));
});
