// ABOUTME: Проверяет доступность списка чатов при медленной или недоступной native истории.
// ABOUTME: Подставляет только CodexPort; исполняет настоящий application и его сроки чтения.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApplication } from '../dist/application.js';

function fixture(t, count = 2) {
  let generation = 'g1', observer, reading = 0, peak = 0;
  const threads = Array.from({ length: count }, (_, index) => ({ id: `t${index}`, name: `Chat ${index}`, preview: '', updatedAt: 99, cwd: '/demo', status: { type: 'idle' } }));
  const calls = [], settings = { delay: 0, listScanDelay: 0, fail: new Set() };
  const port = {
    status: () => ({ generation, connection: 'connected', authorization: 'ready' }),
    subscribe: fn => { observer = fn; return () => {}; },
    call: async (method, params, options = {}) => {
      calls.push({ method, params, options });
      if (method === 'account/rateLimits/read') return { rateLimits: null };
      if (method === 'thread/list') {
        if (settings.listScanDelay && !params.useStateDbOnly) await new Promise((resolve, reject) => {
          const scan = setTimeout(() => { clearTimeout(timeout); resolve(); }, settings.listScanDelay);
          const timeout = setTimeout(() => { clearTimeout(scan); reject(Object.assign(new Error('rollout scan timeout'), { code: 'TIMEOUT' })); }, options.timeoutMs ?? 10000);
        });
        return { data: threads, nextCursor: 'next-page' };
      }
      if (method !== 'thread/items/list') throw new Error(method);
      reading++; peak = Math.max(peak, reading);
      try {
        if (settings.fail.has(params.threadId)) throw Object.assign(new Error('unreadable history'), { code: 'UPSTREAM_UNAVAILABLE' });
        if (settings.delay) await new Promise((resolve, reject) => {
          const delay = setTimeout(() => { clearTimeout(timeout); resolve(); }, settings.delay);
          const timeout = setTimeout(() => { clearTimeout(delay); reject(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })); }, options.timeoutMs ?? 10000);
        });
        return { data: [{ turnId: 'turn', startedAtMs: 1000, item: { id: `final-${params.threadId}`, type: 'agentMessage', phase: 'final_answer', text: 'Done' } }], nextCursor: null };
      } finally { reading--; }
    },
  };
  const app = createApplication(port, { projects: [{ projectId: 'p', name: 'P', cwd: '/demo' }] }, () => {});
  t.after(() => app.close());
  return { app, threads, calls, settings, peak: () => peak, reading: () => reading, rotate() { generation = 'g2'; observer({ type: 'connection' }); }, list: () => app.request({ action: 'threads', projectId: 'p' }) };
}

test('one unreadable history does not hide other chats; failed enrichment can recover', async t => {
  const f = fixture(t); f.settings.fail.add('t0');
  const page = await f.list();
  assert.equal(page.nextCursor, 'next-page');
  assert.equal(page.data.length, 2);
  assert.equal(page.data.find(thread => thread.id === 't1').finalMessageId, 'final-t1');
  assert.equal(page.data.find(thread => thread.id === 't0').lastMessageAt, 0);
  f.settings.fail.clear();
  const recovered = await f.list();
  assert.equal(recovered.data.find(thread => thread.id === 't0').finalMessageId, 'final-t0');
  assert.equal(recovered.data.find(thread => thread.id === 't0').lastMessageAt, 1000);
  assert.equal(f.calls.filter(call => call.method === 'thread/items/list' && call.params.threadId === 't1').length, 1);
});

test('a cold hundred-chat page stays inside the web deadline even with slow history', { timeout: 12000 }, async t => {
  const f = fixture(t, 100); f.settings.delay = 2000;
  const start = performance.now();
  const page = await f.list();
  assert.ok(performance.now() - start < 9000, 'list must reach web before its ten-second timeout');
  assert.equal(page.data.length, 100);
  assert.equal(page.nextCursor, 'next-page');
  assert.ok(f.peak() <= 4);
  assert.equal(f.reading(), 0, 'no enrichment jobs continue after the list response');
  assert.ok(f.calls.every(call => ['thread/list', 'thread/items/list', 'account/rateLimits/read'].includes(call.method)));
});

test('failed refresh preserves known message metadata but is not cached as a success', async t => {
  const f = fixture(t);
  await f.list();
  f.threads[0].updatedAt++;
  f.settings.fail.add('t0');
  const page = await f.list();
  assert.equal(page.data.find(thread => thread.id === 't0').lastMessageAt, 1000);
  assert.equal(page.data.find(thread => thread.id === 't0').finalMessageId, 'final-t0');
  f.settings.fail.clear();
  await f.list();
  assert.equal(f.calls.filter(call => call.method === 'thread/items/list' && call.params.threadId === 't0').length, 3);
});

test('generation change during optional history still rejects the obsolete list', async t => {
  const f = fixture(t); f.settings.delay = 50;
  const pending = f.list();
  f.rotate();
  await assert.rejects(pending, { code: 'STALE_GENERATION', outcome: 'query' });
});


test('refresh lists registered threads without a slow rollout repair scan and preserves pagination', async t => {
  const f = fixture(t); f.settings.listScanDelay = 5000;
  const first = await f.list();
  assert.equal(first.data.length, 2);
  assert.equal(first.nextCursor, 'next-page');
  const next = await f.app.request({ action: 'threads', projectId: 'p', cursor: first.nextCursor });
  assert.equal(next.data.length, 2);
  assert.equal(f.calls.filter(call => call.method === 'thread/list')[1].params.cursor, 'next-page');
});
