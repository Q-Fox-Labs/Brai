// ABOUTME: Проверяет настоящие HTTP/MCP подключения координатора с явно подставленным предметным портом.
// ABOUTME: Проверяет доверенный principal, закрытые DTO и границы ресурсов без внешних providers.
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { methodMap } from '../../contracts/index.mjs';
import { encodeBoundedJson } from '../../dist/runtime/stdio-rpc.js';
import { createPublicGateway } from '../../dist/coordinator/transport/boundary.js';
import { startHttpTransport } from '../../dist/coordinator/transport/http.js';

const id = '11111111-1111-4111-8111-111111111111';
const selector = { modelId: 'whisper', revision: 'v1', profileId: 'cpu' };
const principal = { scopeType: 'user', scopeId: 'scope-one', ownerId: 'owner-one', permissions: ['transcription:use'] };
const settings = { defaultLocalModel: null, allowReplacement: false, policyVersion: 1 };
const view = { requestId: id, requestedModel: null, actualModel: null, taskState: 'accepted', resultState: 'not_ready', revision: 1,
  errorCode: null, createdAt: '2026-10-05T01:00:00Z', updatedAt: '2026-10-05T01:00:00Z' };
const inputs = {
  'request.submit': { clientIdempotencyKey: id, audioArtifactId: id, requestedModel: null, deadlineAt: null },
  'request.get': { requestId: id }, 'request.cancel': { requestId: id }, 'models.list': {}, 'settings.get': {},
  'settings.set': { settings, expectedRevision: 1 }, 'result.get': { requestId: id },
};
const outputs = {
  'request.submit': { request: view }, 'request.get': { request: view },
  'request.cancel': { accepted: true, stopConfirmed: false, request: view },
  'models.list': { localCatalogState: 'available', localItems: [], externalAvailable: false, externalItems: [], catalogErrorCode: null },
  'settings.get': { settings, revision: 1 }, 'settings.set': { settings, revision: 2 },
  'result.get': { state: 'available', result: { requestId: id, text: 'Ёж 🦔', segments: null, actualModel: selector } },
};

async function listener(t, overrides = {}, invoke) {
  const calls = [];
  const gateway = createPublicGateway({ maxConcurrent: overrides.maxConcurrent ?? 4,
    bindings: [{ token: 'test-use', principal }, { token: 'test-write', principal: { ...principal, permissions: ['transcription:use', 'transcription:settings:write'] } }],
    invoke: invoke ?? (async (method, params, trusted) => { calls.push({ method, params, trusted }); return outputs[method]; }),
  });
  const allowedHosts = ['transcription.test'];
  const transport = await startHttpTransport({ host: '127.0.0.1', port: 0, allowedHosts,
    allowedOrigins: ['https://allowed.test'], headerBytes: 4096, requestBytes: 2048, responseBytes: 100000,
    requestTimeoutMs: 1500, maxConnections: 20, ...overrides }, gateway);
  t.after(() => transport.close());
  const url = `http://127.0.0.1:${transport.address().port}`;
  allowedHosts.push(new URL(url).host);
  const send = (method, body = inputs[method], headers = {}, path = `/v1/transcription/${method}`) => new Promise((resolve, reject) => {
    const req = httpRequest(url + path, { method: 'POST', headers: { host: 'transcription.test', authorization: 'Bearer test-use', 'content-type': 'application/json', ...headers } }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('error', reject);
      res.on('end', () => {
        try { resolve({ response: { status: res.statusCode, headers: new Headers(res.headers) }, body: JSON.parse(raw) }); }
        catch (error) { reject(error); }
      });
    });
    req.on('error', reject);
    req.end(typeof body === 'string' ? body : JSON.stringify(body));
  });
  return { url, send, calls, gateway };
}

