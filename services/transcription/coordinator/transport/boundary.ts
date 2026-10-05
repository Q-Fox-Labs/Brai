// ABOUTME: Проверяет доверенный principal и owner DTO для всех входов координатора.
// ABOUTME: Не хранит payload, не пишет журналы и не определяет правила выполнения расшифровки.
import { createHash, timingSafeEqual } from 'node:crypto';
import { methodMap, validateDto } from '#transcription-contracts';

/** Прикладной порт получает только DTO и principal, удостоверенный транспортом. */
export type PublicInvoke = (method: string, params: any, principal: any) => Promise<unknown>;
export type AuthBinding = { token: string; principal: Record<string, unknown> };
export type PublicGateway = ReturnType<typeof createPublicGateway>;

/** Нормализует исключение к закрытому ErrorResponse; детали соседей и payload не возвращаются. */
export function safeError(error: unknown): { errorCode: string } {
  try {
    if (error && typeof error === 'object' && 'errorCode' in error) {
      const candidate = { errorCode: error.errorCode };
      if (validateDto('ErrorResponse', candidate)) return candidate as { errorCode: string };
    }
  } catch { /* Недоверенный getter также не должен раскрыть данные. */ }
  return { errorCode: 'INTERNAL' };
}

/** Возвращает стабильный HTTP/NATS Services status без произвольных сообщений исключения. */
export function errorStatus(errorCode: string): number {
  if (errorCode === 'UNAUTHENTICATED') return 401;
  if (['FORBIDDEN', 'ARTIFACT_OWNER_MISMATCH'].includes(errorCode)) return 403;
  if (['NOT_FOUND', 'RESULT_UNAVAILABLE'].includes(errorCode)) return 404;
  if (['INPUT_TOO_LARGE', 'RESULT_TOO_LARGE'].includes(errorCode)) return 413;
  if (errorCode === 'OVERLOADED') return 429;
  if (errorCode === 'DEADLINE_EXCEEDED') return 504;
  if (['IDEMPOTENCY_CONFLICT', 'ARTIFACT_NOT_READY', 'MODEL_MISMATCH', 'STALE_REVISION', 'STATE_CONFLICT', 'STALE_CLAIM', 'CANCEL_NOT_CONFIRMED'].includes(errorCode)) return 409;
  if (['STORAGE_UNAVAILABLE', 'DEPENDENCY_UNAVAILABLE', 'MODEL_CATALOG_UNAVAILABLE', 'MODEL_UNAVAILABLE', 'EXTERNAL_ROUTE_UNAVAILABLE', 'REQUEST_OUTCOME_UNKNOWN', 'HISTORY_DELIVERY_FAILED'].includes(errorCode)) return 503;
  return errorCode === 'INTERNAL' ? 500 : 400;
}

/**
 * Создаёт единый проверенный вход. Предел занимает весь запрос до фактического завершения,
 * даже если HTTP-клиент ушёл или получил deadline. Credentials сохраняются только как digest.
 */
export function createPublicGateway(options: { invoke: PublicInvoke; bindings: readonly AuthBinding[]; maxConcurrent: number }) {
  if (!Number.isSafeInteger(options.maxConcurrent) || options.maxConcurrent < 1 || !options.bindings.length) {
    throw new Error('Invalid transcription transport configuration');
  }
  const tokens = new Set<string>();
  const bindings = options.bindings.map((binding) => {
    if (!binding || typeof binding.token !== 'string' || !binding.token || /\s/.test(binding.token) ||
      !validateDto('TrustedPrincipal', binding.principal) || tokens.has(binding.token)) {
      throw new Error('Invalid transcription transport configuration');
    }
    tokens.add(binding.token);
    const principal = Object.freeze({ ...binding.principal, permissions: Object.freeze([...(binding.principal.permissions as string[])]) });
    return { digest: createHash('sha256').update(binding.token).digest(), principal };
  });
  tokens.clear();
  const { invoke, maxConcurrent } = options;
  let active = 0;
  return {
    authenticate(authorization: string | undefined): Record<string, unknown> {
      if (!authorization?.startsWith('Bearer ') || /\s/.test(authorization.slice(7)) || authorization.length === 7) {
        throw { errorCode: 'UNAUTHENTICATED' };
      }
      const digest = createHash('sha256').update(authorization.slice(7)).digest();
      let principal: Record<string, unknown> | undefined;
      for (const binding of bindings) if (timingSafeEqual(digest, binding.digest)) principal = binding.principal;
      if (!principal) throw { errorCode: 'UNAUTHENTICATED' };
      return principal;
    },
    async withCapacity<T>(operation: () => Promise<T>): Promise<T> {
      if (active >= maxConcurrent) throw { errorCode: 'OVERLOADED' };
      active++;
      try { return await operation(); } finally { active--; }
    },
    async invoke(method: string, params: unknown, principal: Record<string, unknown>): Promise<unknown> {
      const pair = Object.hasOwn(methodMap.public, method) ? methodMap.public[method] : undefined;
      if (!pair || !validateDto(pair[0], params)) throw { errorCode: 'INVALID_ARGUMENT' };
      if (!validateDto('TrustedPrincipal', principal)) throw { errorCode: 'UNAUTHENTICATED' };
      const permission = method === 'settings.set' ? 'transcription:settings:write' : 'transcription:use';
      if (!(principal.permissions as string[]).includes(permission)) throw { errorCode: 'FORBIDDEN' };
      const result = await invoke(method, params, principal);
      if (!validateDto(pair[1], result)) throw { errorCode: 'INTERNAL' };
      return result;
    },
  };
}
