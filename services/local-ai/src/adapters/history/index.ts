// ABOUTME: Преобразует разрешённые факты local-ai и доставляет их в service_history.
// ABOUTME: Использует только NATS request-reply и fenced outbox port; содержимое не журналирует.
import type { ClaimedOutboxEvent, DeliveryErrorCode, LocalAiHistoryMetadataEvent } from '../../types.js';
import type { OutboxDeliveryPort } from '../../ports.js';

const SOURCE = 'local_ai';
const SUBJECT = 'brai.history.v1.append.local_ai';
const HISTORY_TIMEOUT_MS = 10_000;
const STATUS: Record<string, number> = {
  INVALID_ARGUMENT: 400, INVALID_CURSOR: 400, NOT_FOUND: 404, EVENT_ID_CONFLICT: 409,
  REQUEST_TOO_LARGE: 413, RESULT_TOO_LARGE: 413, BUSY: 503, DATABASE_UNAVAILABLE: 503,
  DEADLINE_EXCEEDED: 504, INTERNAL: 500,
};
const TYPE_IDS = new Set([103, 203, 204, 301, 902, 1201, 1202, 1301]);
const DATA_KEYS = [
  'operation', 'modelId', 'outcome', 'revision', 'profileId', 'operationId', 'requestId',
  'phase', 'durationMs', 'inputBytes', 'resultBytes', 'vectorDimensions', 'errorCode',
] as const;
const OPERATIONS = new Set(['invoke', 'install', 'configure', 'load', 'unload', 'remove']);
const OUTCOMES = new Set(['accepted', 'started', 'succeeded', 'failed', 'cancelled', 'interrupted', 'unknown']);
const PHASES = new Set(['accepted', 'download', 'verify', 'publish', 'load', 'execute', 'unload', 'remove', 'configure']);
const SERVICE_ERRORS = new Set([
  'INVALID_ARGUMENT', 'MODEL_NOT_FOUND', 'MODEL_NOT_INSTALLED', 'UNSUPPORTED_OPERATION', 'MODEL_IN_USE',
  'INPUT_TOO_LARGE', 'RESULT_TOO_LARGE', 'BUSY', 'MODEL_LOAD_FAILED', 'ENGINE_UNAVAILABLE',
  'DEADLINE_EXCEEDED', 'CANCELLED', 'ARTIFACT_NOT_AVAILABLE', 'DEPENDENCY_UNAVAILABLE',
  'INSTALLATION_FAILED', 'REVISION_CONFLICT', 'NOT_SUPPORTED', 'INTERNAL',
]);

