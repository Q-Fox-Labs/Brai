// ABOUTME: Проверяет mapping local executor, NATS adapter и настоящий stdio child.
// ABOUTME: Request doubles проверяют границу, но не заявляют runtime интеграцию с local-ai.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadLocalExecutorConfig } from '../../dist/executors/local/config.js';
import { createLocalExecutor } from '../../dist/executors/local/adapter.js';
import * as ownerContracts from '../../../local-ai/contracts/index.mjs';

const model = { modelId: 'whisper/local:large-v3', revision: 'sha256:0123456789abcdef', profileId: 'transcribe/ggml' };
const request = (changes = {}) => ({
  requestId: 'c7bd3fa1-376b-49e8-badf-8c2d1eac1c00',
  operationId: 'acaf5b10-5ee4-4c4b-9332-8d3a7c1f2f19',
  audioArtifactId: '27a817b6-2030-4ae1-8831-441886f02062',
  ownerId: 'user_123',
  model,
  deadlineAt: new Date(Date.now() + 30_000).toISOString(),
  ...changes,
});
const component = { state: 'ready', errorCode: null };
const ownerStatus = (state = 'ready') => ({
  state,
  components: { database: component, nats: component, executables: component, weights: component, history: component, outbox: component },
  outboxCounts: { reserved: 0, pending: 0, sending: 0, permanentlyFailed: 0, oldestCreatedAt: null },
});
const ownerSuccess = (input, changes = {}) => ({
  requestId: input.operationId,
  operationId: input.operationId,
  model: input.model,
  durationMs: 25,
  text: 'recognized words',
  segments: null,
  ...changes,
});
const reply = (body, headers = {}) => ({
  data: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)),
  headers: { get: (name) => headers[name] ?? '' },
});
const connection = (respond) => ({
  isClosed: () => false,
  isDraining: () => false,
  close: async () => {},
  request: respond,
});
const provider = (value, configured = true) => ({ configured, getConnection: async () => value });
const makeExecutor = (client, { configured = true, timeout = 500, responseBytes = 4096, hopTimeout = 300 } = {}) =>
  createLocalExecutor(provider(client, configured), ownerContracts, timeout, responseBytes, hopTimeout);

function baseEnv() {
  return {
    TRANSCRIPTION_RPC_FRAME_BYTES: '4096',
    TRANSCRIPTION_RPC_BATCH_ITEMS: '8',
    TRANSCRIPTION_RPC_CONCURRENT_REQUESTS: '3',
    TRANSCRIPTION_RPC_CONCURRENT_EXECUTE: '1',
  };
}

