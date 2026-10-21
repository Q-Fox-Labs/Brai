// ABOUTME: Проверяет bounded GET retry и повторное чтение immutable source без сети и процессов.
// ABOUTME: Transport doubles не подтверждают реальные GitHub/GHCR результаты.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createGitHub} from '../src/github.mjs';
import {recipeFiles} from '../src/ci-verifier.mjs';
const project={github:{repository:'fixture/repository'}},sha='a'.repeat(40);
const failure=stderr=>({code:1,stdout:'',stderr});
test('transient GET retries once within its original total budget',async t=>{
  for(const stderr of ['net/http: TLS handshake timeout','ECONNRESET','gh: Bad Gateway (HTTP 502)','HTTP 503','HTTP 504'])await t.test(stderr,async t=>{
    let now=1000; t.mock.method(Date,'now',()=>now);
    const calls=[],adapter=createGitHub({run:async(_exe,args,options)=>{
      calls.push({args,options});now+=99000;
      return calls.length===1?failure(stderr):{code:0,stdout:'{"number":7}'};
    }});
    assert.deepEqual(await adapter.get(project,7),{number:7});assert.equal(calls.length,2);
    assert.deepEqual(calls[0].args,calls[1].args);
    assert.equal(calls[0].options.allowFailure,true);
    assert.equal(calls[0].options.timeout,120000);assert.equal(calls[1].options.timeout,21000);
  });
});
test('nontransient HTTP, certificate and invalid JSON failures never retry',async t=>{
  for(const stderr of ['HTTP 403: i/o timeout','HTTP 401','HTTP 404','HTTP 429','x509: certificate has expired'])await t.test(stderr,async()=>{
    let calls=0;const adapter=createGitHub({run:async()=>{calls++;return failure(stderr);}});
    await assert.rejects(adapter.get(project,7),{code:'GITHUB_UNAVAILABLE'});assert.equal(calls,1);
  });
  let calls=0;const adapter=createGitHub({run:async()=>{calls++;return {code:0,stdout:'not JSON'};}});
  await assert.rejects(adapter.get(project,7),{code:'GITHUB_UNAVAILABLE'});assert.equal(calls,1);
});
test('failed GET has at most two attempts and never renews an exhausted budget',async t=>{
  let calls=0;const adapter=createGitHub({run:async()=>{calls++;return failure('TLS handshake timeout');}});
  await assert.rejects(adapter.get(project,7),{code:'GITHUB_UNAVAILABLE'});assert.equal(calls,2);
  let now=1000;t.mock.method(Date,'now',()=>now);calls=0;
  const expired=createGitHub({run:async()=>{calls++;now+=120000;return failure('TLS handshake timeout');}});
  await assert.rejects(expired.get(project,7),{code:'GITHUB_UNAVAILABLE'});assert.equal(calls,1);
});
test('write and authentication failures remain single attempts',async()=>{
  let calls=0;const write=createGitHub({run:async(_exe,args,options)=>{
    calls++;assert.equal(args[2],'POST');assert.equal(options.allowFailure,undefined);throw Error('TLS handshake timeout');
  }});
  await assert.rejects(write.create(project,{branch:'feature',target:'dev'},'body'),{code:'GITHUB_UNAVAILABLE'});assert.equal(calls,1);
  let auth=0;const adapter=createGitHub({run:async(_exe,args)=>{
    if(args[0]==='auth'){auth++;throw Error('TLS handshake timeout');}
    return {code:0,stdout:JSON.stringify({total_count:1,check_runs:[{name:'check',app:{id:42},head_sha:sha,status:'completed',conclusion:'success'}]})};
  }});
  const rows=await adapter.checks({github:{...project.github,ci:{check_name:'check',app_id:42}}},sha);
  assert.equal(auth,1);assert.equal(rows[0].ci_state,'CI_VERIFICATION_UNAVAILABLE');
});
test('same-SHA contents are read once per verification while run/check identity stays fresh',async()=>{
  const root=new URL('../../../',import.meta.url),workflow='.github/workflows/codeworks.yml',calls=[];
  const check={id:17,name:'check',app:{id:42},head_sha:sha,status:'completed',conclusion:'success',details_url:'https://github.com/fixture/repository/actions/runs/123/job/9'};
  const run={head_sha:sha,path:workflow,event:'push',status:'completed',conclusion:'success',run_attempt:1,repository:{full_name:project.github.repository}};
  const job={name:'check',head_sha:sha,status:'completed',conclusion:'success',labels:['ubuntu-24.04'],check_run_url:'https://api.github.com/repos/fixture/repository/check-runs/17'};
  const pinned={github:{...project.github,ci:{check_name:'check',app_id:42,workflow_sha256:createHash('sha256').update(readFileSync(new URL(workflow,root))).digest('hex'),recipe_sha256:'0'.repeat(64)}}};
  const adapter=createGitHub({registryFactory:()=>({}),run:async(_exe,args)=>{
    if(args[0]==='auth')return {code:0,stdout:'fixture'};
    const endpoint=args.at(-1).slice('repos/fixture/repository/'.length);calls.push(endpoint);
    let value;
    if(endpoint.startsWith('contents/'))value={encoding:'base64',content:readFileSync(fileURLToPath(new URL(endpoint.slice(9).split('?')[0],root))).toString('base64')};
    else if(endpoint.startsWith('commits/'))value={total_count:1,check_runs:[check]};
    else if(endpoint.includes('/jobs?'))value={total_count:1,jobs:[job]};
    else value=run;
    return {code:0,stdout:JSON.stringify(value)};
  }});
  for(let i=0;i<2;i++)assert.equal((await adapter.checks(pinned,sha))[0].ci_state,'CI_RECIPE_UNTRUSTED');
  assert.equal(calls.filter(c=>c===`contents/${workflow}?ref=${sha}`).length,2);
  assert.equal(calls.filter(c=>c.startsWith('contents/')).length,recipeFiles.length*2);
  assert.equal(calls.filter(c=>c.startsWith('commits/')).length,2);
  assert.equal(calls.filter(c=>c==='actions/runs/123').length,2);
  assert.equal(calls.filter(c=>c.includes('/jobs?')).length,2);
});
