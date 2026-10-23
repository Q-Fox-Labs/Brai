// ABOUTME: Проверяет тонкий CLI и общий NATS-клиент без запуска установленных служб.
// ABOUTME: Проверяет поведение границ и повторы; реальную интеграцию NATS выполняет отдельная приёмка.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {runCLI} from '../src/cli.mjs';
import {connectClient, loadClientConfig, loadNatsOptions} from '../src/client.mjs';

const workspaceId = '00000000-0000-4000-8000-000000000001';
const operationId = '00000000-0000-4000-8000-000000000002';
const testCreds = Buffer.from('-----BEGIN NATS USER JWT-----\ntest-only-jwt\n------END NATS USER JWT------\n-----BEGIN USER NKEY SEED-----\ntest-only-seed\n------END USER NKEY SEED------\n');

function fixture(extra = {}) {
  let output = '', errors = '', closes = 0;
  const calls = [];
  return {calls, get output() { return output; }, get errors() { return errors; }, get closes() { return closes; }, options: {argv: [], stdin: [], env: {}, stdout: {write: value => { output += value; }}, stderr: {write: value => { errors += value; }}, connect: async config => ({call: async (method, args) => { calls.push({config, method, args}); return {operation_id: operationId, workspace_id: workspaceId, path: '/worktree', branch: 'codex/demo'}; }, close: () => { closes++; }}), ...extra}};
}

test('help and owner-derived schema do not read configuration or connect', async () => {
  for (const flag of ['--help', '--schema']) {
    const f = fixture({argv: [flag], env: {CODEWORKS_CLIENT_CONFIG: '/missing'}, connect: () => assert.fail('offline command connects')});
    assert.equal(await runCLI(f.options), 0);
    if (flag === '--schema') {
      const schema = JSON.parse(f.output);
      assert.ok(schema.oneOf.some(item => item.properties.action.const === 'prepare'));
      assert.ok(schema.oneOf.every(item => item.additionalProperties === false));
    }
  }
});

test('explicit prepare routes action, preserves key and defaults kind and workspace hint', async () => {
  const f = fixture({argv: ['--request-json', JSON.stringify({action: 'prepare', project_id: 'demo', request_key: 'create-1'})], env: {CODEX_THREAD_ID: 'chat-1'}});
  assert.equal(await runCLI(f.options), 0);
  assert.equal(f.calls[0].method, 'prepare');
  assert.deepEqual(f.calls[0].args, {project_id: 'demo', workspace_key: 'chat-1', kind: 'feature', request_key: 'create-1'});
  assert.equal(f.closes, 1);
});

test('stdin status without IDs lists project areas', async () => {
  const f = fixture({stdin: ['{"action":"status",', '"project_id":"demo"}']});
  assert.equal(await runCLI(f.options), 0);
  assert.deepEqual(f.calls[0].args, {project_id: 'demo'});
});

test('sync and release forward the native commit SHA and caller key', async () => {
  for (const action of ['sync', 'release']) {
    const args = {project_id: 'demo', workspace_id: workspaceId, commit_sha: 'a'.repeat(40), request_key: action + '-1'};
    const f = fixture({stdin: [JSON.stringify({action, ...args})]});
    assert.equal(await runCLI(f.options), 0);
    assert.equal(f.calls[0].method, action);
    assert.deepEqual(f.calls[0].args, args);
  }
});

for (const request of ['{', '[]', 'null', '{"action":"status"}', '{"action":"batch","project_id":"demo"}', '{"action":"prepare","project_id":"demo","workspace_key":"x"}', '{"action":"status","project_id":"demo","command":"touch file"}', ' '.repeat(65537)]) {
  test(`rejects malformed or unsupported input before connection (${request.slice(0, 35)})`, async () => {
    const f = fixture({stdin: [request], connect: () => assert.fail('invalid input connects')});
    assert.equal(await runCLI(f.options), 1);
    assert.equal(JSON.parse(f.errors).code, 'INVALID_ARGUMENT');
  });
}

test('UTF-8 bytes rather than character count enforce the limit', async () => {
  const f = fixture({argv: ['--request-json', JSON.stringify({action: 'status', project_id: 'demo', value: 'я'.repeat(33000)})], connect: () => assert.fail('oversized input connects')});
  assert.equal(await runCLI(f.options), 1);
  assert.equal(JSON.parse(f.errors).code, 'INVALID_ARGUMENT');
});

test('timeout keeps caller request_key unchanged on retry and closes connection', async () => {
  const calls = [];
  let closes = 0;
  for (let i = 0; i < 2; i++) {
    const f = fixture({stdin: [JSON.stringify({action: 'cleanup', project_id: 'demo', workspace_id: workspaceId, request_key: 'cleanup-1'})], connect: async () => ({call: async (method, args) => { calls.push({method, args}); throw new Error('private address'); }, close: () => { closes++; }})});
    assert.equal(await runCLI(f.options), 1);
    assert.match(f.errors, /same request_key/);
    assert.doesNotMatch(f.errors, /private address/);
  }
  assert.deepEqual(calls[0], calls[1]);
  assert.equal(closes, 2);
});

