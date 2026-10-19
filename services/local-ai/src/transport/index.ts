// ABOUTME: Подключает публичные DTO local-ai к NATS Services request/reply.
// ABOUTME: Проверяет границу и сроки запроса; не закрывает общую NATS connection.
import { randomUUID } from 'node:crypto';
import { Events } from 'nats';
import type { NatsConnection, QueuedIterator, Service, ServiceMsg, Status } from 'nats';
import { serviceName, subjects, validateError, validateRequest, validateResponse } from '../../contracts/index.mjs';
import { LocalAiError } from '../errors.js';
import type { OperationContext, ServiceErrorCode } from '../types.js';

export type LocalAiSubject =
  | 'brai.local_ai.v1.models.list'
  | 'brai.local_ai.v1.models.get'
  | 'brai.local_ai.v1.catalog.search'
  | 'brai.local_ai.v1.models.install'
  | 'brai.local_ai.v1.operations.get'
  | 'brai.local_ai.v1.models.configure'
  | 'brai.local_ai.v1.models.load'
  | 'brai.local_ai.v1.models.unload'
  | 'brai.local_ai.v1.models.remove'
  | 'brai.local_ai.v1.invoke.embed'
  | 'brai.local_ai.v1.invoke.transcribe'
  | 'brai.local_ai.v1.invoke.synthesize'
  | 'brai.local_ai.v1.cancel'
  | 'brai.local_ai.v1.status';

export type TransportOperationContext = Omit<OperationContext, 'ownerId'> & { ownerId?: string; requestId?: string };
export type LocalAiServiceHandler = (request: unknown, context: TransportOperationContext) => Promise<unknown>;
export type LocalAiServiceHandlers = Partial<Record<LocalAiSubject, LocalAiServiceHandler>>;

export type LocalAiTransportConfig = {
  maxConcurrentRequests: number;
  maxRequestBytes: number;
  maxReplyBytes: number;
  maxRequestMs: number;
  serviceInfo?: { version?: string; description?: string };
};

