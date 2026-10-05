// ABOUTME: Проверяет независимо запускаемый отключённый внешний исполнитель через настоящий stdio.
// ABOUTME: Входы синтетические; guards исключают сеть, provider subprocess и сохранение содержимого.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { validateDto } from '../../../contracts/index.mjs';

const entrypoint = fileURLToPath(new URL('../../../dist/executors/external/main.js', import.meta.url));
const preload = fileURLToPath(new URL('./fixtures/no-side-effects.mjs', import.meta.url));
const worktreeTmp = fileURLToPath(new URL('../../../../../tmp/', import.meta.url));
const configuration = {
  TRANSCRIPTION_RPC_FRAME_BYTES: '8192',
  TRANSCRIPTION_RPC_BATCH_ITEMS: '8',
  TRANSCRIPTION_RPC_CONCURRENT_REQUESTS: '4',
  TRANSCRIPTION_RPC_CONCURRENT_EXECUTE: '1',
};
const executeParams = {
  requestId: 'c7bd3fa1-376b-49e8-badf-8c2d1eac1c00',
  operationId: 'acaf5b10-5ee4-4c4b-9332-8d3a7c1f2f19',
  audioArtifactId: '27a817b6-2030-4ae1-8831-441886f02062',
  ownerId: 'synthetic_owner',
  model: null,
  deadlineAt: '2030-01-01T00:00:00Z',
};
const cancelParams = { requestId: executeParams.requestId, operationId: executeParams.operationId };
const call = (id, method, params = {}) => ({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, params });
const ndjson = (value) => JSON.stringify(value) + '\n';

async function runProcess(input = '', overrides = {}, script) {
  const cwd = await mkdtemp(path.join(worktreeTmp, 'external-executor-acceptance-'));
  const env = { ...configuration, ...overrides };
  for (const [name, value] of Object.entries(env)) if (value === undefined) delete env[name];
  const child = spawn(process.execPath, ['--import', preload, ...(script ? ['--input-type=module', '-e', script] : [entrypoint])], {
    cwd, env, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (value) => { stdout += value; });
  child.stderr.on('data', (value) => { stderr += value; });
  child.stdin.on('error', () => {}); // Missing config may exit before stdin is consumed.
  try {
    const exited = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error('External executor did not terminate at EOF')); }, 15000);
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
    });
    child.stdin.end(input);
    const outcome = await exited;
    assert.deepEqual(await readdir(cwd), [], 'Executor wrote files in its isolated working directory');
    return { ...outcome, stdout, stderr, responses: stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line)) };
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await rm(cwd, { recursive: true, force: true });
  }
}

function clean(result) {
  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, '');
  assert.ok(result.stdout === '' || result.stdout.endsWith('\n'));
}

test('actual executor reports health unavailable, explicit refusal and unconfirmed cancel', async () => {
  assert.equal(validateDto('ExternalExecuteParams', executeParams), true);
  assert.equal(validateDto('LocalCancelParams', cancelParams), true);
  const result = await runProcess([
    call('health', 'health'), call('execute', 'execute', executeParams), call('cancel', 'cancel', cancelParams),
  ].map(ndjson).join(''), { EXTERNAL_PROVIDER_API_KEY: 'synthetic_key_must_not_be_used' });
  clean(result);
  const responses = new Map(result.responses.map((response) => [response.id, response]));
  assert.equal(responses.size, 3);
  for (const [id, dto, value] of [
    ['health', 'ExternalHealthResult', { available: false }],
    ['execute', 'ExternalExecuteResult', { errorCode: 'EXTERNAL_ROUTE_UNAVAILABLE' }],
    ['cancel', 'ExternalCancelResult', { accepted: false, stopConfirmed: false }],
  ]) {
    const response = responses.get(id);
    assert.deepEqual(response, { jsonrpc: '2.0', id, result: value });
    assert.equal(validateDto(dto, response.result), true);
  }
  assert.equal(result.stdout.includes('synthetic_key'), false);
  assert.equal(result.stdout.includes('synthetic_owner'), false);
});

