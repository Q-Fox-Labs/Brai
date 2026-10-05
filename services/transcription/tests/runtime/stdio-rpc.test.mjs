// ABOUTME: Проверяет wire-протокол, пределы и сбои реального stdio RPC primitive.
// ABOUTME: Синтетические handlers проверяют транспорт и не заменяют бизнес-интеграцию.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';
import { RpcClient, serveRpc } from '../../dist/runtime/stdio-rpc.js';

const limits = { frameBytes: 4096, batchItems: 12, concurrentRequests: 4, concurrentExecute: 2 };
const validObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const methods = {
  echo: { validateParams: validObject, validateResult: validObject },
  positional: { validateParams: Array.isArray, validateResult: Array.isArray },
  execute: { validateParams: validObject, validateResult: validObject, lane: 'execute' },
  health: { validateParams: validObject, validateResult: validObject },
};
const request = (id, method = 'echo', params = {}) => ({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, params });
const wire = (value) => JSON.stringify(value) + '\n';
const tick = () => new Promise((resolve) => setImmediate(resolve));

function harness(t, handlers = {}, overrides = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const responses = [];
  const waiters = [];
  let text = '';
  output.on('data', (bytes) => {
    text += bytes.toString('utf8');
    let newline;
    while ((newline = text.indexOf('\n')) >= 0) {
      const value = JSON.parse(text.slice(0, newline));
      text = text.slice(newline + 1);
      if (waiters.length) waiters.shift()(value);
      else responses.push(value);
    }
  });
  const done = serveRpc(methods, { echo: (params) => params, positional: (params) => params, health: () => ({ available: true }), ...handlers }, { ...limits, ...overrides, input, output });
  void done.catch(() => {});
  t.after(async () => { input.destroy(); await done.catch(() => {}); output.destroy(); });
  return {
    input, output, done, responses,
    send: (value) => input.write(wire(value)),
    next: () => responses.length ? Promise.resolve(responses.shift()) : new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Missing RPC response')), 2000);
      waiters.push((value) => { clearTimeout(timer); resolve(value); });
    }),
    finish: async () => { input.end(); await done; },
  };
}

test('fragmented UTF-8 bytes preserve params and string/number/null ids', async (t) => {
  const h = harness(t);
  const params = { text: 'Ёж 🦔' };
  const bytes = Buffer.from(wire(request('utf8', 'echo', params)));
  for (const byte of bytes) h.input.write(Buffer.from([byte]));
  assert.deepEqual(await h.next(), { jsonrpc: '2.0', id: 'utf8', result: params });
  h.send(request(17, 'positional', [1, 2]));
  h.send(request(null));
  assert.deepEqual(await h.next(), { jsonrpc: '2.0', id: 17, result: [1, 2] });
  assert.deepEqual(await h.next(), { jsonrpc: '2.0', id: null, result: {} });
  await h.finish();
});

test('standard parse/request/method/params errors keep exact response shape', async (t) => {
  const h = harness(t);
  const cases = [
    ['{\n', -32700, null],
    [Buffer.from([0xc3, 0x28, 10]), -32700, null],
    [wire(12), -32600, null],
    [wire({ ...request('wrong'), jsonrpc: '1.0' }), -32600, null],
    [wire({ ...request(true) }), -32600, null],
    [wire({ ...request('wrong'), result: 1 }), -32600, null],
    [wire(request('unknown', 'missing')), -32601, 'unknown'],
    [wire(request('bad', 'echo', [])), -32602, 'bad'],
    [wire(request(9, 'echo', 4)), -32602, 9],
    [wire([]), -32600, null],
  ];
  for (const [input, code, id] of cases) {
    h.input.write(input);
    const response = await h.next();
    assert.equal(response.id, id);
    assert.equal(response.error.code, code);
    assert.deepEqual(Object.keys(response).sort(), ['error', 'id', 'jsonrpc']);
    assert.deepEqual(Object.keys(response.error).sort(), ['code', 'message']);
  }
  await h.finish();
});

test('oversized multibyte frame is rejected before newline and tail is discarded', async (t) => {
  const h = harness(t, {}, { frameBytes: 128 });
  h.input.write(Buffer.from('я'.repeat(65)));
  const response = await h.next();
  assert.equal(response.error.code, -32700);
  assert.equal(response.id, null);
  h.input.write('discarded tail\n' + wire(request('ok')));
  assert.deepEqual(await h.next(), { jsonrpc: '2.0', id: 'ok', result: {} });
  await h.finish();
  assert.equal(h.responses.length, 0);
});

