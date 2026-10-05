// ABOUTME: Запускает helper JSON-RPC и его собственное PostgreSQL хранилище.
// ABOUTME: Проверяет готовую миграцию; не выполняет DDL и не обращается к соседям.
import { Pool } from 'pg';
import { pathToFileURL } from 'node:url';
import { methodMap, schemas, validateDto } from '#transcription-contracts';
import { serveRpc, type RpcHandlers, type RpcMethodMap } from '../runtime/stdio-rpc.js';
import { createPostgresStore } from './storage/index.js';
import { createHelperHandlers, toRpcError } from './handlers.js';
import { loadHelperConfig } from './config.js';

const errorCodes = (schemas as { definitions: { ErrorCode: { enum: string[] } } }).definitions.ErrorCode.enum;
const methods: RpcMethodMap = Object.fromEntries(
  Object.entries(methodMap.helper).map(([name, [paramsName, resultName]]) => [name, {
    validateParams: (value: unknown) => validateDto(paramsName, name === 'health' && value === undefined ? {} : value),
    validateResult: (value: unknown) => validateDto(resultName, value),
    lane: 'control',
  }]),
);

/** Открывает runtime-role pool только после проверки всей обязательной конфигурации. */
export async function runHelper(): Promise<void> {
  const config = loadHelperConfig();
  const pool = new Pool({
    host: config.postgres.host,
    port: config.postgres.port,
    database: config.postgres.database,
    user: config.postgres.user,
    password: config.postgres.password,
    max: config.postgres.poolMax,
    connectionTimeoutMillis: config.store.transactionTimeoutMs,
    query_timeout: config.store.transactionTimeoutMs,
  });
  const store = createPostgresStore(pool, config.store);
  let stopping = false;
  const stopInput = () => { stopping = true; process.stdin.destroy(); };
  process.once('SIGINT', stopInput);
  process.once('SIGTERM', stopInput);
  try {
    await store.ready();
    const rawHandlers = createHelperHandlers(store);
    const handlers: RpcHandlers = Object.fromEntries(Object.entries(rawHandlers).map(([name, handler]) => [name, async (params: unknown) => {
      try { return await handler(params); } catch (error) { throw toRpcError(error); }
    }]));
    await serveRpc(methods, handlers, { ...config.rpc, applicationErrorCodes: errorCodes });
  } catch {
    if (!stopping) throw new Error('HELPER_UNAVAILABLE');
  } finally {
    process.off('SIGINT', stopInput);
    process.off('SIGTERM', stopInput);
    await store.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runHelper().catch(() => {
    process.stderr.write('transcription helper stopped\n');
    process.exitCode = 1;
  });
}
