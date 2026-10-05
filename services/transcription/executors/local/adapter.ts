// ABOUTME: Преобразует local executor DTO в вызовы опубликованного local-ai NATS API.
// ABOUTME: Не передаёт тексты в журналы, не повторяет invocation и не обещает отмену.
import { isDeepStrictEqual } from 'node:util';
import { assertDto, methodMap, validateDto } from '#transcription-contracts';
import type { LocalAiConnection } from './nats.js';

const maxTimerDelayMs = 2_147_483_647;
const serviceErrorStatuses = new Set(['400', '404', '409', '413', '429', '500', '503', '504']);
const errorCodes = [
  'INVALID_ARGUMENT', 'MODEL_UNAVAILABLE', 'MODEL_MISMATCH', 'OVERLOADED', 'REQUEST_OUTCOME_UNKNOWN',
  'CANCEL_NOT_CONFIRMED', 'INPUT_TOO_LARGE', 'RESULT_TOO_LARGE', 'DEADLINE_EXCEEDED', 'DEPENDENCY_UNAVAILABLE',
] as const;
const ownerErrorMap: Readonly<Record<string, (typeof errorCodes)[number]>> = {
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  MODEL_NOT_FOUND: 'MODEL_UNAVAILABLE',
  MODEL_NOT_INSTALLED: 'MODEL_UNAVAILABLE',
  UNSUPPORTED_OPERATION: 'MODEL_UNAVAILABLE',
  MODEL_IN_USE: 'MODEL_UNAVAILABLE',
  INPUT_TOO_LARGE: 'INPUT_TOO_LARGE',
  RESULT_TOO_LARGE: 'RESULT_TOO_LARGE',
  BUSY: 'OVERLOADED',
  MODEL_LOAD_FAILED: 'MODEL_UNAVAILABLE',
  ENGINE_UNAVAILABLE: 'MODEL_UNAVAILABLE',
  DEADLINE_EXCEEDED: 'REQUEST_OUTCOME_UNKNOWN',
  CANCELLED: 'CANCEL_NOT_CONFIRMED',
  ARTIFACT_NOT_AVAILABLE: 'DEPENDENCY_UNAVAILABLE',
  DEPENDENCY_UNAVAILABLE: 'DEPENDENCY_UNAVAILABLE',
  INSTALLATION_FAILED: 'DEPENDENCY_UNAVAILABLE',
  REVISION_CONFLICT: 'MODEL_UNAVAILABLE',
  NOT_SUPPORTED: 'MODEL_UNAVAILABLE',
  INTERNAL: 'REQUEST_OUTCOME_UNKNOWN',
};

type LocalAiReply = {
  data: Uint8Array;
  headers?: { get(name: string): string };
};

type LocalAiContractApi = {
  subjects: Readonly<{ invokeTranscribe: string; status: string }>;
  validateRequest(subject: string, value: unknown): boolean;
  validateResponse(subject: string, value: unknown): boolean;
  validateError(value: unknown): boolean;
};

type LocalAiProvider = {
  configured: boolean;
  getConnection(): Promise<LocalAiConnection | undefined>;
};

type ExecuteParams = {
  requestId: string;
  audioArtifactId: string;
  ownerId: string;
  model: { modelId: string; revision: string; profileId: string };
  deadlineAt: string;
  operationId: string;
};

type TranscribeResponse = {
  requestId: string;
  operationId: string;
  model: ExecuteParams['model'];
  durationMs: number;
  text: string;
  segments: Array<{ startSeconds: number; endSeconds: number; text: string }> | null;
};

type StatusResponse = { state: 'ready' | 'degraded' | 'unavailable' };

function failure(errorCode: (typeof errorCodes)[number]): Error & { errorCode: string } {
  return Object.assign(new Error(errorCode), { errorCode });
}

function parseReply(reply: LocalAiReply, responseBytes: number): unknown {
  if (reply.data.byteLength > responseBytes) throw failure('REQUEST_OUTCOME_UNKNOWN');
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(reply.data)); }
  catch { throw failure('REQUEST_OUTCOME_UNKNOWN'); }
}

function safeOwnerError(reply: LocalAiReply, contracts: LocalAiContractApi, responseBytes: number): never {
  const code = reply.headers?.get('Nats-Service-Error');
  const status = reply.headers?.get('Nats-Service-Error-Code');
  if (!code || !status || !serviceErrorStatuses.has(status)) throw failure('REQUEST_OUTCOME_UNKNOWN');
  const value = parseReply(reply, responseBytes);
  if (!contracts.validateError(value) || (value as { code?: unknown }).code !== code) {
    throw failure('REQUEST_OUTCOME_UNKNOWN');
  }
  throw failure(ownerErrorMap[code] ?? 'REQUEST_OUTCOME_UNKNOWN');
}

function hasServiceError(reply: LocalAiReply): boolean {
  return Boolean(reply.headers?.get('Nats-Service-Error') || reply.headers?.get('Nats-Service-Error-Code'));
}

function ownerResponse(reply: LocalAiReply, contracts: LocalAiContractApi, responseBytes: number): unknown {
  if (hasServiceError(reply)) return safeOwnerError(reply, contracts, responseBytes);
  return parseReply(reply, responseBytes);
}

