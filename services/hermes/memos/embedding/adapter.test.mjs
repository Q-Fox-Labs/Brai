// ABOUTME: Проверяет HTTP-контракт MemOS embedding adapter на изолированном NATS порту.
// ABOUTME: Подменяет invoke, не вызывает модель и не отправляет реальные данные.
import assert from 'node:assert/strict';
import { createEmbeddingServer, handleEmbedding, startEmbeddingAdapter, validateConfig } from './adapter.mjs';
import { once } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import test from 'node:test';

const config = {
  ownerId: 'test-owner',
  nats: { servers: ['nats://127.0.0.1:4223'] },
  embedding: {
    host: '127.0.0.1',
    port: 19363,
    timeoutMs: 1000,
    model: {
      modelId: 'embeddinggemma-2-q8',
      revision: 'bfcd298762cc34d0357ece5ebdd31791a3a374d8',
      profileId: 'embeddinggemma2_llama_cpp',
    },
  },
};

function localAiResponse(invocation, vectors) {
  return { requestId: invocation.requestId, operationId: invocation.operationId, model: invocation.model, vectors };
}

test('accepts DEV and PROD loopback NATS listeners and rejects other endpoints', () => {
  assert.equal(validateConfig(config).nats.servers[0], 'nats://127.0.0.1:4223');
  assert.equal(validateConfig({ ...config, nats: { servers: ['nats://127.0.0.1:4222'] } }).nats.servers[0], 'nats://127.0.0.1:4222');
  assert.throws(() => validateConfig({ ...config, nats: { servers: ['nats://127.0.0.1:4224'] } }), /4222 or 4223/);
  assert.throws(() => validateConfig({ ...config, nats: { servers: ['nats://example.com:4222'] } }), /loopback/);
});

test('accepts only the authenticated RELEASE broker on its private service address', () => {
  const value = { ...config, ownerId: 'release-memos', nats: {
    servers: ['nats://brai-release-nats:4222'], user: 'release_embeddings', password: 'synthetic',
  } };
  assert.deepEqual(validateConfig(value).nats.servers, ['nats://brai-release-nats:4222']);
  for (const servers of [
    ['nats://brai-release-nats:4223'], ['tls://brai-release-nats:4222'],
    ['nats://brai-release-nats:4222/'], ['nats://brai-release-nats:4222?x=1'],
    ['nats://evil@brai-release-nats:4222'], ['nats://other:4222'],
    ['nats://brai-release-nats:4222', 'nats://127.0.0.1:4222'],
  ]) assert.throws(() => validateConfig({ ...value, nats: { ...value.nats, servers } }));
  for (const user of ['', null, 5]) {
    assert.throws(() => validateConfig({ ...value, nats: { ...value.nats, user } }));
  }
  for (const password of ['', null, 5]) {
    assert.throws(() => validateConfig({ ...value, nats: { ...value.nats, password } }));
  }
  assert.throws(() => validateConfig({ ...value, ownerId: 'another-owner' }));
});