type AppendRequest = {
  id: string; type_id: number; occurred_at: string; actor_id: string | null;
  scope_type: 'user' | 'system'; scope_id: string; object_type: string; object_id: string;
  data: Record<string, string | number | null>;
};
type HistoryMessage = { data: Uint8Array; headers?: { has(name: string): boolean; get(name: string): string } };
/** Вызывает историю только по публичному request-reply append contract. */
export interface HistoryRequestPort {
  request(subject: string, data: Uint8Array, options: { timeout: number }): Promise<HistoryMessage>;
}
type WorkerOptions = {
  nats: HistoryRequestPort; outbox: OutboxDeliveryPort; batchSize: number; leaseMs: number;
  retryDelayMs: number; pollIntervalMs: number; requestTimeoutMs?: number; now?: () => number;
};
class DeliveryFault extends Error {
  constructor(readonly deliveryCode: DeliveryErrorCode) {
    super(deliveryCode);
    this.name = 'DeliveryFault';
  }
}
function fail(code: DeliveryErrorCode): never { throw new DeliveryFault(code); }
function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('DELIVERY_INTERNAL');
  return value as Record<string, unknown>;
}
function hasExactKeys(value: Record<string, unknown>, allowed: readonly string[], required: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key)) && required.every(key => Object.hasOwn(value, key));
}
function validString(value: unknown, max: number, nullable = false): value is string | null {
  return (nullable && value === null) ||
    (typeof value === 'string' && value.length > 0 && Array.from(value).length <= max && !value.includes('\0'));
}
function validUuid(value: unknown): value is string {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
function validTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , , , offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText), month = Number(monthText), day = Number(dayText);
  const hour = Number(hourText), minute = Number(minuteText), second = Number(secondText);
  const offsetHour = Number(offsetHourText ?? 0), offsetMinute = Number(offsetMinuteText ?? 0);
  const daysInMonth = month >= 1 && month <= 12
    ? new Date(Date.UTC(year, month, 0)).getUTCDate()
    : 0;
  return year >= 1 && day >= 1 && day <= daysInMonth && hour <= 23 && minute <= 59 && second <= 59 &&
    offsetHour <= 23 && offsetMinute <= 59 && Number.isFinite(Date.parse(value));
}
function normalizeTimestamp(value: string): string {
  const milliseconds = Date.parse(value);
  const micros = ((value.match(/\.(\d+)/)?.[1] ?? '') + '000000').slice(0, 6);
  return new Date(milliseconds).toISOString().slice(0, 19) + '.' + micros + 'Z';
}
function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return '{' + Object.keys(record).sort().map(key => JSON.stringify(key) + ':' + canonical(record[key])).join(',') + '}';
  }
  return JSON.stringify(value) ?? 'null';
}
function validateData(value: unknown): Record<string, string | number | null> {
  const data = asObject(value);
  if (!hasExactKeys(data, DATA_KEYS, ['operation', 'modelId', 'outcome']) ||
      typeof data.operation !== 'string' || !OPERATIONS.has(data.operation) ||
      !validString(data.modelId, 65_536) || typeof data.outcome !== 'string' || !OUTCOMES.has(data.outcome)) fail('DELIVERY_INTERNAL');
  for (const key of ['revision', 'profileId'] as const) {
    if (Object.hasOwn(data, key) && !validString(data[key], 65_536, true)) fail('DELIVERY_INTERNAL');
  }
  for (const key of ['operationId', 'requestId'] as const) {
    if (Object.hasOwn(data, key) && !validUuid(data[key])) fail('DELIVERY_INTERNAL');
  }
  if (Object.hasOwn(data, 'phase') && (typeof data.phase !== 'string' || !PHASES.has(data.phase))) fail('DELIVERY_INTERNAL');
  for (const key of ['durationMs', 'inputBytes', 'resultBytes'] as const) {
    if (Object.hasOwn(data, key) && !nonNegativeInteger(data[key])) fail('DELIVERY_INTERNAL');
  }
  if (Object.hasOwn(data, 'vectorDimensions') &&
      (!nonNegativeInteger(data.vectorDimensions) || data.vectorDimensions < 1)) fail('DELIVERY_INTERNAL');
  if (Object.hasOwn(data, 'errorCode') &&
      (typeof data.errorCode !== 'string' || !SERVICE_ERRORS.has(data.errorCode))) fail('DELIVERY_INTERNAL');

  const projected: Record<string, string | number | null> = {};
  for (const key of DATA_KEYS) if (Object.hasOwn(data, key)) projected[key] = data[key] as string | number | null;
  return projected;
}