test('seven HTTP methods use owner DTOs, trusted token principal and no-store', async (t) => {
  const h = await listener(t);
  for (const method of Object.keys(methodMap.public)) {
    const { response, body } = await h.send(method, inputs[method], { authorization: 'Bearer test-write' });
    assert.equal(response.status, 200, method);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(body, outputs[method]);
  }
  assert.equal(h.calls.length, 7);
  assert.equal(h.calls[0].trusted.ownerId, principal.ownerId);
  assert.ok(Object.isFrozen(h.calls[0].trusted));
});

test('auth, owner injection, settings permission, Host/Origin and closed settings deny before invoke', async (t) => {
  const h = await listener(t);
  const cases = [
    ['settings.get', {}, { authorization: '' }, 401],
    ['settings.get', {}, { authorization: 'Bearer invalid' }, 401],
    ['settings.get', { ownerId: 'attacker' }, {}, 400],
    ['request.submit', { ...inputs['request.submit'], ownerId: 'attacker' }, {}, 400],
    ['settings.set', inputs['settings.set'], {}, 403],
    ['settings.set', { ...inputs['settings.set'], settings: { ...settings, allowReplacement: true } }, { authorization: 'Bearer test-write' }, 400],
    ['settings.get', {}, { host: 'evil.test' }, 403],
    ['settings.get', {}, { origin: 'https://evil.test' }, 403],
  ];
  for (const [method, input, headers, status] of cases) {
    const result = await h.send(method, input, headers);
    assert.equal(result.response.status, status);
    assert.deepEqual(Object.keys(result.body), ['errorCode']);
  }
  assert.equal(h.calls.length, 0);
});

test('actual SDK client initializes stateless MCP, lists all seven schemas and calls result without duplicate text', async (t) => {
  const h = await listener(t);
  const client = new Client({ name: 'transport-acceptance', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(h.url + '/mcp'), { requestInit: { headers: { host: 'transcription.test', authorization: 'Bearer test-write' } } });
  t.after(async () => { await client.close(); });
  await client.connect(transport);
  const list = await client.listTools();
  assert.deepEqual(list.tools.map((tool) => tool.name).sort(), Object.keys(methodMap.public).map((method) => `transcription_${method.replaceAll('.', '_')}`).sort());
  for (const tool of list.tools) assert.equal(tool.outputSchema.type, 'object');
  const result = await client.callTool({ name: 'transcription_result_get', arguments: inputs['result.get'] });
  assert.deepEqual(result.structuredContent, outputs['result.get']);
  assert.deepEqual(result.content, []);
  const denied = await client.callTool({ name: 'transcription_settings_get', arguments: { ownerId: 'attacker' } });
  assert.equal(denied.isError, true);
  assert.deepEqual(JSON.parse(denied.content.at(-1).text), { errorCode: 'INVALID_ARGUMENT' });
  assert.equal(denied.structuredContent, undefined);
  assert.equal(h.calls.length, 1);
});

test('body and complete MCP envelope response bytes are bounded; errors exclude raw payload and exception', async (t) => {
  const h = await listener(t, { requestBytes: 160, responseBytes: 450 }, async () => outputs['result.get']);
  const huge = await h.send('settings.get', JSON.stringify({ secret: '🦔'.repeat(80) }));
  assert.equal(huge.response.status, 413);
  assert.deepEqual(huge.body, { errorCode: 'INPUT_TOO_LARGE' });
  const malformed = await h.send('settings.get', '{private-broken');
  assert.equal(malformed.response.status, 400);
  assert.deepEqual(malformed.body, { errorCode: 'INVALID_ARGUMENT' });
  const full = await listener(t, { responseBytes: 280 }, async () => ({ ...outputs['result.get'], result: { ...outputs['result.get'].result, text: '🦔'.repeat(100) } }));
  const api = await full.send('result.get');
  assert.equal(api.response.status, 413);
  const rpc = await full.send('', { jsonrpc: '2.0', id: 'envelope-id', method: 'tools/call', params: { name: 'transcription_result_get', arguments: inputs['result.get'] } }, {}, '/mcp');
  assert.equal(rpc.response.status, 200);
  assert.equal(rpc.body.id, 'envelope-id');
  assert.deepEqual(JSON.parse(rpc.body.result.content.at(-1).text), { errorCode: 'RESULT_TOO_LARGE' });
  assert.ok(Buffer.byteLength(JSON.stringify(rpc.body)) <= 280);
  const raw = await listener(t, {}, async () => { throw new Error('private transcript credential'); });
  const failure = await raw.send('settings.get');
  assert.deepEqual(failure.body, { errorCode: 'INTERNAL' });
});

test('HTTP and MCP deadlines retain shared capacity until actual business callback settles', { timeout: 10000 }, async (t) => {
  for (const mcp of [false, true]) {
    let release;
    let began;
    const started = new Promise((resolve) => { began = resolve; });
    const held = new Promise((resolve) => { release = resolve; });
    const h = await listener(t, { maxConcurrent: 1, requestTimeoutMs: 60 }, async () => { began(); await held; return outputs['settings.get']; });
    const first = mcp ? h.send('', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'transcription_settings_get', arguments: {} } }, {}, '/mcp') : h.send('settings.get');
    await started;
    assert.equal((await first).response.status, 504);
    assert.equal((await h.send('settings.get')).response.status, 429);
    release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal((await h.send('settings.get')).response.status, 200);
  }
});

