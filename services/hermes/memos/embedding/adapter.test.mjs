// ABOUTME: Проверяет HTTP-контракт MemOS embedding adapter на изолированном NATS порту.
// ABOUTME: Подменяет invoke, не вызывает модель и не отправляет реальные данные.
import assert from 'node:assert/strict';
import { createEmbeddingServer, handleEmbedding, validateConfig } from './adapter.mjs';
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

test('accepts only the DEV loopback NATS listener on port 4223', () => {
  assert.equal(validateConfig(config).nats.servers[0], 'nats://127.0.0.1:4223');
  assert.throws(() => validateConfig({ ...config, nats: { servers: ['nats://127.0.0.1:4222'] } }), /port 4223/);
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