test('health omission is allowed; closed DTOs and unknown methods return standard errors with original ids', async () => {
  const marker = 'private synthetic audio and text';
  const invalidCases = [
    call('extra', 'execute', { ...executeParams, text: marker }),
    call('url', 'execute', { ...executeParams, audioUrl: 'https://invalid.example/audio' }),
    call('missing-field', 'execute', { requestId: executeParams.requestId }),
    call('cancel-extra', 'cancel', { ...cancelParams, credentials: marker }),
    call('health-null', 'health', null),
    call('health-positional', 'health', []),
    call('health-extra', 'health', { text: marker }),
    call('unknown', 'provider.invoke', { text: marker }),
  ];
  const result = await runProcess(ndjson({ jsonrpc: '2.0', id: 'omitted', method: 'health' }) + invalidCases.map(ndjson).join(''));
  clean(result);
  const responses = new Map(result.responses.map((response) => [response.id, response]));
  assert.equal(responses.size, invalidCases.length + 1);
  assert.deepEqual(responses.get('omitted'), { jsonrpc: '2.0', id: 'omitted', result: { available: false } });
  for (const request of invalidCases) {
    const response = responses.get(request.id);
    assert.equal(response.error.code, request.id === 'unknown' ? -32601 : -32602);
    assert.deepEqual(Object.keys(response).sort(), ['error', 'id', 'jsonrpc']);
    assert.deepEqual(Object.keys(response.error).sort(), ['code', 'message']);
  }
  assert.equal(result.stdout.includes(marker), false);
  assert.equal(result.stderr.includes(marker), false);
});

test('actual batch omits notification replies and malformed input has null parse-error id', async () => {
  const batch = [call('execution', 'execute', executeParams), call(undefined, 'execute', executeParams),
    call('control', 'health'), call(undefined, 'cancel', cancelParams)];
  const result = await runProcess('malformed JSON\n' + ndjson(batch));
  clean(result);
  assert.equal(result.responses.length, 2);
  const parsed = result.responses.find((response) => !Array.isArray(response));
  assert.equal(parsed.id, null);
  assert.equal(parsed.error.code, -32700);
  const responses = result.responses.find(Array.isArray);
  assert.equal(responses.length, 2);
  assert.deepEqual(new Set(responses.map((response) => response.id)), new Set(['execution', 'control']));
  assert.deepEqual(responses.find((response) => response.id === 'execution').result, { errorCode: 'EXTERNAL_ROUTE_UNAVAILABLE' });
  assert.deepEqual(responses.find((response) => response.id === 'control').result, { available: false });
});

test('notifications alone and empty EOF exit cleanly without producing responses or files', async () => {
  for (const input of ['', ndjson(call(undefined, 'execute', executeParams)), ndjson([
    call(undefined, 'health'), call(undefined, 'cancel', cancelParams), call(undefined, 'unknown'),
  ])]) {
    const result = await runProcess(input);
    clean(result);
    assert.deepEqual(result.responses, []);
    assert.equal(result.stdout, '');
  }
});

test('required resource settings reject missing/nonpositive/noninteger/unsafe values without reflecting configuration', async () => {
  const marker = 'private-setting-value';
  const cases = [];
  for (const key of Object.keys(configuration)) {
    for (const value of [undefined, '0', '-1', '1.5', '9007199254740992', marker]) cases.push({ [key]: value });
  }
  cases.push({ TRANSCRIPTION_RPC_CONCURRENT_EXECUTE: '4' });
  cases.push({ TRANSCRIPTION_RPC_CONCURRENT_EXECUTE: '5' });
  for (const overrides of cases) {
    const result = await runProcess(ndjson(call('never-dispatched', 'execute', { ...executeParams, text: marker })), overrides);
    assert.equal(result.code, 1);
    assert.equal(result.signal, null);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'transcription external executor stopped\n');
    assert.equal(result.stderr.includes(marker), false);
    assert.equal(result.stderr.includes('9007199254740992'), false);
  }
});

test('external program applies configured batch limit without dispatching fake success', async () => {
  const result = await runProcess(ndjson([call('a', 'execute', executeParams), call(undefined, 'execute', executeParams), call('b', 'health')]), {
    TRANSCRIPTION_RPC_BATCH_ITEMS: '2',
  });
  clean(result);
  assert.deepEqual(result.responses[0].map((response) => [response.id, response.error.code, response.error.data.errorCode]), [
    ['a', -32000, 'OVERLOADED'], ['b', -32000, 'OVERLOADED'],
  ]);
});

test('preload guards catch attempted network and content writes even when application catches the error', async () => {
  const network = await runProcess('', {}, 'try { await fetch("http://127.0.0.1:1/never-send"); } catch {}');
  assert.equal(network.code, 90);
  assert.equal(network.stdout, '');
  assert.match(network.stderr, /EXTERNAL_NETWORK_ATTEMPT/);
  const storage = await runProcess('', {}, 'import { writeFileSync } from "node:fs"; try { writeFileSync("forbidden.txt", "synthetic text"); } catch {}');
  assert.equal(storage.code, 91);
  assert.equal(storage.stdout, '');
  assert.match(storage.stderr, /EXTERNAL_STORAGE_ATTEMPT/);
});
