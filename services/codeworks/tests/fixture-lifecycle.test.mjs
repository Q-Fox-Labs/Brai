// ABOUTME: Воспроизводит отмену node:test wrapper без преждевременного cleanup живого fixture.
// ABOUTME: Управляемые promises проверяют setup/body/worker drain без PostgreSQL, sleeps и installs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixtureLifecycle,fixtureTimeout} from './integration/fixture-lifecycle.mjs';
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};

test('cancelled wrapper cannot clean up while actual setup and body are still active',async()=>{
  const controller=new AbortController(),own=fixtureLifecycle(controller.signal),setup=deferred(),entered=deferred();
  const events=[];let fixture;
  const body=own.run(async()=>{
    entered.resolve();fixture=await setup.promise;events.push('setup-finished');
    await own.run(()=>events.push('forbidden-new-work'));
  });
  const rejected=assert.rejects(body,{name:'AbortError'});
  await entered.promise;controller.abort();
  const cleanup=own.close(()=>{assert.equal(fixture,'owned-fixture');events.push('cleanup');});
  await Promise.resolve();assert.deepEqual(events,[]);
  setup.resolve('owned-fixture');await rejected;await cleanup;
  assert.deepEqual(events,['setup-finished','cleanup']);
});

test('cleanup waits actual child body and worker close after its test wrapper has resolved',async()=>{
  const controller=new AbortController(),own=fixtureLifecycle(controller.signal),workerClosed=deferred(),entered=deferred();
  const events=[];let child;
  await own.run(async()=>{
    child=own.run(async()=>{
      entered.resolve();await own.guard(()=>workerClosed.promise)();
      events.push('forbidden-after-cancel');
    });
    // node:test может завершить wrapper, пока реальная async-функция ещё ждёт worker.
  });
  const rejected=assert.rejects(child,{name:'AbortError'});
  await entered.promise;controller.abort();
  const cleanup=own.close(()=>events.push('cleanup'));
  await Promise.resolve();assert.deepEqual(events,[]);
  assert.throws(()=>own.guard(()=>events.push('forbidden-new-worker'))(),{name:'AbortError'});
  events.push('worker-close');workerClosed.resolve();await rejected;await cleanup;
  assert.deepEqual(events,['worker-close','cleanup']);
});

test('normal completion drains and performs cleanup once, refusing work after closure',async()=>{
  const own=fixtureLifecycle(new AbortController().signal);let cleaned=0;
  assert.equal(await own.port({async work(){return 7;}}).work(),7);
  const first=own.close(()=>cleaned++);assert.equal(own.close(()=>cleaned++),first);await first;
  assert.equal(cleaned,1);assert.throws(()=>own.run(()=>{}),/FIXTURE_CLOSING/);
});

test('acceptance timeout defaults to 120s and accepts only explicit bounded integer strings',()=>{
  assert.equal(fixtureTimeout(undefined),120000);assert.equal(fixtureTimeout('120000'),120000);assert.equal(fixtureTimeout('600000'),600000);
  for(const value of ['',true,600000,'120000.0','1e6','119999','600001','-1','NaN'])assert.throws(()=>fixtureTimeout(value),/INVALID_TEST_TIMEOUT/);
});