test('public config supplies connection and explicit environment overrides its three fields', async () => {
  const directory = await mkdtemp('/tmp/codeworks-cli-');
  try {
    const file = directory + '/client.json';
    await writeFile(file, JSON.stringify({server: 'nats://file', credsFile: '/file.creds', executorId: 'file'}));
    assert.deepEqual(await loadClientConfig({CODEWORKS_CLIENT_CONFIG: file}), {server: 'nats://file', credsFile: '/file.creds', executorId: 'file'});
    assert.deepEqual(await loadClientConfig({CODEWORKS_CLIENT_CONFIG: file, CODEWORKS_NATS_URL: 'nats://env', CODEWORKS_NATS_CREDS_FILE: '/env.creds', CODEWORKS_EXECUTOR_ID: 'env'}), {server: 'nats://env', credsFile: '/env.creds', executorId: 'env'});
    assert.equal((await loadClientConfig({CODEWORKS_CLIENT_CONFIG: file, CODEWORKS_NATS_CONFIG: '/protected-nats.json', CODEWORKS_NATS_CREDS_FILE: '/other.creds'})).credsFile, '/protected-nats.json');
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test('NATS client uses v2 subject, owner validation and service error headers', async () => {
  const requests = [];
  let fail = false, closed = false;
  const client = await connectClient({server: 'nats://test', credsFile: '/test.creds', executorId: 'tester'}, {readCredentials: async () => testCreds, connectNats: async () => ({request: async (subject, bytes, options) => {
    requests.push({subject, args: JSON.parse(bytes), options});
    return {data: Buffer.from(JSON.stringify(fail ? {code: 'NOT_FOUND', message: 'NOT_FOUND', retryable: false} : {workspaces: []})), headers: {get: name => fail && name === 'Nats-Service-Error-Code' ? '404' : ''}};
  }, close: () => { closed = true; }})});
  assert.deepEqual(await client.call('status', {project_id: 'demo'}), {workspaces: []});
  assert.equal(requests[0].subject, 'brai.codeworks.v2.tester.status');
  assert.equal(requests[0].options.timeout, 10000);
  await assert.rejects(() => client.call('status', {}), {code: 'INVALID_ARGUMENT'});
  assert.equal(requests.length, 1);
  fail = true;
  await assert.rejects(() => client.call('status', {project_id: 'demo'}), {code: 'NOT_FOUND'});
  await client.close();
  assert.equal(closed, true);
});

test('existing protected JSON preserves credentials and ACL inbox prefix with optional endpoint override', async () => {
  const options = {servers: ['nats://test-a', 'nats://test-b'], user: 'test-only-user', pass: 'test-only-password', inboxPrefix: '_INBOX.codeworks.tester'};
  for (const server of [undefined, 'nats://override']) {
    let connected;
    const client = await connectClient({server, credsFile: '/protected.json', executorId: 'tester'}, {readCredentials: async () => Buffer.from(JSON.stringify(options)), connectNats: async value => { connected = value; return {close() {}}; }});
    assert.deepEqual(connected, {...options, servers: server || options.servers, name: 'codeworks_tester', timeout: 5000, waitOnFirstConnect: false});
    assert.equal(connected.authenticator, undefined);
    await client.close();
  }
  const creds = await loadNatsOptions('/test.creds', {readCredentials: async () => testCreds});
  assert.equal(typeof creds.authenticator, 'function');
  assert.equal(creds.user, undefined);
});

test('invalid protected JSON and missing endpoint fail safely before connecting', async () => {
  const secret = 'test-only-secret-do-not-log';
  for (const content of [JSON.stringify({servers: 'nats://test', user: 'user', pass: secret, name: 'untrusted-name'}), `{"pass":"${secret}",`, JSON.stringify({servers: [], user: 'user', pass: secret}), JSON.stringify({user: 'user', pass: secret}), JSON.stringify({servers: 'nats://test', user: 'user'})]) {
    await assert.rejects(() => connectClient({credsFile: '/protected.json', executorId: 'tester'}, {readCredentials: async () => Buffer.from(content), connectNats: () => assert.fail('invalid configuration connects')}), error => {
      assert.match(error.message, /CONFIGURATION_(INVALID|REQUIRED)/);
      assert.doesNotMatch(error.message, new RegExp(secret));
      return true;
    });
  }
  const f = fixture({stdin: ['{"action":"status","project_id":"demo"}'], connect: async () => { throw new Error(secret); }});
  assert.equal(await runCLI(f.options), 1);
  assert.doesNotMatch(f.errors, new RegExp(secret));
  assert.equal(f.output, '');
});