test('fragmented oversize body before EOF releases capacity and closes own socket', async (t) => {
  const h = await listener(t, { requestBytes: 80, maxConcurrent: 1 });
  const response = await new Promise((resolve, reject) => {
    const req = httpRequest(h.url + '/v1/transcription/settings.get', { method: 'POST', headers: { host: 'transcription.test', authorization: 'Bearer test-use', 'content-type': 'application/json' } }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => { resolve({ status: res.statusCode, body: JSON.parse(body), connection: res.headers.connection }); req.destroy(); });
    });
    req.on('error', reject);
    req.write(' '.repeat(40));
    req.write(' '.repeat(50)); // deliberately no request.end or terminal JSON
  });
  assert.deepEqual(response, { status: 413, body: { errorCode: 'INPUT_TOO_LARGE' }, connection: 'close' });
  assert.equal((await h.send('settings.get')).response.status, 200);
});

test('HTTP and MCP disconnected clients retain capacity until invoke settles without cancellation', { timeout: 10000 }, async (t) => {
  for (const mcp of [false, true]) {
    let began;
    let release;
    let executions = 0;
    const started = new Promise((resolve) => { began = resolve; });
    const held = new Promise((resolve) => { release = resolve; });
    t.after(() => release());
    const h = await listener(t, { maxConcurrent: 1 }, async () => { executions++; began(); await held; return outputs['settings.get']; });
    const req = httpRequest(h.url + (mcp ? '/mcp' : '/v1/transcription/settings.get'), { method: 'POST', headers: { host: 'transcription.test', authorization: 'Bearer test-use', 'content-type': 'application/json' } });
    req.on('error', () => {});
    req.end(JSON.stringify(mcp ? { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'transcription_settings_get', arguments: {} } } : {}));
    await started;
    req.destroy();
    assert.equal((await h.send('settings.get')).response.status, 429);
    assert.equal(executions, 1);
    release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal((await h.send('settings.get')).response.status, 200);
    assert.equal(executions, 2);
  }
});

test('public bounded JSON budget excludes newline, counts UTF8/escaping and rejects nonJSON without truncate', () => {
  const value = { text: '🦔\n\\' };
  const expected = Buffer.from(JSON.stringify(value));
  assert.deepEqual(encodeBoundedJson(value, expected.length), expected);
  assert.throws(() => encodeBoundedJson(value, expected.length - 1));
  for (const invalid of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => encodeBoundedJson({}, invalid));
  for (const invalid of [{ value: undefined }, new Date(), { value: BigInt(1) }]) assert.throws(() => encodeBoundedJson(invalid, 1000));
  const cyclic = {}; cyclic.self = cyclic;
  assert.throws(() => encodeBoundedJson(cyclic, 1000));
});
