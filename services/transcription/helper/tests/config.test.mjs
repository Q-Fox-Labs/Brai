// ABOUTME: Проверяет обязательную helper конфигурацию и конечные пределы без реальных секретов.
// ABOUTME: Не открывает PostgreSQL и не запускает JSON-RPC.
import assert from 'node:assert/strict';
import test from 'node:test';
import { loadHelperConfig } from '../../dist/helper/config.js';

const env = {
  PGHOST: '127.0.0.1', PGPORT: '5432', PGDATABASE: 'synthetic_db', PGUSER: 'synthetic_runtime', PGPASSWORD: 'synthetic_password',
  TRANSCRIPTION_RPC_FRAME_BYTES: '8192', TRANSCRIPTION_RPC_BATCH_ITEMS: '8',
  TRANSCRIPTION_RPC_CONCURRENT_REQUESTS: '4', TRANSCRIPTION_RPC_CONCURRENT_EXECUTE: '1',
  TRANSCRIPTION_HISTORY_CAPACITY: '100', TRANSCRIPTION_REQUEST_LEASE_MS: '30000',
  TRANSCRIPTION_HISTORY_LEASE_MS: '30000', TRANSCRIPTION_TRANSACTION_TIMEOUT_MS: '5000', TRANSCRIPTION_PG_POOL_MAX: '5',
  TRANSCRIPTION_RECOVERY_BATCH_SIZE: '10',
};

test('config returns separate finite RPC and storage limits with an explicit runtime role', () => {
  const config = loadHelperConfig(env);
  assert.deepEqual(config.rpc, { frameBytes: 8192, batchItems: 8, concurrentRequests: 4, concurrentExecute: 1 });
  assert.deepEqual(config.store, { historyCapacity: 100, requestLeaseMs: 30000, historyLeaseMs: 30000, transactionTimeoutMs: 5000, recoveryBatchSize: 10 });
  assert.deepEqual(config.postgres, { host: '127.0.0.1', port: 5432, database: 'synthetic_db', user: 'synthetic_runtime', password: 'synthetic_password', poolMax: 5 });
});

test('missing, unsafe or inconsistent values fail without reflecting their contents', () => {
  for (const [name, value] of [
    ['PGPASSWORD', undefined], ['TRANSCRIPTION_RPC_FRAME_BYTES', '0'], ['TRANSCRIPTION_RPC_BATCH_ITEMS', '1.5'],
    ['TRANSCRIPTION_HISTORY_CAPACITY', '9007199254740992'], ['TRANSCRIPTION_PG_POOL_MAX', '0'], ['PGPORT', '65536'],
    ['TRANSCRIPTION_RPC_CONCURRENT_EXECUTE', '4'],
  ]) {
    const changed = { ...env, [name]: value };
    assert.throws(() => loadHelperConfig(changed), error => error.message === 'INVALID_HELPER_CONFIG');
  }
});