test('batch follows JSON-RPC semantics and notifications never produce responses', async (t) => {
  let notified = 0;
  const h = harness(t, { echo: (params) => { if (params.notification) notified++; return params; } });
  h.send([request('one'), request(undefined, 'echo', { notification: true }), 7, request('missing', 'absent')]);
  const responses = await h.next();
  assert.deepEqual(responses.map((response) => [response.id, response.error?.code ?? 0]), [['one', 0], [null, -32600], ['missing', -32601]]);
  assert.equal(notified, 1);
  h.send([request(undefined), request(undefined, 'absent'), request(undefined, 'echo', 3)]);
  h.send(request(undefined, 'echo', { notification: true }));
  await h.finish();
  assert.equal(notified, 2);
  assert.equal(h.responses.length, 0);
});

test('batch limit rejects work per id and keeps invalid entry/notification behavior', async (t) => {
  let calls = 0;
  const h = harness(t, { echo: () => { calls++; return {}; } }, { batchItems: 2 });
  h.send([request('a'), request(undefined), false, request('b')]);
  const responses = await h.next();
  assert.deepEqual(responses.map((response) => [response.id, response.error.code]), [['a', -32000], [null, -32600], ['b', -32000]]);
  assert.equal(calls, 0);
  assert.equal(responses[0].error.data.errorCode, 'OVERLOADED');
  await h.finish();
});

test('blocked execute leaves control capacity, overload is explicit, EOF waits in-flight', async (t) => {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const h = harness(t, { execute: async () => { await blocked; return { done: true }; } }, { concurrentRequests: 3, concurrentExecute: 1 });
  t.after(() => release());
  h.send(request('long', 'execute'));
  h.send(request('busy', 'execute'));
  h.send(request('control', 'health'));
  const first = await h.next();
  const second = await h.next();
  assert.deepEqual(new Set([first.id, second.id]), new Set(['busy', 'control']));
  assert.equal([first, second].find((response) => response.id === 'busy').error.data.errorCode, 'OVERLOADED');
  assert.deepEqual([first, second].find((response) => response.id === 'control').result, { available: true });
  h.input.end();
  let finished = false;
  void h.done.then(() => { finished = true; });
  await tick();
  assert.equal(finished, false);
  release();
  assert.deepEqual(await h.next(), { jsonrpc: '2.0', id: 'long', result: { done: true } });
  await h.done;
});

test('safe application enum and result validation exclude payload/error text', async (t) => {
  const marker = 'private synthetic content';
  const h = harness(t, { echo: (params) => {
    if (params.kind === 'allowed') throw { errorCode: 'DEPENDENCY_UNAVAILABLE', message: marker, input: marker };
    if (params.kind === 'unknown') throw { errorCode: marker, message: marker };
    if (params.kind === 'invalid') return 7;
    return { text: marker.repeat(5000) };
  } }, { applicationErrorCodes: ['DEPENDENCY_UNAVAILABLE'] });
  for (const kind of ['allowed', 'unknown', 'invalid', 'large']) {
    h.send(request(kind, 'echo', { kind }));
    const response = await h.next();
    assert.equal(response.error.code, kind === 'allowed' ? -32000 : -32603);
    assert.equal(JSON.stringify(response).includes(marker), false);
    assert.equal(Object.hasOwn(response, 'result'), false);
  }
  await h.finish();
});

test('slow stdout limits outstanding work and serializes complete responses', async () => {
  const input = new PassThrough();
  const chunks = [];
  let consume;
  let called = 0;
  const output = new Writable({ highWaterMark: 1, write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); consume = callback; } });
  const done = serveRpc(methods, { echo: (params) => { called++; return params; } }, { ...limits, input, output });
  input.end(Array.from({ length: 20 }, (_, i) => wire(request(String(i)))).join(''));
  await tick(); await tick();
  assert.equal(chunks.length, 1);
  assert.ok(called <= limits.concurrentRequests);
  for (let i = 0; i < 20; i++) { assert.ok(consume); const callback = consume; consume = undefined; callback(); await tick(); }
  await done;
  assert.equal(called, 20);
  assert.deepEqual(chunks.map((chunk) => JSON.parse(chunk).id), Array.from({ length: 20 }, (_, i) => String(i)));
  output.destroy();
});

test('unterminated input at EOF yields parse error, never successful dispatch', async (t) => {
  let calls = 0;
  const h = harness(t, { echo: () => { calls++; return {}; } });
  h.input.end(JSON.stringify(request('partial')));
  assert.equal((await h.next()).error.code, -32700);
  await h.done;
  assert.equal(calls, 0);
});