function lineReader(stream, label, diagnostic = () => '') {
  const ready = [];
  const pending = [];
  let buffer = '';
  stream.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const value = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const resolve = pending.shift();
      if (resolve) resolve(value);
      else ready.push(value);
    }
  });
  return {
    ready,
    next() {
      if (ready.length) return Promise.resolve(ready.shift());
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}; stderr=${diagnostic()}`)), 2000);
        pending.push((value) => { clearTimeout(timer); resolve(value); });
      });
    },
  };
}

test('config requires finite RPC limits and explicit isolated local-ai connection limits', () => {
  const config = loadLocalExecutorConfig({
    ...baseEnv(),
    TRANSCRIPTION_LOCAL_AI_NATS_URL: 'nats://nats.test:4222',
    TRANSCRIPTION_LOCAL_AI_NATS_INBOX_PREFIX: '_INBOX.brai_transcription_local',
    TRANSCRIPTION_LOCAL_AI_NATS_USER: 'executor',
    TRANSCRIPTION_LOCAL_AI_NATS_PASSWORD: 'secret-fixture',
    TRANSCRIPTION_LOCAL_AI_CONTROL_TIMEOUT_MS: '500',
    TRANSCRIPTION_LOCAL_AI_HOP_TIMEOUT_MS: '1200',
    TRANSCRIPTION_LOCAL_AI_RESPONSE_BYTES: '2048',
    NATS_URL: 'nats://ignored.test:4222',
  });
  assert.deepEqual(config.nats, { servers: ['nats://nats.test:4222'], inboxPrefix: '_INBOX.brai_transcription_local', user: 'executor', password: 'secret-fixture' });
  assert.equal(config.controlTimeoutMs, 500);
  assert.equal(config.hopTimeoutMs, 1200);
  assert.equal(config.responseBytes, 2048);
  assert.equal(loadLocalExecutorConfig(baseEnv()).nats, undefined);
  const configuredEnv = {
    ...baseEnv(), TRANSCRIPTION_LOCAL_AI_NATS_URL: 'nats://host:4222',
    TRANSCRIPTION_LOCAL_AI_CONTROL_TIMEOUT_MS: '10', TRANSCRIPTION_LOCAL_AI_HOP_TIMEOUT_MS: '10',
    TRANSCRIPTION_LOCAL_AI_RESPONSE_BYTES: '10', TRANSCRIPTION_LOCAL_AI_NATS_INBOX_PREFIX: '_INBOX.brai_transcription_local',
  };
  assert.throws(() => loadLocalExecutorConfig({ ...configuredEnv, TRANSCRIPTION_LOCAL_AI_NATS_INBOX_PREFIX: undefined }), /INVALID_LOCAL_EXECUTOR_CONFIG/);
  for (const prefix of ['', 'bad.*', 'bad.>', 'bad..prefix', 'bad prefix', 'bad\tprefix', 'bad\u0000prefix']) {
    assert.throws(() => loadLocalExecutorConfig({ ...configuredEnv, TRANSCRIPTION_LOCAL_AI_NATS_INBOX_PREFIX: prefix }), /INVALID_LOCAL_EXECUTOR_CONFIG/);
  }
  assert.equal(loadLocalExecutorConfig(configuredEnv).nats.inboxPrefix, '_INBOX.brai_transcription_local');
  assert.throws(() => loadLocalExecutorConfig({ ...configuredEnv, TRANSCRIPTION_LOCAL_AI_NATS_URL: undefined }), /INVALID_LOCAL_EXECUTOR_CONFIG/);
  assert.throws(() => loadLocalExecutorConfig({ ...configuredEnv, TRANSCRIPTION_LOCAL_AI_NATS_URL: 'nats://user:pass@host:4222' }), /INVALID_LOCAL_EXECUTOR_CONFIG/);
  assert.throws(() => loadLocalExecutorConfig({ ...configuredEnv, TRANSCRIPTION_LOCAL_AI_NATS_URL: 'nats://host:4222/path' }), /INVALID_LOCAL_EXECUTOR_CONFIG/);
  assert.throws(() => loadLocalExecutorConfig({ ...baseEnv(), TRANSCRIPTION_RPC_CONCURRENT_EXECUTE: '3' }), /INVALID_LOCAL_EXECUTOR_CONFIG/);
  assert.throws(() => loadLocalExecutorConfig({ ...baseEnv(), TRANSCRIPTION_RPC_FRAME_BYTES: '0' }), /INVALID_LOCAL_EXECUTOR_CONFIG/);
});

test('execute maps owner response and sends both wire ids as the attempt id', async () => {
  const input = request();
  let received;
  const client = connection(async (subject, data, options) => {
    received = { subject, value: JSON.parse(Buffer.from(data).toString('utf8')), options };
    return reply(ownerSuccess(input));
  });
  const result = await makeExecutor(client).handlers.execute(input);
  assert.equal(received.subject, ownerContracts.subjects.invokeTranscribe);
  assert.deepEqual(received.value, {
    requestId: input.operationId,
    operationId: input.operationId,
    model: input.model,
    ownerId: input.ownerId,
    deadlineAt: input.deadlineAt,
    audioArtifactId: input.audioArtifactId,
  });
  assert.ok(received.options.timeout > 0 && received.options.timeout <= 300);
  assert.deepEqual(result, {
    requestId: input.requestId,
    operationId: input.operationId,
    actualModel: input.model,
    text: 'recognized words',
    segments: null,
    durationMs: 25,
    usage: null,
    cost: null,
  });
});

test('owner ids must match the attempt; model selector mismatch stays typed', async () => {
  const input = request();
  const idClient = connection(async (_subject, _data) => reply(ownerSuccess(input, { requestId: input.requestId })));
  await assert.rejects(makeExecutor(idClient).handlers.execute(input), (error) => error.errorCode === 'REQUEST_OUTCOME_UNKNOWN');

  const modelClient = connection(async (_subject, _data) => reply(ownerSuccess(input, { model: { ...model, revision: 'other' } })));
  await assert.rejects(makeExecutor(modelClient).handlers.execute(input), (error) => error.errorCode === 'MODEL_MISMATCH');
});

test('owner error headers and DTO map through a finite safe allowlist', async () => {
  const input = request();
  const client = connection(async () => reply(
    { code: 'BUSY', message: 'private transcript must not escape', retryable: true },
    { 'Nats-Service-Error': 'BUSY', 'Nats-Service-Error-Code': '429' },
  ));
  await assert.rejects(makeExecutor(client).handlers.execute(input), (error) => {
    assert.equal(error.errorCode, 'OVERLOADED');
    assert.equal(error.message.includes('private transcript'), false);
    return true;
  });

  const mismatch = connection(async () => reply(
    { code: 'BUSY', message: 'private', retryable: true },
    { 'Nats-Service-Error': 'INTERNAL', 'Nats-Service-Error-Code': '429' },
  ));
  await assert.rejects(makeExecutor(mismatch).handlers.execute(input), (error) => error.errorCode === 'REQUEST_OUTCOME_UNKNOWN');

  const badStatus = connection(async () => reply(
    { code: 'BUSY', message: 'private', retryable: true },
    { 'Nats-Service-Error': 'BUSY', 'Nats-Service-Error-Code': '200' },
  ));
  await assert.rejects(makeExecutor(badStatus).handlers.execute(input), (error) => error.errorCode === 'REQUEST_OUTCOME_UNKNOWN');
});

test('transport errors, malformed and oversized replies are unknown without another invoke', async () => {
  const input = request();
  let calls = 0;
  const timeout = connection(async () => { calls++; throw new Error('private connection detail'); });
  await assert.rejects(makeExecutor(timeout).handlers.execute(input), (error) => error.errorCode === 'REQUEST_OUTCOME_UNKNOWN');
  assert.equal(calls, 1);

  const malformed = connection(async () => { calls++; return reply('{broken'); });
  await assert.rejects(makeExecutor(malformed).handlers.execute(input), (error) => error.errorCode === 'REQUEST_OUTCOME_UNKNOWN');
  assert.equal(calls, 2);

  const oversized = connection(async () => { calls++; return reply(ownerSuccess(input)); });
  await assert.rejects(makeExecutor(oversized, { responseBytes: 8 }).handlers.execute(input), (error) => error.errorCode === 'REQUEST_OUTCOME_UNKNOWN');
  assert.equal(calls, 3);
});

test('expired and late deadlines never become false success; far deadlines use finite hop timeout', async () => {
  let calls = 0;
  const client = connection(async (_subject, _data, options) => {
    calls++;
    await delay(80);
    assert.ok(options.timeout <= 40);
    return reply(ownerSuccess(input));
  });
  const input = request({ deadlineAt: new Date(Date.now() + 40).toISOString() });
  await assert.rejects(makeExecutor(client).handlers.execute(input), (error) => error.errorCode === 'REQUEST_OUTCOME_UNKNOWN');
  assert.equal(calls, 1);

  const unsent = connection(async () => { calls++; return reply(ownerSuccess(request())); });
  await assert.rejects(makeExecutor(unsent).handlers.execute(request({ deadlineAt: new Date(Date.now() - 1000).toISOString() })),
    (error) => error.errorCode === 'DEADLINE_EXCEEDED');
  assert.equal(calls, 1);

  let forwarded;
  const farDeadline = '9999-12-31T23:59:59.999Z';
  const far = connection(async (_subject, data, options) => {
    forwarded = { value: JSON.parse(Buffer.from(data).toString('utf8')), timeout: options.timeout };
    return reply(ownerSuccess(forwarded.value));
  });
  const farInput = request({ deadlineAt: farDeadline });
  const farResult = await makeExecutor(far, { hopTimeout: 1234 }).handlers.execute(farInput);
  assert.equal(forwarded.value.deadlineAt, farDeadline);
  assert.equal(forwarded.timeout, 1234);
  assert.equal(farResult.requestId, farInput.requestId);

  let hopCalls = 0;
  const hopTimeout = connection(async (_subject, _data, options) => {
    hopCalls++;
    assert.equal(options.timeout, 321);
    throw new Error('hop timeout while owner deadline remains in future');
  });
  await assert.rejects(makeExecutor(hopTimeout, { hopTimeout: 321 }).handlers.execute(request()),
    (error) => error.errorCode === 'REQUEST_OUTCOME_UNKNOWN');
  assert.equal(hopCalls, 1);
});

test('slow connection setup is checked again before invocation is sent', async () => {
  let calls = 0;
  const client = connection(async () => { calls++; return reply(ownerSuccess(request())); });
  const delayedProvider = {
    configured: true,
    async getConnection() { await delay(80); return client; },
  };
  const input = request({ deadlineAt: new Date(Date.now() + 40).toISOString() });
  await assert.rejects(createLocalExecutor(delayedProvider, ownerContracts, 500, 4096, 300).handlers.execute(input),
    (error) => error.errorCode === 'DEADLINE_EXCEEDED');
  assert.equal(calls, 0);
});

test('health is verified by owner status and cancel never claims stop', async () => {
  const statusClient = connection(async (subject) => {
    assert.equal(subject, ownerContracts.subjects.status);
    return reply(ownerStatus('degraded'));
  });
  const executor = makeExecutor(statusClient);
  assert.deepEqual(await executor.handlers.health(), { configured: true, verified: true, available: false });
  assert.deepEqual(await executor.handlers.cancel({ requestId: request().requestId, operationId: request().operationId }), { accepted: false, stopConfirmed: false });

  const absent = createLocalExecutor(provider(undefined, false), ownerContracts);
  assert.deepEqual(await absent.handlers.health(), { configured: false, verified: false, available: false });
  await assert.rejects(absent.handlers.execute(request()), (error) => error.errorCode === 'DEPENDENCY_UNAVAILABLE');
});

test('real child keeps health and cancel responsive while execute is pending', async (t) => {
  const env = { ...process.env, TRANSCRIPTION_RPC_FRAME_BYTES: '4096', TRANSCRIPTION_RPC_BATCH_ITEMS: '8', TRANSCRIPTION_RPC_CONCURRENT_REQUESTS: '3', TRANSCRIPTION_RPC_CONCURRENT_EXECUTE: '1' };
  for (const name of ['TRANSCRIPTION_LOCAL_AI_NATS_URL', 'TRANSCRIPTION_LOCAL_AI_NATS_USER', 'TRANSCRIPTION_LOCAL_AI_NATS_PASSWORD', 'TRANSCRIPTION_LOCAL_AI_NATS_TOKEN', 'TRANSCRIPTION_LOCAL_AI_NATS_INBOX_PREFIX', 'TRANSCRIPTION_LOCAL_AI_CONTROL_TIMEOUT_MS', 'TRANSCRIPTION_LOCAL_AI_HOP_TIMEOUT_MS', 'TRANSCRIPTION_LOCAL_AI_RESPONSE_BYTES']) delete env[name];
  const child = spawn(process.execPath, [fileURLToPath(new URL('./stdio-child.mjs', import.meta.url))], { stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'], env });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  const output = lineReader(child.stdout, 'fixture stdout', () => stderr);
  const events = lineReader(child.stdio[4], 'fixture invoke event', () => stderr);
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const input = request();
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 'execute', method: 'execute', params: input }) + '\n');
  assert.equal(await events.next(), 'invoke-started');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 'overload', method: 'execute', params: input }) + '\n');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 'health', method: 'health', params: {} }) + '\n');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 'cancel', method: 'cancel', params: { requestId: input.requestId, operationId: input.operationId } }) + '\n');
  const responses = [JSON.parse(await output.next()), JSON.parse(await output.next()), JSON.parse(await output.next())];
  const byId = new Map(responses.map((value) => [value.id, value]));
  assert.equal(byId.get('overload').error.data.errorCode, 'OVERLOADED');
  assert.deepEqual(byId.get('health').result, { configured: true, verified: true, available: true });
  assert.deepEqual(byId.get('cancel').result, { accepted: false, stopConfirmed: false });
  await delay(30);
  assert.equal(output.ready.length, 0);
  child.stdio[3].write('release\n');
  const completed = JSON.parse(await output.next());
  assert.equal(completed.id, 'execute');
  assert.equal(completed.result.requestId, input.requestId);
  assert.equal(completed.result.operationId, input.operationId);
  assert.equal(completed.result.actualModel.profileId, model.profileId);
  child.stdin.end();
  child.stdio[3].end();
  assert.equal((await Promise.race([once(child, 'exit'), delay(2000).then(() => { throw new Error(`fixture child did not exit; stderr=${stderr}`); })]))[0], 0);
});

test('production child starts without local-ai config and reports honest unavailable state', async (t) => {
  const env = { ...process.env, TRANSCRIPTION_RPC_FRAME_BYTES: '4096', TRANSCRIPTION_RPC_BATCH_ITEMS: '8', TRANSCRIPTION_RPC_CONCURRENT_REQUESTS: '3', TRANSCRIPTION_RPC_CONCURRENT_EXECUTE: '1' };
  for (const name of ['TRANSCRIPTION_LOCAL_AI_NATS_URL', 'TRANSCRIPTION_LOCAL_AI_NATS_USER', 'TRANSCRIPTION_LOCAL_AI_NATS_PASSWORD', 'TRANSCRIPTION_LOCAL_AI_NATS_TOKEN', 'TRANSCRIPTION_LOCAL_AI_NATS_INBOX_PREFIX', 'TRANSCRIPTION_LOCAL_AI_CONTROL_TIMEOUT_MS', 'TRANSCRIPTION_LOCAL_AI_HOP_TIMEOUT_MS', 'TRANSCRIPTION_LOCAL_AI_RESPONSE_BYTES']) delete env[name];
  const main = fileURLToPath(new URL('../../dist/executors/local/main.js', import.meta.url));
  const child = spawn(process.execPath, [main], { stdio: ['pipe', 'pipe', 'pipe'], env });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  const output = lineReader(child.stdout, 'production stdout', () => stderr);
  t.after(() => { if (child.exitCode === null) child.kill(); });
  child.stdin.write('{broken\n');
  const parse = JSON.parse(await output.next());
  assert.equal(parse.error.code, -32700);
  assert.equal(parse.id, null);
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 'health', method: 'health', params: {} }) + '\n');
  assert.deepEqual(JSON.parse(await output.next()).result, { configured: false, verified: false, available: false });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 'cancel', method: 'cancel', params: { requestId: request().requestId, operationId: request().operationId } }) + '\n');
  assert.deepEqual(JSON.parse(await output.next()).result, { accepted: false, stopConfirmed: false });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 'execute', method: 'execute', params: request() }) + '\n');
  assert.equal(JSON.parse(await output.next()).error.data.errorCode, 'DEPENDENCY_UNAVAILABLE');
  child.stdin.end();
  assert.equal((await Promise.race([once(child, 'exit'), delay(2000).then(() => { throw new Error(`production child did not exit; stderr=${stderr}`); })]))[0], 0);
});
