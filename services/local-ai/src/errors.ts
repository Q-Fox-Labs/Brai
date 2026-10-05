// ABOUTME: Представляет безопасные ошибки прикладного контракта local-ai.
// ABOUTME: Ошибки исполнителя и хранилища не раскрываются вызывающему коду.
import type { ServiceErrorCode } from './types.js';

const statusByCode: Record<ServiceErrorCode, number> = {
  INVALID_ARGUMENT: 400,
  MODEL_NOT_FOUND: 404,
  MODEL_NOT_INSTALLED: 409,
  UNSUPPORTED_OPERATION: 400,
  MODEL_IN_USE: 409,
  INPUT_TOO_LARGE: 413,
  RESULT_TOO_LARGE: 413,
  BUSY: 429,
  MODEL_LOAD_FAILED: 503,
  ENGINE_UNAVAILABLE: 503,
  DEADLINE_EXCEEDED: 504,
  CANCELLED: 409,
  ARTIFACT_NOT_AVAILABLE: 404,
  DEPENDENCY_UNAVAILABLE: 503,
  INSTALLATION_FAILED: 500,
  REVISION_CONFLICT: 409,
  NOT_SUPPORTED: 400,
  INTERNAL: 500,
};

/** Ошибка приложения с безопасным сообщением и статусом для стандартных заголовков NATS Service. */
export class LocalAiError extends Error {
  readonly code: ServiceErrorCode;
  readonly status: number;
  readonly retryable: boolean;

  constructor(code: ServiceErrorCode, safeMessage: string, retryable = false) {
    super(safeMessage);
    this.name = 'LocalAiError';
    this.code = code;
    this.status = statusByCode[code];
    this.retryable = retryable;
  }
}