function clientHarness(t, outputOverride) {
  const input = new PassThrough();
  const sent = [];
  const output = outputOverride ?? new Writable({ write(chunk, _encoding, callback) { sent.push(JSON.parse(chunk)); callback(); } });
  const client = new RpcClient({ input, output }, { frameBytes: 4096, concurrentRequests: 2 });
  t.after(() => client.close());
  return { client, input, output, sent, answer: (id, result) => input.write(wire({ jsonrpc: '2.0', id, result })) };
}

test('client matches reversed concurrent responses by string id', async (t) => {
  const h = clientHarness(t);
  const a = h.client.call('first', {}, { deadlineAt: Date.now() + 2000 });
  const b = h.client.call('second', {}, { deadlineAt: Date.now() + 2000 });
  await tick();
  assert.equal(h.sent.length, 2);
  assert.equal(typeof h.sent[0].id, 'string');
  assert.equal(Array.isArray(h.sent[0].params), false);
  h.answer(h.sent[1].id, { value: 2 });
  h.answer(h.sent[0].id, { value: 1 });
  assert.deepEqual(await Promise.all([a, b]), [{ value: 1 }, { value: 2 }]);
});

test('far-future absolute deadline accepts one response without Node timer overflow or replay', async (t) => {
  const h = clientHarness(t);
  const result = h.client.call('execute', {}, { deadlineAt: Date.now() + 4_294_967_294 });
  await tick();
  assert.equal(h.sent.length, 1);
  h.answer(h.sent[0].id, { completed: true });
  assert.deepEqual(await result, { completed: true });
  await tick();
  assert.equal(h.sent.length, 1);
});

test('client timeout remains unknown, late response is ignored, no repeat/cancel is sent', async (t) => {
  const h = clientHarness(t);
  const timed = h.client.call('execute', {}, { deadlineAt: Date.now() + 40 });
  await assert.rejects(timed, (error) => error.code === 'RPC_TIMEOUT' && error.outcome === 'unknown');
  assert.equal(h.sent.length, 1);
  h.answer(h.sent[0].id, { late: true });
  const health = h.client.call('health', {}, { deadlineAt: Date.now() + 1000 });
  await tick();
  h.answer(h.sent[1].id, { available: true });
  assert.deepEqual(await health, { available: true });
  assert.deepEqual(h.sent.map((entry) => entry.method), ['execute', 'health']);
});

test('expired unsent calls do not leak writes and queue remains bounded under backpressure', async (t) => {
  let consume;
  const sent = [];
  const output = new Writable({ highWaterMark: 1, write(chunk, _encoding, callback) { sent.push(JSON.parse(chunk)); consume = callback; } });
  const h = clientHarness(t, output);
  const a = h.client.call('execute', {}, { deadlineAt: Date.now() + 40 });
  const b = h.client.call('execute', {}, { deadlineAt: Date.now() + 40 });
  const results = await Promise.allSettled([a, b]);
  assert.deepEqual(results.map((entry) => entry.reason.outcome), ['unknown', 'not_started']);
  for (let i = 0; i < 20; i++) await assert.rejects(h.client.call('execute', {}, { deadlineAt: Date.now() + 1000 }), (error) => error.code === 'RPC_OVERLOADED');
  assert.equal(sent.length, 1);
  consume();
  await tick(); await tick();
  assert.equal(sent.length, 1);
  const health = h.client.call('health', {}, { deadlineAt: Date.now() + 1000 });
  await tick();
  assert.equal(sent.length, 2);
  consume();
  h.answer(sent[1].id, {});
  await health;
});

test('client protocol failure rejects inflight without exposing raw response', async (t) => {
  const h = clientHarness(t);
  const pending = h.client.call('execute', {}, { deadlineAt: Date.now() + 1000 });
  await tick();
  h.input.write(wire({ jsonrpc: '2.0', id: h.sent[0].id, result: 'synthetic private text', error: { code: -32000, message: 'synthetic private text' } }));
  await assert.rejects(pending, (error) => error.code === 'RPC_PROTOCOL' && error.outcome === 'unknown' && !error.message.includes('private'));
});

test('expired queued call is not sent even before its delayed timer callback runs', async (t) => {
  let consume;
  const sent = [];
  const output = new Writable({ write(chunk, _encoding, callback) { sent.push(JSON.parse(chunk)); consume = callback; } });
  const h = clientHarness(t, output);
  const first = h.client.call('first', {}, { deadlineAt: Date.now() + 1000 });
  const second = h.client.call('second', {}, { deadlineAt: Date.now() + 40 });
  const results = Promise.allSettled([first, second]);
  await tick();
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 70);
  consume();
  h.answer(sent[0].id, {});
  const settled = await results;
  assert.equal(settled[0].status, 'fulfilled');
  assert.equal(settled[1].reason.code, 'RPC_TIMEOUT');
  assert.equal(settled[1].reason.outcome, 'not_started');
  assert.equal(sent.length, 1);
});

