// ABOUTME: Связывает проверенные helper DTO с metadata операциями хранилища.
// ABOUTME: Не выполняет сеть, выбор модели, чтение аудио или обработку текста.
import { canonicalHash, StorageFault } from './storage/index.js';
import { validateDto, type methodMap } from '#transcription-contracts';

type HelperMethod = keyof typeof methodMap.helper;
type HelperStore = { execute(method: string, params: unknown): Promise<unknown> };
type Params = Record<string, any>;
type RpcFailure = Error & { errorCode: string };

function fault(errorCode: string): RpcFailure {
  const safeCode = validateDto('ErrorCode', errorCode) ? errorCode : 'INTERNAL';
  return Object.assign(new Error(safeCode), { errorCode: safeCode });
}

function requirePermission(params: Params, permission: string): void {
  if (!params?.principal?.permissions?.includes(permission)) throw fault('FORBIDDEN');
}

function normalizedInputHash(input: Params): string {
  return canonicalHash({
    audioArtifactId: input.audioArtifactId.toLowerCase(),
    requestedModel: input.requestedModel,
    deadlineAt: input.deadlineAt,
  });
}

/** Создаёт обработчики поверх store-порта; validateDto выполняет RPC граница до вызова. */
export function createHelperHandlers(store: HelperStore): Record<HelperMethod, (params: any) => Promise<unknown>> {
  const execute = (method: HelperMethod, params: unknown) => store.execute(method, params);
  return {
    health: (params) => execute('health', params ?? {}),
    'settings.get': async (params: Params) => {
      requirePermission(params, 'transcription:use');
      return execute('settings.get', params);
    },
    'settings.set': async (params: Params) => {
      requirePermission(params, 'transcription:settings:write');
      return execute('settings.set', params);
    },
    'request.accept': async (params: Params) => {
      requirePermission(params, 'transcription:use');
      const input = params.input as Params;
      const principal = params.principal as Params;
      const lookup = await execute('request.lookup', {
        principal,
        clientIdempotencyKey: input.clientIdempotencyKey.toLowerCase(),
        normalizedInputSha256: normalizedInputHash(input),
      }) as { request: unknown | null };
      if (lookup.request !== null) return { created: false, request: lookup.request };
      if (params.artifact.state !== 'ready') throw fault('ARTIFACT_NOT_READY');
      if (params.artifact.ownerId !== principal.ownerId ||
        params.artifact.artifactId.toLowerCase() !== input.audioArtifactId.toLowerCase()) {
        throw fault('ARTIFACT_OWNER_MISMATCH');
      }
      return execute('request.accept', params);
    },
    'request.get': async (params: Params) => {
      requirePermission(params, 'transcription:use');
      return execute('request.get', params);
    },
    'request.lookup': async (params: Params) => {
      requirePermission(params, 'transcription:use');
      return execute('request.lookup', params);
    },
    'request.cancel': async (params: Params) => {
      requirePermission(params, 'transcription:use');
      return execute('request.cancel', params);
    },
    'request.claim': (params) => execute('request.claim', params),
    'request.renew': (params) => execute('request.renew', params),
    'attempt.start': (params) => execute('attempt.start', params),
    'attempt.markRunning': (params) => execute('attempt.markRunning', params),
    'attempt.finish': (params) => execute('attempt.finish', params),
    'result.setState': (params) => execute('result.setState', params),
    'recovery.run': (params) => execute('recovery.run', params),
    'alerts.claim': (params) => execute('alerts.claim', params),
    'alerts.ack': (params) => execute('alerts.ack', params),
    'alerts.fail': (params) => execute('alerts.fail', params),
    'alerts.observe': (params) => execute('alerts.observe', params),
    'history.claim': (params) => execute('history.claim', params),
    'history.ack': (params) => execute('history.ack', params),
    'history.fail': (params) => execute('history.fail', params),
  };
}

/** Переводит только известные ошибки порта в закрытые RPC ошибки без деталей payload или SQL. */
export function toRpcError(error: unknown): RpcFailure {
  if (error instanceof StorageFault) return fault(error.code);
  if (error && typeof error === 'object' && 'errorCode' in error && typeof error.errorCode === 'string') {
    return fault(error.errorCode);
  }
  return fault('INTERNAL');
}