function methodMapForLocal() {
  const methods = methodMap.local;
  return Object.fromEntries(Object.entries(methods).map(([name, [params, result]]) => [name, {
    validateParams: (value: unknown) => validateDto(params, value),
    validateResult: (value: unknown) => validateDto(result, value),
    lane: name === 'execute' ? 'execute' as const : 'control' as const,
  }]));
}

/** Возвращает методы local RPC, включая independent control calls и safe DTO ошибки. */
export function createLocalExecutor(
  provider: LocalAiProvider,
  contracts: LocalAiContractApi,
  controlTimeoutMs?: number,
  responseBytes?: number,
  hopTimeoutMs?: number,
) {
  if (provider.configured && (!Number.isSafeInteger(controlTimeoutMs) || controlTimeoutMs! < 1 || controlTimeoutMs! > maxTimerDelayMs ||
    !Number.isSafeInteger(responseBytes) || responseBytes! < 1 || !Number.isSafeInteger(hopTimeoutMs) || hopTimeoutMs! < 1 || hopTimeoutMs! > maxTimerDelayMs)) {
    throw new Error('INVALID_LOCAL_EXECUTOR_CONFIG');
  }
  return {
    methods: methodMapForLocal(),
    applicationErrorCodes: errorCodes,
    handlers: {
      async execute(value: ExecuteParams) {
        if (!validateDto('LocalExecuteParams', value)) throw failure('INVALID_ARGUMENT');
        const deadlineMs = Date.parse(value.deadlineAt);
        if (!Number.isFinite(deadlineMs)) throw failure('INVALID_ARGUMENT');
        if (deadlineMs - Date.now() <= 0) throw failure('DEADLINE_EXCEEDED');
        if (!provider.configured) throw failure('DEPENDENCY_UNAVAILABLE');

        let connection: LocalAiConnection | undefined;
        try { connection = await provider.getConnection(); } catch { connection = undefined; }
        if (!connection || connection.isClosed() || connection.isDraining()) throw failure('DEPENDENCY_UNAVAILABLE');
        const remainingDeadlineMs = deadlineMs - Date.now();
        if (remainingDeadlineMs <= 0) throw failure('DEADLINE_EXCEEDED');
        const timeoutMs = Math.min(remainingDeadlineMs, hopTimeoutMs!);

        const subject = contracts.subjects.invokeTranscribe;
        const request = {
          requestId: value.operationId,
          operationId: value.operationId,
          model: value.model,
          ownerId: value.ownerId,
          deadlineAt: value.deadlineAt,
          audioArtifactId: value.audioArtifactId,
        };
        if (!contracts.validateRequest(subject, request)) throw failure('INVALID_ARGUMENT');

        let reply: LocalAiReply;
        try { reply = await connection.request(subject, Buffer.from(JSON.stringify(request)), { timeout: timeoutMs }); }
        catch { throw failure('REQUEST_OUTCOME_UNKNOWN'); }
        if (Date.now() >= deadlineMs) throw failure('REQUEST_OUTCOME_UNKNOWN');

        const response = ownerResponse(reply, contracts, responseBytes!);
        if (!contracts.validateResponse(subject, response)) throw failure('REQUEST_OUTCOME_UNKNOWN');
        const transcribed = response as TranscribeResponse;
        if (transcribed.requestId !== value.operationId || transcribed.operationId !== value.operationId) {
          throw failure('REQUEST_OUTCOME_UNKNOWN');
        }
        if (!isDeepStrictEqual(transcribed.model, value.model)) throw failure('MODEL_MISMATCH');

        const result = {
          requestId: value.requestId,
          operationId: value.operationId,
          actualModel: transcribed.model,
          text: transcribed.text,
          segments: transcribed.segments,
          durationMs: transcribed.durationMs,
          usage: null,
          cost: null,
        };
        try { return assertDto('LocalExecuteResult', result); }
        catch { throw failure('REQUEST_OUTCOME_UNKNOWN'); }
      },
      async health() {
        if (!provider.configured || controlTimeoutMs === undefined) {
          return { configured: false, verified: false, available: false };
        }
        let connection: LocalAiConnection | undefined;
        try { connection = await provider.getConnection(); } catch { connection = undefined; }
        if (!connection || connection.isClosed() || connection.isDraining()) {
          return { configured: true, verified: false, available: false };
        }
        try {
          const subject = contracts.subjects.status;
          const request = {};
          if (!contracts.validateRequest(subject, request)) return { configured: true, verified: false, available: false };
          const reply = await connection.request(subject, Buffer.from('{}'), { timeout: controlTimeoutMs });
          if (hasServiceError(reply)) return { configured: true, verified: false, available: false };
          const response = parseReply(reply, responseBytes!);
          if (!contracts.validateResponse(subject, response)) return { configured: true, verified: false, available: false };
          const status = response as StatusResponse;
          return { configured: true, verified: true, available: status.state === 'ready' };
        } catch {
          return { configured: true, verified: false, available: false };
        }
      },
      async cancel() {
        return { accepted: false, stopConfirmed: false };
      },
    },
  };
}