/** Проверяет локальное событие и строит append body по строгому allowlist. */
export function projectHistoryAppendRequest(value: unknown): AppendRequest {
  const event = asObject(value);
  const fields = ['id', 'type_id', 'occurred_at', 'actor_id', 'scope_type', 'scope_id', 'object_type', 'object_id', 'data'];
  if (!hasExactKeys(event, fields, fields) ||
      !validUuid(event.id) || !TYPE_IDS.has(event.type_id as number) || !validTimestamp(event.occurred_at) ||
      !validString(event.actor_id, 255, true) ||
      (event.scope_type !== 'user' && event.scope_type !== 'system') ||
      !validString(event.scope_id, 255) ||
      !['model', 'installation', 'operation'].includes(String(event.object_type)) ||
      !validString(event.object_id, 255)) fail('DELIVERY_INTERNAL');
  if (event.scope_type === 'system' && event.scope_id !== 'local_ai') fail('DELIVERY_INTERNAL');
  const data = validateData(event.data);
  if ((data.operation === 'invoke') !== (event.scope_type === 'user')) fail('DELIVERY_INTERNAL');

  return {
    id: event.id.toLowerCase(),
    type_id: event.type_id as number,
    occurred_at: normalizeTimestamp(event.occurred_at),
    actor_id: event.actor_id as string | null,
    scope_type: event.scope_type as 'user' | 'system',
    scope_id: event.scope_id as string,
    object_type: event.object_type as string,
    object_id: event.object_id as string,
    data,
  };
}
function decode(data: Uint8Array): unknown {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)); }
  catch { return fail('DELIVERY_INTERNAL'); }
}
function matchesAcknowledgement(value: unknown, request: AppendRequest): boolean {
  const event = asObject(value);
  const fields = ['id', 'source', 'type_id', 'occurred_at', 'recorded_at', 'actor_id', 'scope_type', 'scope_id', 'object_type', 'object_id', 'data'];
  if (!hasExactKeys(event, fields, fields) || event.source !== SOURCE || !validUuid(event.id) ||
      !validTimestamp(event.occurred_at) || !validTimestamp(event.recorded_at) ||
      !(event.actor_id === null || validString(event.actor_id, 255)) ||
      !(event.object_type === null || validString(event.object_type, 64)) ||
      !(event.object_id === null || validString(event.object_id, 255)) ||
      typeof event.scope_type !== 'string' || !validString(event.scope_id, 255) ||
      !Number.isInteger(event.type_id) || !asObject(event.data)) return false;
  const actual = {
    id: event.id.toLowerCase(), source: event.source, type_id: event.type_id,
    occurred_at: normalizeTimestamp(event.occurred_at), actor_id: event.actor_id,
    scope_type: event.scope_type, scope_id: event.scope_id, object_type: event.object_type,
    object_id: event.object_id, data: event.data,
  };
  return canonical(actual) === canonical({ ...request, source: SOURCE });
}
type ServiceError = { code: string; message: string; retryable: boolean };
function validServiceError(value: unknown): value is ServiceError {
  const error = asObject(value);
  return hasExactKeys(error, ['code', 'message', 'retryable'], ['code', 'message', 'retryable']) &&
    typeof error.code === 'string' && Object.hasOwn(STATUS, error.code) &&
    typeof error.message === 'string' && error.message.length > 0 && error.message.length <= 256 &&
    typeof error.retryable === 'boolean';
}
function readErrorHeaders(message: HistoryMessage): { code: string | null; status: string | null } {
  const headers = message.headers;
  if (!headers) return { code: null, status: null };
  const hasCode = headers.has('Nats-Service-Error');
  const hasStatus = headers.has('Nats-Service-Error-Code');
  if (hasCode !== hasStatus) fail('DELIVERY_INTERNAL');
  return hasCode
    ? { code: headers.get('Nats-Service-Error'), status: headers.get('Nats-Service-Error-Code') }
    : { code: null, status: null };
}
function serviceFault(message: HistoryMessage, code: string, status: string): DeliveryFault {
  const error = decode(message.data);
  if (!validServiceError(error) || error.code !== code || String(STATUS[error.code]) !== status) fail('DELIVERY_INTERNAL');
  return new DeliveryFault(error.retryable ? 'HISTORY_UNAVAILABLE' : 'HISTORY_REJECTED');
}

