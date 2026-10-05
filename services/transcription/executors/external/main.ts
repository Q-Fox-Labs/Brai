// ABOUTME: Запускает отключённый внешний исполнитель transcription через JSON-RPC.
// ABOUTME: Не вызывает провайдеры, не читает credentials и всегда возвращает явную недоступность.
import { pathToFileURL } from 'node:url';
import type { RpcHandlers, RpcMethodMap, RpcServerLimits } from '../../runtime/stdio-rpc.js';
import { serveRpc } from '../../runtime/stdio-rpc.js';
import { methodMap, validateDto } from '#transcription-contracts';

type ExternalExecuteParams = Record<string, unknown>;
type ExternalExecuteResult = { errorCode: 'EXTERNAL_ROUTE_UNAVAILABLE' };
type HealthParams = Record<string, never>;
type HealthResult = { available: false };
type CancelParams = { requestId: string; operationId: string };
type CancelResult = { accepted: false; stopConfirmed: false };

function positiveSafeInteger(name: string): number {
  const value = process.env[name];
  if (!value || !/^[0-9]+$/.test(value)) throw new Error(`Missing or invalid required setting: ${name}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`Missing or invalid required setting: ${name}`);
  return parsed;
}

function rpcLimits(): RpcServerLimits {
  const limits: RpcServerLimits = {
    frameBytes: positiveSafeInteger('TRANSCRIPTION_RPC_FRAME_BYTES'),
    batchItems: positiveSafeInteger('TRANSCRIPTION_RPC_BATCH_ITEMS'),
    concurrentRequests: positiveSafeInteger('TRANSCRIPTION_RPC_CONCURRENT_REQUESTS'),
    concurrentExecute: positiveSafeInteger('TRANSCRIPTION_RPC_CONCURRENT_EXECUTE'),
  };
  if (limits.concurrentExecute >= limits.concurrentRequests) {
    throw new Error('TRANSCRIPTION_RPC_CONCURRENT_EXECUTE must be lower than TRANSCRIPTION_RPC_CONCURRENT_REQUESTS');
  }
  return limits;
}

const methods: RpcMethodMap = Object.fromEntries(
  Object.entries(methodMap.external).map(([name, [paramsName, resultName]]) => [name, {
    validateParams: (value: unknown) => validateDto(paramsName, name === 'health' && value === undefined ? {} : value),
    validateResult: (value: unknown) => validateDto(resultName, value),
    lane: name === 'execute' ? 'execute' : 'control',
  }]),
);

const handlers: RpcHandlers = {
  execute: (_params: ExternalExecuteParams): ExternalExecuteResult => ({ errorCode: 'EXTERNAL_ROUTE_UNAVAILABLE' }),
  health: (_params: HealthParams): HealthResult => ({ available: false }),
  cancel: (_params: CancelParams): CancelResult => ({ accepted: false, stopConfirmed: false }),
};

/** Запускает ограниченный stdio RPC сервер; ошибки запуска не выводят значения конфигурации. */
export async function runExternalExecutor(): Promise<void> {
  await serveRpc(methods, handlers, rpcLimits());
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === invokedPath) {
  runExternalExecutor().catch(() => {
    process.stderr.write('transcription external executor stopped\n');
    process.exitCode = 1;
  });
}