test('late response cannot beat a delayed deadline timer and report success', async (t) => {
  const h = clientHarness(t);
  const pending = h.client.call('execute', {}, { deadlineAt: Date.now() + 40 });
  const rejected = assert.rejects(pending, (error) => error.code === 'RPC_TIMEOUT' && error.outcome === 'unknown');
  await tick();
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 70);
  h.answer(h.sent[0].id, { stale: true });
  await rejected;
});

test('received handler error after sideeffect is unknown, including allowlisted OVERLOADED', async (t) => {
  const input = new PassThrough();
  const output = new PassThrough();
  let sideeffects = 0;
  const done = serveRpc(methods, { echo: (params) => {
    sideeffects++;
    if (params.kind === 'internal') throw new Error('private synthetic content');
    throw { errorCode: params.kind, message: 'private synthetic content' };
  } }, { ...limits, input, output, applicationErrorCodes: ['OUTCOME_UNKNOWN', 'OVERLOADED'] });
  void done.catch(() => {});
  const client = new RpcClient({ input: output, output: input }, { frameBytes: 4096, concurrentRequests: 2 });
  t.after(async () => { client.close(); await done.catch(() => {}); });
  for (const kind of ['internal', 'OUTCOME_UNKNOWN', 'OVERLOADED']) {
    await assert.rejects(client.call('echo', { kind }, { deadlineAt: Date.now() + 1000 }), (error) => {
      assert.equal(error.code, 'RPC_REMOTE');
      assert.equal(error.outcome, 'unknown');
      assert.equal(error.message.includes('private'), false);
      assert.equal(error.rpcCode, kind === 'internal' ? -32603 : -32000);
      return true;
    });
  }
  assert.equal(sideeffects, 3);
  await assert.rejects(client.call('missing', {}, { deadlineAt: Date.now() + 1000 }), (error) => error.rpcCode === -32601 && error.outcome === 'not_started');
  assert.equal(sideeffects, 3);
});

test('client oversized and truncated responses fail unknown rather than proving cancellation', async (t) => {
  for (const truncated of [false, true]) {
    const h = clientHarness(t);
    const pending = h.client.call('execute', {}, { deadlineAt: Date.now() + 1000 });
    await tick();
    if (truncated) h.input.end(JSON.stringify({ jsonrpc: '2.0', id: h.sent[0].id, result: {} }));
    else h.input.write('x'.repeat(4097));
    await assert.rejects(pending, (error) => error.code === 'RPC_PROTOCOL' && error.outcome === 'unknown');
  }
});

test('actual subprocess crash rejects all inflight as unknown and performs no restart', async (t) => {
  const moduleUrl = new URL('../../dist/runtime/stdio-rpc.js', import.meta.url).href;
  const script = `import { serveRpc } from ${JSON.stringify(moduleUrl)};
    const validate = () => true;
    await serveRpc({ execute: { validateParams: validate, validateResult: validate, lane: 'execute' } },
      { execute: async () => { setTimeout(() => process.exit(7), 20); await new Promise(() => {}); } },
      { frameBytes: 4096, batchItems: 4, concurrentRequests: 3, concurrentExecute: 2 });`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  const client = new RpcClient({ input: child.stdout, output: child.stdin, process: child }, { frameBytes: 4096, concurrentRequests: 2 });
  t.after(() => { client.close(); if (child.exitCode === null) child.kill(); });
  const results = await Promise.allSettled([
    client.call('execute', {}, { deadlineAt: Date.now() + 2000 }),
    client.call('execute', {}, { deadlineAt: Date.now() + 2000 }),
  ]);
  assert.deepEqual(results.map((entry) => [entry.reason.code, entry.reason.outcome]), [['RPC_CLOSED', 'unknown'], ['RPC_CLOSED', 'unknown']]);
  assert.equal((await exited)[0], 7);
  await assert.rejects(client.call('health', {}, { deadlineAt: Date.now() + 1000 }), (error) => error.code === 'RPC_CLOSED' && error.outcome === 'not_started');
});

test('limits and expired deadlines fail before dispatch', async (t) => {
  await assert.rejects(serveRpc({}, {}, { ...limits, concurrentExecute: limits.concurrentRequests }), /control capacity/);
  const h = clientHarness(t);
  await assert.rejects(h.client.call('execute', {}, { deadlineAt: Date.now() - 1 }), (error) => error.outcome === 'not_started');
  await assert.rejects(h.client.call('execute', {}, { deadlineAt: Infinity }), (error) => error.code === 'RPC_INVALID_ARGUMENT');
  assert.equal(h.sent.length, 0);
});