test('private RELEASE adapter stops listening after a terminal NATS disconnect', async () => {
  let closeConnection;
  let closed = false;
  const closedPromise = new Promise((resolve) => { closeConnection = resolve; });
  const nc = {
    isClosed: () => closed,
    isDraining: () => false,
    closed: () => closedPromise,
    drain: async () => { closed = true; closeConnection(); },
    request: async (_subject, bytes) => {
      const invocation = JSON.parse(bytes.toString());
      return { data: Buffer.from(JSON.stringify(localAiResponse(invocation, [Array(768).fill(0.5)]))) };
    },
  };
  let options;
  const release = { ...config, ownerId: 'release-memos', nats: {
    servers: ['nats://brai-release-nats:4222'], user: 'release_embeddings', password: 'synthetic',
  }, embedding: { ...config.embedding, port: 0 } };
  let terminal = 0;
  const beforeInt = process.listenerCount('SIGINT');
  const beforeTerm = process.listenerCount('SIGTERM');
  const { server, close } = await startEmbeddingAdapter(release, async (value) => { options = value; return nc; },
    () => { terminal++; });
  assert.equal(options.reconnect, false);
  assert.equal(options.ignoreClusterUpdates, true);
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${endpoint}/health`)).status, 200);
  const response = await fetch(`${endpoint}/v1/embeddings`, { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'embeddinggemma-2-q8', input: 'synthetic' }) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data[0].embedding.length, 768);
  const accepted = once(server, 'connection');
  const slow = httpRequest(`${endpoint}/v1/embeddings`, { method: 'POST' });
  slow.on('error', () => {});
  slow.write('{');
  await accepted;
  const stopped = once(server, 'close');
  closed = true;
  closeConnection();
  await stopped;
  assert.equal(server.listening, false);
  await Promise.all([close(), close()]);
  assert.equal(terminal, 1);
  assert.equal(process.listenerCount('SIGINT'), beforeInt);
  assert.equal(process.listenerCount('SIGTERM'), beforeTerm);
});

test('private RELEASE adapter rejects a connection already closed during startup', async () => {
  const nc = { isClosed: () => true, isDraining: () => false, closed: () => Promise.resolve() };
  const release = { ...config, ownerId: 'release-memos', nats: {
    servers: ['nats://brai-release-nats:4222'], user: 'release_embeddings', password: 'synthetic',
  }, embedding: { ...config.embedding, port: 0 } };
  await assert.rejects(startEmbeddingAdapter(release, async () => nc, () => {}), /closed during adapter startup/);
});

test('closes NATS if the HTTP listener cannot bind its port', async (t) => {
  const occupied = createServer();
  occupied.listen(0, '127.0.0.1');
  await once(occupied, 'listening');
  t.after(() => new Promise((resolve) => occupied.close(resolve)));
  let closed = false;
  const nc = {
    isClosed: () => closed, isDraining: () => false,
    closed: () => new Promise(() => {}),
    close: async () => { closed = true; },
  };
  const local = { ...config, embedding: { ...config.embedding, port: occupied.address().port } };
  await assert.rejects(startEmbeddingAdapter(local, async () => nc), { code: 'EADDRINUSE' });
  assert.equal(closed, true);
});

test('loopback configurations retain existing NATS connection defaults', async () => {
  let options;
  let closed;
  const nc = {
    isClosed: () => false, isDraining: () => false,
    closed: () => new Promise((resolve) => { closed = resolve; }),
    drain: async () => { closed?.(); },
  };
  const result = await startEmbeddingAdapter({ ...config, embedding: { ...config.embedding, port: 0 } },
    async (value) => { options = value; return nc; });
  assert.equal(options.reconnect, undefined);
  assert.equal(options.ignoreClusterUpdates, undefined);
  await result.close();
});

test('rejects malformed input and a request for another model before invoking NATS', async () => {
  let calls = 0;
  const invoke = async () => { calls++; return { vectors: [] }; };
  const mismatch = await handleEmbedding({ model: 'another-model', input: 'hello' }, config, invoke);
  assert.equal(mismatch.status, 400);
  assert.equal(mismatch.body.error.code, 'model_mismatch');
  const invalid = await handleEmbedding({ model: 'embeddinggemma-2-q8', input: ['valid', 3] }, config, invoke);
  assert.equal(invalid.status, 400);
  assert.equal(calls, 0);
});

test('preserves input batch order in the symmetric 768-dimensional response', async () => {
  let captured;
  const result = await handleEmbedding({ model: 'embeddinggemma-2-q8', input: ['first', 'second'] }, config, async (input) => {
    captured = input;
    return localAiResponse(input, input.texts.map((_, index) => Array(768).fill(index + 0.25)));
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.data.map((item) => item.index), [0, 1]);
  assert.deepEqual(result.body.data.map((item) => item.embedding[0]), [0.25, 1.25]);
  assert.equal(result.body.model, 'embeddinggemma-2-q8');
  assert.deepEqual(captured.texts, ['first', 'second']);
  assert.equal(captured.purpose, 'symmetric');
  assert.deepEqual(captured.model, config.embedding.model);
  assert.equal(captured.ownerId, config.ownerId);
  assert.ok(captured.requestId);
  assert.ok(captured.operationId);
});

test('rejects a LocalAI response that identifies another model', async () => {
  const result = await handleEmbedding({ model: 'embeddinggemma-2-q8', input: 'text' }, config, async (invocation) => ({
    ...localAiResponse(invocation, [Array(768).fill(0)]),
    model: { ...invocation.model, modelId: 'another-model' },
  }));
  assert.equal(result.status, 502);
  assert.equal(result.body.error.code, 'local_ai_model_mismatch');
});

test('maps a failed LocalAI NATS request to a safe service-unavailable response', async () => {
  const result = await handleEmbedding({ model: 'embeddinggemma-2-q8', input: 'test text' }, config, async () => {
    throw new Error('private NATS details');
  });
  assert.equal(result.status, 503);
  assert.equal(result.body.error.code, 'local_ai_unavailable');
  assert.equal(result.body.error.message, 'LocalAI embedding request failed');
  assert.equal(JSON.stringify(result).includes('private NATS details'), false);
});

test('rejects changed dimensions, encoding, or unknown parameters before invoking LocalAI', async () => {
  let calls = 0;
  const invoke = async () => { calls++; };
  const valid = { model: 'embeddinggemma-2-q8', input: 'synthetic' };
  for (const dimensions of [767, 769, 768.5, '768', true, false, null]) {
    const result = await handleEmbedding({ ...valid, dimensions }, config, invoke);
    assert.equal(result.status, 400);
    assert.equal(result.body.error.code, 'invalid_request');
  }
  for (const encoding_format of ['other', '', null, true]) {
    const result = await handleEmbedding({ ...valid, encoding_format }, config, invoke);
    assert.equal(result.status, 400);
  }
  const unknown = await handleEmbedding({ ...valid, user: 'synthetic' }, config, invoke);
  assert.equal(unknown.body.error.code, 'unsupported_parameter');
  assert.equal(calls, 0);
});

test('accepts fixed dimensions with explicit float and preserves numeric response', async () => {
  const vector = Array(768).fill(1 / 3);
  const result = await handleEmbedding({ model: 'embeddinggemma-2-q8', input: 'synthetic',
    dimensions: 768, encoding_format: 'float' }, config,
  async (input) => localAiResponse(input, [vector]));
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.data[0].embedding, vector);
});

test('serves the pinned Python SDK request shape as ordered little-endian float32 base64 over HTTP', async (t) => {
  const values = [0.1, -0.25, 1 / 3, 0];
  const vectors = values.map((value) => Array(768).fill(value));
  let captured;
  const server = createEmbeddingServer(config, async (input) => {
    captured = input;
    return localAiResponse(input, vectors);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  const input = values.map((_, index) => `synthetic ${index}`);
  // AIDEV-NOTE: universal_api задаёт dimensions; installed SDK добавляет base64 по умолчанию.
  const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/embeddings`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'embeddinggemma-2-q8', input, dimensions: 768, encoding_format: 'base64' }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.data.map((item) => item.index), [0, 1, 2, 3]);
  body.data.forEach((item, index) => {
    assert.equal(typeof item.embedding, 'string');
    const bytes = Buffer.from(item.embedding, 'base64');
    assert.equal(bytes.length, 768 * 4);
    for (let position = 0; position < 768; position++) {
      assert.equal(bytes.readFloatLE(position * 4), Math.fround(values[index]));
    }
  });
  assert.deepEqual(captured.texts, input);
  assert.equal(captured.ownerId, config.ownerId);
  assert.equal(captured.purpose, 'symmetric');
  assert.deepEqual(captured.model, config.embedding.model);
  assert.equal('dimensions' in captured, false);
  assert.equal('encoding_format' in captured, false);
});

test('rejects invalid LocalAI vectors and float32 overflow instead of returning corrupt base64', async () => {
  for (const vector of [Array(767).fill(0), Array(768).fill(NaN), Array(768).fill(Infinity), Array(768).fill(1e100)]) {
    const result = await handleEmbedding({ model: 'embeddinggemma-2-q8', input: 'synthetic',
      encoding_format: 'base64' }, config, async (input) => localAiResponse(input, [vector]));
    assert.equal(result.status, 502);
    assert.equal(result.body.error.code, 'invalid_local_ai_response');
  }
});
