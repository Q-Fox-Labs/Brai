// ABOUTME: Проверяет чтение настоящего helper через compiled stdio RPC с рабочей ролью PostgreSQL.
// ABOUTME: Не наследует owner credentials, не меняет данные и не выводит payload или конфигурацию.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadHelperConfig } from '../../dist/helper/config.js';
import { RpcClient } from '../../dist/runtime/stdio-rpc.js';
import { validateDto } from '#transcription-contracts';

const limitNames = [
  'TRANSCRIPTION_RPC_FRAME_BYTES', 'TRANSCRIPTION_RPC_BATCH_ITEMS',
  'TRANSCRIPTION_RPC_CONCURRENT_REQUESTS', 'TRANSCRIPTION_RPC_CONCURRENT_EXECUTE',
  'TRANSCRIPTION_HISTORY_CAPACITY', 'TRANSCRIPTION_REQUEST_LEASE_MS', 'TRANSCRIPTION_HISTORY_LEASE_MS',
  'TRANSCRIPTION_TRANSACTION_TIMEOUT_MS', 'TRANSCRIPTION_RECOVERY_BATCH_SIZE', 'TRANSCRIPTION_PG_POOL_MAX',
];
const pgNames = ['PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD'];
// AIDEV-NOTE: Только APP protected runtime env; owner test env и ambient NODE_OPTIONS не наследуются.
const childEnv = Object.fromEntries([...pgNames, ...limitNames].map(name => [name, process.env[name]]));
if (childEnv.PGHOST !== '127.0.0.1' || childEnv.PGPORT !== '19679' ||
    childEnv.PGDATABASE !== 'brai_transcription_acceptance' || childEnv.PGUSER !== 'transcription_app') {
  throw new Error('Explicit isolated app-role helper fixture required');
}
const config = loadHelperConfig(childEnv);
if (config.rpc.frameBytes > 1_048_576) throw new Error('Live fixture frame limit exceeds test budget');
const serviceDirectory = fileURLToPath(new URL('../../', import.meta.url));
const helperMain = fileURLToPath(new URL('../../dist/helper/main.js', import.meta.url));
const principal = { scopeType: 'user', scopeId: 'synthetic-live-rpc', ownerId: 'synthetic-live-rpc', permissions: ['transcription:use'] };

/** Ожидает только bounded завершение; не выводит сообщения дочернего процесса. */
async function endedWithin(closed, milliseconds) {
  let timer;
  try { return await Promise.race([closed.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

/** Проверяет безопасный стандартный отказ shared клиента без чтения raw wire exception. */
async function standardRejection(rpc, method, params, code) {
  try { await rpc.call(method, params, { deadlineAt: Date.now() + 3000 }); }
  catch (error) {
    assert.equal(error?.code === 'RPC_REMOTE' && error?.rpcCode === code && error?.outcome === 'not_started', true, 'Standard RPC rejection required');
    assert.equal(error?.message === 'RPC_REMOTE', true, 'Only a fixed client error message is allowed');
    assert.equal(Object.hasOwn(error, 'errorCode'), false, 'Standard rejection must not expose application data');
    return;
  }
  assert.fail('Expected standard RPC rejection');
}

test('live app-role helper reads metadata and returns safe RPC errors', { timeout: 35000 }, async t => {
  const child = spawn(process.execPath, [helperMain], { cwd: serviceDirectory, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
  let spawnedError = false;
  const closed = new Promise(resolve => {
    child.once('error', () => { spawnedError = true; });
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  let outputBytes = 0;
  let stderrBytes = 0;
  let overflow = false;
  const limitOutput = (chunk, stderr = false) => {
    outputBytes += chunk.length;
    if (stderr) stderrBytes += chunk.length;
    if (outputBytes > 1_048_576) { overflow = true; child.kill('SIGKILL'); }
  };
  child.stdout?.on('data', chunk => limitOutput(chunk));
  child.stderr?.on('data', chunk => limitOutput(chunk, true));
  let rpc;
  try {
    assert.equal(Boolean(child.stdout && child.stdin), true, 'Child RPC streams required');
    rpc = new RpcClient({ input: child.stdout, output: child.stdin, process: child }, {
      frameBytes: config.rpc.frameBytes, concurrentRequests: config.rpc.concurrentRequests,
    });
    await t.test('health confirms live storage without requiring admission capacity', async () => {
      const health = await rpc.call('health', {}, { deadlineAt: Date.now() + 8000 });
      assert.equal(validateDto('HealthResult', health), true, 'Health must match owner DTO');
      assert.equal(health.storageAvailable === true, true, 'App role must read initialized PostgreSQL');
    });
    await t.test('settings.get returns owner metadata DTO', async () => {
      const settings = await rpc.call('settings.get', { principal }, { deadlineAt: Date.now() + 3000 });
      assert.equal(validateDto('SettingsResult', settings), true, 'Settings must match owner DTO');
    });
    await t.test('request.lookup with fresh scoped key is a read-only miss', async () => {
      const result = await rpc.call('request.lookup', { principal, clientIdempotencyKey: randomUUID(),
        normalizedInputSha256: createHash('sha256').update(randomUUID()).digest('hex') }, { deadlineAt: Date.now() + 3000 });
      assert.equal(validateDto('RequestLookupResult', result), true, 'Lookup must match owner DTO');
      assert.equal(result.request === null, true, 'Fresh scoped key must have no request');
    });
    await t.test('unknown method uses standard safe error', () => standardRejection(rpc, 'fixture.unknown', {}, -32601));
    await t.test('invalid settings params use standard safe error', () => standardRejection(rpc, 'settings.get', { principal, unexpected: 'synthetic' }, -32602));
  } finally {
    // AIDEV-NOTE: Сначала EOF, чтобы helper завершил запись ответа; hard close stdout мог бы дать ложный EPIPE.
    child.stdin?.end();
    try {
      if (!await endedWithin(closed, 3000)) child.kill('SIGTERM');
      if (!await endedWithin(closed, 1000)) child.kill('SIGKILL');
      assert.equal(await endedWithin(closed, 1000), true, 'Child must stop within cleanup budget');
    } finally { rpc?.close(); }
  }
  const exit = await closed;
  assert.equal(spawnedError, false, 'Child must spawn');
  assert.equal(overflow, false, 'Child output must stay bounded');
  assert.equal(stderrBytes, 0, 'Successful helper must have no diagnostic output');
  assert.equal(exit.code === 0 && exit.signal === null, true, 'Helper must exit normally after RPC EOF');
});
