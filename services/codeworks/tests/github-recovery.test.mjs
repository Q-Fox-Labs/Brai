// ABOUTME: Проверяет безопасные классы отказов GitHub и общий устойчивый срок повтора проекта.
// ABOUTME: Команды GitHub подменены; credentials и внешние запросы не используются.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createGitHub} from '../src/github.mjs';
import {Fault,githubFailure,ciFailure} from '../src/errors.mjs';

test('quota, auth, network and invalid proof are distinct without exposing raw response text',()=>{
  const now=Date.parse('2026-11-11T12:00:00Z');
  for(const status of [401,403])assert.equal(githubFailure({status}).code,'GITHUB_AUTH_REQUIRED');
  assert.equal(githubFailure({status:503}).code,'GITHUB_UNAVAILABLE');
  assert.equal(ciFailure(Error('CI_PROOF_DIGEST_MISMATCH')).code,'CI_PROOF_INVALID');
  assert.equal(ciFailure(Error('ECONNRESET')).code,'GITHUB_UNAVAILABLE');
  assert.equal(githubFailure({status:429,headers:{'retry-after':'120'},now}).retryAt,'2026-11-11T12:02:00.000Z');
  assert.equal(githubFailure({status:403,headers:{'x-ratelimit-remaining':'0','x-ratelimit-reset':String(now/1000+300)},now}).retryAt,'2026-11-11T12:05:00.000Z');
  assert.equal(githubFailure({status:403,body:'secondary rate limit',headers:{'retry-after':'Wed, 11 Nov 2026 12:03:00 GMT'},now}).retryAt,'2026-11-11T12:03:00.000Z');
  assert.equal(githubFailure({status:403,body:'secondary rate limit',now}).code,'GITHUB_RATE_LIMITED');
});

test('quota persists across fresh adapters and suppresses every GitHub request until the shared retry time',async()=>{
  const project={id:'fixture',github:{repository:'fixture/repository'}};
  let time=Date.parse('2026-11-11T12:00:00Z'),retry=null,calls=0;
  const evidenceStore={githubRetry:async()=>retry,deferGitHub:async(_p,at)=>{retry={github_retry_at:at};}};
  const run=async()=>{calls++;return calls===1?{code:1,stdout:'HTTP/2.0 429 Too Many Requests\r\nRetry-After: 120\r\n\r\n{"message":"rate limit"}',stderr:'gh: rejected (HTTP 429)'}:{code:0,stdout:'HTTP/2.0 200 OK\r\nContent-Type: application/json\r\n\r\n{"number":1}'};};
  const adapter=()=>createGitHub({run,evidenceStore,now:()=>time});
  await assert.rejects(adapter().get(project,1),{code:'GITHUB_RATE_LIMITED'});
  assert.equal(calls,1);assert.equal(retry.github_retry_at,'2026-11-11T12:02:00.000Z');
  await assert.rejects(adapter().get(project,1),{code:'GITHUB_RATE_LIMITED'});assert.equal(calls,1);
  await assert.rejects(adapter().publishCatalog(project),{code:'GITHUB_RATE_LIMITED'});assert.equal(calls,1);
  time+=120000;
  assert.equal((await adapter().get(project,1)).number,1);assert.equal(calls,2);
});

test('403 limit and authentication failures are never immediately retried; transient reads are bounded',async()=>{
  const project={id:'fixture',github:{repository:'fixture/repository'}};
  for(const [status,body,code]of [[403,'API rate limit exceeded','GITHUB_RATE_LIMITED'],[403,'Resource not accessible','GITHUB_AUTH_REQUIRED'],[401,'Bad credentials','GITHUB_AUTH_REQUIRED'],[503,'Unavailable','GITHUB_UNAVAILABLE']]) {
    let calls=0;
    const adapter=createGitHub({run:async()=>{calls++;return {code:1,stdout:JSON.stringify({message:body}),stderr:'gh: '+body+' (HTTP '+status+')'};}});
    await assert.rejects(adapter.get(project,1),{code});
    assert.equal(calls,status===503?2:1);
  }
});

test('fault DTO marks only technical failures retryable and exposes only a valid retry timestamp',()=>{
  for(const code of ['GITHUB_RATE_LIMITED','GITHUB_UNAVAILABLE','BUSY']){
    const error=new Fault(code);error.retryAt='2026-11-11T12:03:00Z';
    assert.deepEqual(error.dto(),{code,message:code,retryable:true,retry_at:'2026-11-11T12:03:00.000Z'});
    error.retryAt='raw sensitive stderr';assert.equal('retry_at' in error.dto(),false);
    error.retryAt='2026-99-99T00:00:00Z';assert.equal('retry_at' in error.dto(),false);
  }
  for(const code of ['GITHUB_AUTH_REQUIRED','CI_PROOF_INVALID']){
    const error=new Fault(code);error.retryAt='2026-11-11T12:03:00Z';
    assert.deepEqual(error.dto(),{code,message:code,retryable:false});
  }
});
