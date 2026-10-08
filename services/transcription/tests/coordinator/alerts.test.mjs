// ABOUTME: Проверяет тихую политику, эпизоды, replay и fallback доставки уведомлений.
// ABOUTME: Использует явные порты без NATS/БД; SQL и реальная доставка проверяются отдельно.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { incidentEvent, requestEvent } from '../../dist/notifications.js';
import { createAlertsController } from '../../dist/coordinator/recovery/alerts.js';
import { validateDto } from '../../contracts/index.mjs';
const when = '2026-10-07T12:00:00Z';
const record = { taskState: 'failed', resultState: 'not_ready', requestId: randomUUID(), currentAttemptId: randomUUID(),
  ownerId: 'alice', scope: { scopeType: 'user', scopeId: 'alice' }, errorCode: 'MODEL_UNAVAILABLE', text: 'private transcript', audio: 'private bytes' };
function fixture(publish) {
  const queue = [], events = [], episodes = new Map(), calls = [];
  const helper = { async call(method, p) {
    calls.push(method);
    if (method === 'alerts.observe') {
      if (p.available) { episodes.delete(p.key); return { event: null }; }
      const event = episodes.get(p.key) ?? incidentEvent(p.key, p.eventId, p.occurredAt);
      if (!episodes.has(p.key)) { episodes.set(p.key,event); queue.push({ deliveryId: event.id, claimToken: randomUUID(), event }); }
      return { event };
    }
    if (method === 'alerts.claim') return queue[0] ?? null;
    if (method === 'alerts.ack') { queue.shift(); return { acknowledged: true }; }
    if (method === 'alerts.fail') { assert.ok(p.retryDelayMs>=1000 && p.retryDelayMs<=30000); return { failed: true }; }
    throw new Error('unexpected method');
  } };
  const controller = createAlertsController({ helper, publish: publish ?? (async e => { events.push(e); }), workerId:'test',pollIntervalMs:10 });
  return { controller, queue, events, episodes, calls, helper };
}
test('safe projection preserves audience and typed reason without transcript or system IDs', () => {
  for (const taskState of ['failed','outcome_unknown']) {
    const event = requestEvent({ ...record,taskState },randomUUID(),when);
    assert.equal(event.scope_id,'alice');assert.equal(event.type_id,taskState==='failed'?1:3);
    assert.equal(validateDto('AlertEvent',event),true);assert.equal(JSON.stringify(event).includes('private'),false);
    const system = requestEvent({ ...record,taskState,scope:{ scopeType:'system',scopeId:'internal' } },randomUUID(),when);
    assert.equal(system.scope_id,'global');assert.deepEqual(system.data,{});
    assert.equal(JSON.stringify(system).includes(record.requestId),false);
  }
  assert.equal(requestEvent({ ...record,taskState:'succeeded',resultState:'lost' },randomUUID(),when).type_id,3);
  assert.equal(validateDto('AlertEvent',{ ...incidentEvent('storage',randomUUID(),when), data:{ text:'private' } }),false);
  assert.equal(validateDto('AlertEvent',{ ...requestEvent(record,randomUUID(),when),scope_type:'system',scope_id:'global' }),false);
});
test('normal observations, empty queue and repeated healthy ticks publish nothing',async()=>{
  const f=fixture();f.controller.observe('storage',true);f.controller.observe('local_ai',true);
  await f.controller.tick();await f.controller.tick();assert.deepEqual(f.events,[]);await f.controller.close();
});
test('one notification per episode and recovery is silent',async()=>{
  const f=fixture();f.controller.observe('history',false);await f.controller.tick();
  for(let i=0;i<5;i++){ f.controller.observe('history',false);await f.controller.tick(); }
  assert.equal(f.events.length,1);
  f.controller.observe('history',true);await f.controller.tick();assert.equal(f.events.length,1);
  f.controller.observe('history',false);await f.controller.tick();assert.equal(f.events.length,2);
  assert.notEqual(f.events[0].id,f.events[1].id);await f.controller.close();
});
test('lost PubAck replays immutable event and never acknowledges failed publish',async()=>{
  let fail=true;const sent=[];const f=fixture(async e=>{sent.push(structuredClone(e));if(fail)throw new Error('timeout');});
  const event=requestEvent(record,randomUUID(),when);f.queue.push({deliveryId:event.id,claimToken:randomUUID(),event});
  await f.controller.tick();assert.equal(f.calls.includes('alerts.ack'),false);assert.equal(f.controller.status().alertsAvailable,false);
  fail=false;await f.controller.tick();assert.deepEqual(sent[0],sent[1]);assert.equal(f.controller.status().alertsAvailable,true);
  await f.controller.close();
});
test('helper outage uses bounded fallback with stable ID until helper recovers',async()=>{
  let down=true;const sent=[];const f=fixture(async e=>{sent.push(structuredClone(e));});
  const delegate=f.controller;
  const helper={async call(method,p){if(down)throw new Error('helper down');if(method==='alerts.observe')return {event:p.available?null:incidentEvent(p.key,p.eventId,p.occurredAt)};if(method==='alerts.claim')return null;throw new Error('unexpected');}};
  const c=createAlertsController({helper,publish:async e=>sent.push(structuredClone(e)),workerId:'test',pollIntervalMs:10});
  c.observe('storage',false);await c.tick();await c.tick();assert.equal(sent.length,1);
  down=false;await c.tick();assert.equal(sent.length,1);await c.close();await delegate.close();
});
test('concurrent ticks share one delivery and close waits for active publish',async()=>{
  let release;const published=new Promise(resolve=>{release=resolve;});let started;
  const begin=new Promise(resolve=>{started=resolve;});
  const f=fixture(async()=>{started();await published;});
  const event=requestEvent(record,randomUUID(),when);f.queue.push({deliveryId:event.id,claimToken:randomUUID(),event});
  const a=f.controller.tick(),b=f.controller.tick();assert.equal(a,b);
  await begin;let closed=false;const closing=f.controller.close().then(()=>{closed=true;});
  await Promise.resolve();assert.equal(closed,false);release();await Promise.all([a,b,closing]);
  assert.equal(f.calls.filter(m=>m==='alerts.ack').length,1);
});