export type LocalAiTransport = {
  service: Service;
  /** Reflects NATS disconnect/reconnect events and the owning connection state. */
  connected(): boolean;
  /** Stops all endpoint and standard service-control subscriptions. */
  stopAdmission(): Promise<void>;
  /** Waits until every admitted handler promise has actually settled. */
  drainHandlers(): Promise<void>;
  /** Stops admission and waits for all admitted handler promises; leaves nc open. */
  close(): Promise<void>;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

function positiveInteger(value: number, name: string, maximum = Number.MAX_SAFE_INTEGER): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${name} must be a positive safe integer no greater than ${maximum}`);
  }
}

function safeError(error: unknown): { code: ServiceErrorCode; status: number; retryable: boolean } {
  if (error instanceof LocalAiError) {
    return { code: error.code, status: error.status, retryable: error.retryable };
  }
  return { code: 'INTERNAL', status: 500, retryable: false };
}

function sendError(message: ServiceMsg, error: unknown): void {
  const safe = safeError(error);
  const body = { code: safe.code, message: safe.code, retryable: safe.retryable };
  if (!validateError(body)) return;
  message.respondError(safe.status, safe.code, encoder.encode(JSON.stringify(body)));
}

function parseRequest(message: ServiceMsg, subject: LocalAiSubject, maxBytes: number): unknown {
  if (message.data.byteLength > maxBytes) throw new LocalAiError('INPUT_TOO_LARGE', 'INPUT_TOO_LARGE');
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(message.data));
  } catch {
    throw new LocalAiError('INVALID_ARGUMENT', 'INVALID_ARGUMENT');
  }
  if (!validateRequest(subject, value)) throw new LocalAiError('INVALID_ARGUMENT', 'INVALID_ARGUMENT');
  return value;
}

function requestContext(
  request: unknown,
  maxRequestMs: number,
  signal: AbortSignal,
  subject: LocalAiSubject,
): { context: TransportOperationContext; timeoutMs: number } {
  const value = request as Record<string, unknown>;
  const now = Date.now();
  const hasDeadline = typeof value.deadlineAt === 'string';
  const suppliedDeadline = hasDeadline ? Date.parse(value.deadlineAt as string) : Number.POSITIVE_INFINITY;
  if (hasDeadline && (!Number.isFinite(suppliedDeadline) || suppliedDeadline <= now)) {
    throw new LocalAiError('DEADLINE_EXCEEDED', 'DEADLINE_EXCEEDED');
  }
  if (hasDeadline && suppliedDeadline - now > maxRequestMs) {
    throw new LocalAiError('INVALID_ARGUMENT', 'INVALID_ARGUMENT');
  }
  const deadlineMs = suppliedDeadline === Number.POSITIVE_INFINITY ? now + maxRequestMs : suppliedDeadline;
  const requestId = typeof value.requestId === 'string' ? value.requestId : undefined;
  const operationId = typeof value.operationId === 'string' ? value.operationId : randomUUID();
  if ((subject === subjects.invokeEmbed || subject === subjects.invokeTranscribe || subject === subjects.invokeSynthesize)
    && requestId && operationId === requestId) {
    throw new LocalAiError('INVALID_ARGUMENT', 'INVALID_ARGUMENT');
  }
  return {
    context: {
      ...(typeof value.ownerId === 'string' ? { ownerId: value.ownerId } : {}),
      ...(requestId ? { requestId } : {}),
      operationId,
      deadlineAt: suppliedDeadline === Number.POSITIVE_INFINITY
        ? new Date(deadlineMs).toISOString()
        : value.deadlineAt as string,
      signal, deadlineManaged: true,
    },
    timeoutMs: Math.max(1, deadlineMs - now),
  };
}

/**
 * Starts the registered local-ai endpoints on a caller-owned NATS connection.
 * Expired requests are rejected immediately; deadlines abort their signal and bound the reply wait.
 */
export async function startLocalAiNats(
  nc: NatsConnection,
  config: LocalAiTransportConfig,
  handlers: LocalAiServiceHandlers,
): Promise<LocalAiTransport> {
  positiveInteger(config.maxConcurrentRequests, 'maxConcurrentRequests');
  positiveInteger(config.maxRequestBytes, 'maxRequestBytes');
  positiveInteger(config.maxReplyBytes, 'maxReplyBytes');
  const largestSafeError = encoder.encode(JSON.stringify({
    code: 'DEPENDENCY_UNAVAILABLE', message: 'DEPENDENCY_UNAVAILABLE', retryable: false,
  })).byteLength;
  if (config.maxReplyBytes < largestSafeError) {
    throw new TypeError(`maxReplyBytes must be at least ${largestSafeError} bytes for the safe error DTO`);
  }
  positiveInteger(config.maxRequestMs, 'maxRequestMs', 2_147_483_647);
  if (nc.isClosed() || nc.isDraining()) throw new LocalAiError('DEPENDENCY_UNAVAILABLE', 'DEPENDENCY_UNAVAILABLE', true);

  const installed = Object.values(subjects).flatMap(value => {
    const subject = value as LocalAiSubject;
    const handler = handlers[subject];
    return handler ? [[subject, handler] as const] : [];
  });
  if (installed.length === 0) throw new TypeError('At least one local-ai service handler is required');

  const active = new Set<Promise<void>>();
  const controls = new Set<Promise<void>>();
  const controlCapacity = 4;
  let rejectedRequests = 0;
  let timedOutRequests = 0;
  let failedRequests = 0;
  let successfulResponses = 0;
  let settledHandlers = 0;
  let connected = true;
  let serviceAvailable = true;
  let admissionStopped = false;
  let stopPromise: Promise<void> | undefined;

  const service = await nc.services.add({
    name: serviceName,
    version: config.serviceInfo?.version ?? '1.0.0',
    description: config.serviceInfo?.description ?? 'Brai local-ai model catalog and inference service',
    queue: 'brai_local_ai',
    statsHandler: async () => ({
      activeRequests: active.size,
      activeControlRequests: controls.size,
      maxConcurrentRequests: config.maxConcurrentRequests,
      rejectedRequests,
      timedOutRequests,
      failedRequests,
      successfulResponses,
      settledHandlers,
    }),
  });
  serviceAvailable = !service.isStopped;
  if (!serviceAvailable) throw new LocalAiError('DEPENDENCY_UNAVAILABLE', 'DEPENDENCY_UNAVAILABLE', true);

  for (const [subject, handler] of installed) {
    if (!handler) continue;
    service.addEndpoint(subject.replaceAll('.', '_'), {
      subject,
      queue: 'brai_local_ai',
      handler: (error, message) => {
        if (error) {
          connected = false;
          failedRequests++;
          sendError(message, new LocalAiError('DEPENDENCY_UNAVAILABLE', 'DEPENDENCY_UNAVAILABLE', true));
          return;
        }
        if (admissionStopped) {
          rejectedRequests++;
          failedRequests++;
          sendError(message, new LocalAiError('DEPENDENCY_UNAVAILABLE', 'DEPENDENCY_UNAVAILABLE', true));
          return;
        }
        const control = subject === subjects.cancel || subject === subjects.status;
        const admission = control ? controls : active;
        if (admission.size >= (control ? controlCapacity : config.maxConcurrentRequests)) {
          rejectedRequests++;
          failedRequests++;
          sendError(message, new LocalAiError('BUSY', 'BUSY', true));
          return;
        }

        const work = async (): Promise<void> => {
          let timeoutHandle: NodeJS.Timeout | undefined;
          let abortController: AbortController | undefined;
          try {
            const request = parseRequest(message, subject, config.maxRequestBytes);
            abortController = new AbortController();
            const { context, timeoutMs } = requestContext(request, config.maxRequestMs, abortController.signal, subject);
            const execution = Promise.resolve().then(() => handler(request, context));
            const tracked = execution.then(() => undefined, () => undefined);
            admission.add(tracked);
            void tracked.finally(() => {
              settledHandlers++;
              admission.delete(tracked);
            });

            const deadline = new Promise<never>((_resolve, reject) => {
              timeoutHandle = setTimeout(() => {
                timedOutRequests++;
                const error = new LocalAiError('DEADLINE_EXCEEDED', 'DEADLINE_EXCEEDED');
                abortController?.abort(error);
                reject(error);
              }, timeoutMs);
            });
            const result = await Promise.race([execution, deadline]);
            const json = JSON.stringify(result);
            if (typeof json !== 'string') throw new LocalAiError('INTERNAL', 'INTERNAL');
            const bytes = encoder.encode(json);
            if (bytes.byteLength > config.maxReplyBytes) throw new LocalAiError('RESULT_TOO_LARGE', 'RESULT_TOO_LARGE');
            if (!validateResponse(subject, result)) throw new LocalAiError('INTERNAL', 'INTERNAL');
            message.respond(bytes);
            successfulResponses++;
          } catch (error) {
            failedRequests++;
            sendError(message, error);
          } finally {
            if (timeoutHandle) clearTimeout(timeoutHandle);
          }
        };
        void work();
      },
    });
  }

  void service.stopped.then(() => { serviceAvailable = false; }, () => { serviceAvailable = false; });
  const statusEvents = nc.status() as unknown as QueuedIterator<Status>;
  if (typeof statusEvents.stop !== 'function') {
    serviceAvailable = false;
    await service.stop();
    throw new LocalAiError('DEPENDENCY_UNAVAILABLE', 'DEPENDENCY_UNAVAILABLE', true);
  }
  const statusIterator = statusEvents[Symbol.asyncIterator]();
  const statusMonitor = (async () => {
    try {
      for (;;) {
        const event = await statusIterator.next();
        if (event.done) break;
        if (event.value.type === Events.Disconnect) connected = false;
        if (event.value.type === Events.Reconnect) connected = true;
      }
    } catch {
      connected = false;
    }
  })();
  const stopStatusMonitor = async (): Promise<void> => {
    statusEvents.stop();
    await statusMonitor;
  };
  void nc.closed().then(() => { connected = false; }, () => { connected = false; });

  if (service.isStopped) {
    serviceAvailable = false;
    await service.stop();
    await stopStatusMonitor();
    throw new LocalAiError('DEPENDENCY_UNAVAILABLE', 'DEPENDENCY_UNAVAILABLE', true);
  }

  async function stopAdmission(): Promise<void> {
    if (stopPromise) return stopPromise;
    admissionStopped = true;
    serviceAvailable = false;
    stopPromise = (async () => {
      try {
        await service.stop();
      } finally {
        await stopStatusMonitor();
      }
    })();
    return stopPromise;
  }

  async function drainHandlers(): Promise<void> {
    await Promise.all([...active, ...controls]);
  }

  try { await nc.flush(); }
  catch { await stopAdmission(); throw new LocalAiError('DEPENDENCY_UNAVAILABLE', 'DEPENDENCY_UNAVAILABLE', true); }

  return {
    service,
    connected: () => connected && serviceAvailable && !service.isStopped && !nc.isClosed() && !nc.isDraining(),
    stopAdmission,
    drainHandlers,
    async close() {
      await stopAdmission();
      await drainHandlers();
    },
  };
}
