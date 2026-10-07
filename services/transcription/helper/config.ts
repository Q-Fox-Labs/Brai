// ABOUTME: Читает конечные пределы helper и явные реквизиты его PostgreSQL.
// ABOUTME: Не использует общие переменные NATS и не выводит значения конфигурации.
import type { RpcServerLimits } from '../runtime/stdio-rpc.js';
import type { StoreConfig } from './storage/index.js';

const maxPort = 65_535;

export type HelperConfig = {
  rpc: RpcServerLimits;
  store: StoreConfig;
  postgres: { host: string; port: number; database: string; user: string; password: string; poolMax: number };
};

function invalid(): never {
  throw new Error('INVALID_HELPER_CONFIG');
}

function positiveInteger(env: NodeJS.ProcessEnv, name: string, max = Number.MAX_SAFE_INTEGER): number {
  const raw = env[name];
  if (!raw || !/^[1-9][0-9]*$/.test(raw)) return invalid();
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > max) return invalid();
  return value;
}

function requiredString(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value || value.trim() !== value || value.length > 1024) return invalid();
  return value;
}

/** Проверяет обязательные пределы, PostgreSQL и порт до создания пула или RPC сервера. */
export function loadHelperConfig(env: NodeJS.ProcessEnv = process.env): HelperConfig {
  const concurrentRequests = positiveInteger(env, 'TRANSCRIPTION_RPC_CONCURRENT_REQUESTS');
  const concurrentExecute = positiveInteger(env, 'TRANSCRIPTION_RPC_CONCURRENT_EXECUTE');
  if (concurrentExecute >= concurrentRequests) return invalid();

  return {
    rpc: {
      frameBytes: positiveInteger(env, 'TRANSCRIPTION_RPC_FRAME_BYTES'),
      batchItems: positiveInteger(env, 'TRANSCRIPTION_RPC_BATCH_ITEMS'),
      concurrentRequests,
      concurrentExecute,
    },
    store: {
      historyCapacity: positiveInteger(env, 'TRANSCRIPTION_HISTORY_CAPACITY'),
      alertsCapacity: positiveInteger(env, 'TRANSCRIPTION_ALERTS_CAPACITY'),
      requestLeaseMs: positiveInteger(env, 'TRANSCRIPTION_REQUEST_LEASE_MS'),
      historyLeaseMs: positiveInteger(env, 'TRANSCRIPTION_HISTORY_LEASE_MS'),
      transactionTimeoutMs: positiveInteger(env, 'TRANSCRIPTION_TRANSACTION_TIMEOUT_MS'),
      recoveryBatchSize: positiveInteger(env, 'TRANSCRIPTION_RECOVERY_BATCH_SIZE'),
    },
    postgres: {
      host: requiredString(env, 'PGHOST'),
      port: positiveInteger(env, 'PGPORT', maxPort),
      database: requiredString(env, 'PGDATABASE'),
      user: requiredString(env, 'PGUSER'),
      password: requiredString(env, 'PGPASSWORD'),
      poolMax: positiveInteger(env, 'TRANSCRIPTION_PG_POOL_MAX'),
    },
  };
}
