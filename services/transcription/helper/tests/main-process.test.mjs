// ABOUTME: Проверяет запуск helper process и безопасный отказ до RPC при недоступной БД.
// ABOUTME: Использует только фиктивные реквизиты и loopback port без слушателя.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const entrypoint = fileURLToPath(new URL('../../dist/helper/main.js', import.meta.url));
const env = {
  PATH: process.env.PATH,
  PGHOST: '127.0.0.1', PGPORT: '1', PGDATABASE: 'synthetic_db', PGUSER: 'synthetic_user', PGPASSWORD: 'private-synthetic-password',
  TRANSCRIPTION_RPC_FRAME_BYTES: '8192', TRANSCRIPTION_RPC_BATCH_ITEMS: '8',
  TRANSCRIPTION_RPC_CONCURRENT_REQUESTS: '4', TRANSCRIPTION_RPC_CONCURRENT_EXECUTE: '1',
  TRANSCRIPTION_ALERTS_CAPACITY: '100', TRANSCRIPTION_HISTORY_CAPACITY: '10', TRANSCRIPTION_REQUEST_LEASE_MS: '100',
  TRANSCRIPTION_HISTORY_LEASE_MS: '100', TRANSCRIPTION_TRANSACTION_TIMEOUT_MS: '100', TRANSCRIPTION_PG_POOL_MAX: '1',
  TRANSCRIPTION_RECOVERY_BATCH_SIZE: '2',
};

test('helper process does not serve before storage readiness or print database configuration', async () => {
  const child = spawn(process.execPath, [entrypoint], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdin.end('{"jsonrpc":"2.0","id":"x","method":"health","params":{}}\n');
  const status = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('helper did not stop after failed readiness')); }, 5000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
  assert.deepEqual(status, { code: 1, signal: null });
  assert.equal(stdout, '');
  if (stderr) assert.equal(stderr, 'transcription helper stopped\n');
  assert.equal(stderr.includes(env.PGPASSWORD), false);
});