test('failure that recovers before a delivery tick is still reported once',async()=>{
  const f=fixture();f.controller.observe('artifacts',false);f.controller.observe('artifacts',true);
  await f.controller.tick();await f.controller.tick();assert.equal(f.events.length,1);
  f.controller.observe('artifacts',false);await f.controller.tick();assert.equal(f.events.length,2);
  await f.controller.close();
});
test('new failure during awaited healthy observation survives as next episode',async()=>{
  const f=fixture();const invoke=f.helper.call;
  let release,entered;const waiting=new Promise(resolve=>{entered=resolve;});
  const block=new Promise(resolve=>{release=resolve;});
  f.helper.call=async(method,p)=>{
    if(method==='alerts.observe'&&p.key==='history'&&p.available){entered();await block;}
    return invoke(method,p);
  };
  f.controller.observe('history',false);await f.controller.tick();
  f.controller.observe('history',true);const ticking=f.controller.tick();
  await waiting;f.controller.observe('history',false);release();await ticking;
  await f.controller.tick();assert.equal(f.events.length,2);assert.notEqual(f.events[0].id,f.events[1].id);
  await f.controller.close();
});
test('fallback publication failures respect retry delay and do not grow recursive events',async()=>{
  let publishes=0;
  const c=createAlertsController({helper:{call:async()=>{throw new Error('helper down');}},
    publish:async()=>{publishes++;throw new Error('NATS down');},workerId:'test',pollIntervalMs:10});
  c.observe('storage',false);
  for(let i=0;i<10;i++)await c.tick();
  assert.equal(publishes,1);await c.close();assert.equal(publishes,1);
});


test('idle alert polling with unavailable storage does not create fallback notifications', async () => {
  const events = [];
  const controller = createAlertsController({ helper: { call: async () => { throw new Error('storage down'); } },
    publish: async event => events.push(event), workerId: 'idle-test', pollIntervalMs: 10 });
  controller.observe('local_ai', true);
  controller.observe('storage', true);
  for (let i = 0; i < 3; i++) await controller.tick();
  await controller.close();
  assert.deepEqual(events, []);
});