/** Отправляет неизменяемый append и сверяет подтверждённое событие перед завершением delivery. */
export async function appendHistoryMetadataEvent(
  nats: HistoryRequestPort,
  event: LocalAiHistoryMetadataEvent,
  requestTimeoutMs = HISTORY_TIMEOUT_MS,
): Promise<void> {
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > HISTORY_TIMEOUT_MS) fail('DELIVERY_INTERNAL');
  const body = projectHistoryAppendRequest(event);
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  if (payload.byteLength > 65_536) fail('HISTORY_REJECTED');

  let message: HistoryMessage;
  try { message = await nats.request(SUBJECT, payload, { timeout: requestTimeoutMs }); }
  catch { fail('HISTORY_UNAVAILABLE'); }
  const headers = readErrorHeaders(message);
  if (headers.code !== null && headers.status !== null) throw serviceFault(message, headers.code, headers.status);
  const result = asObject(decode(message.data));
  if (!hasExactKeys(result, ['event'], ['event']) || !matchesAcknowledgement(result.event, body)) fail('DELIVERY_INTERNAL');
}

/** Lease покрывает последовательную обработку batch; stop оставляет незавершённые claims для replay. */
export function createHistoryDeliveryWorker(options: WorkerOptions): {
  start(): void; stop(): Promise<void>; runOnce(): Promise<number>;
} {
  const {
    nats, outbox, batchSize, leaseMs, retryDelayMs, pollIntervalMs,
    requestTimeoutMs = HISTORY_TIMEOUT_MS, now = Date.now,
  } = options;
  for (const value of [batchSize, leaseMs, retryDelayMs, pollIntervalMs]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error('HISTORY_DELIVERY_CONFIG_INVALID');
  }
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > HISTORY_TIMEOUT_MS ||
      !Number.isSafeInteger(batchSize * requestTimeoutMs) || leaseMs <= batchSize * requestTimeoutMs) {
    throw new Error('HISTORY_DELIVERY_CONFIG_INVALID');
  }

  let stopping = false;
  let loop: Promise<void> | null = null;
  let cycle: Promise<number> | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let wakePoll: (() => void) | null = null;

  async function processClaim(claim: ClaimedOutboxEvent): Promise<void> {
    try { await appendHistoryMetadataEvent(nats, claim.event, requestTimeoutMs); }
    catch (cause) {
      if (stopping) return;
      const fault = cause instanceof DeliveryFault ? cause : new DeliveryFault('DELIVERY_INTERNAL');
      const retryable = fault.deliveryCode === 'HISTORY_UNAVAILABLE';
      const retryAt = retryable ? new Date(now() + retryDelayMs).toISOString() : null;
      await outbox.fail(claim.event.id, claim.claimToken, retryAt, fault.deliveryCode);
      return;
    }
    if (stopping) return;
    await outbox.acknowledge(claim.event.id, claim.claimToken);
  }

  function runOnce(): Promise<number> {
    if (cycle) return cycle;
    if (stopping) return Promise.resolve(0);
    cycle = (async () => {
      const claims = await outbox.claimBatch(batchSize, leaseMs);
      for (const claim of claims) {
        if (stopping) break;
        await processClaim(claim);
      }
      return claims.length;
    })().finally(() => { cycle = null; });
    return cycle;
  }
  function waitForPoll(): Promise<void> {
    if (stopping) return Promise.resolve();
    return new Promise(resolve => {
      wakePoll = resolve;
      pollTimer = setTimeout(() => {
        pollTimer = null;
        wakePoll = null;
        resolve();
      }, pollIntervalMs);
    });
  }
  async function runLoop(): Promise<void> {
    while (!stopping) {
      let claimed = 0;
      try { claimed = await runOnce(); }
      catch { claimed = 0; }
      if (!stopping && claimed === 0) await waitForPoll();
    }
  }

  return {
    start() { if (!loop && !stopping) loop = runLoop(); },
    async stop() {
      stopping = true;
      if (pollTimer) clearTimeout(pollTimer);
      pollTimer = null;
      wakePoll?.();
      wakePoll = null;
      if (cycle) await cycle.catch(() => undefined);
      if (loop) await loop;
    },
    runOnce,
  };
}
