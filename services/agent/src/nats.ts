// ABOUTME: Подключает прикладные сценарии и проекцию к NATS Services/Core NATS.
// ABOUTME: Проверяет байтовые пределы до разбора JSON и держит конечную очередь событий.

import {
  connect,
  ServiceErrorCodeHeader,
  ServiceErrorHeader,
  Events,
  headers,
  type NatsConnection,
  type Service,
  type ServiceMsg,
} from "nats";
import { limits, serializedBytes, subjects, validateDto, validateEventEnvelope } from "../contracts/index.mjs";
import type { HistoryRequest, RequestRespondRequest, ThreadCreateRequest, ThreadReadRequest, ThreadsRequest, TurnInterruptRequest, TurnStartRequest, TurnSteerRequest } from "../contracts/index.mjs";
import { toErrorResponse } from "./application.js";
import type { EventEnvelope } from "./projection.js";
import type { AgentConfig } from "./config.js";

type App = ReturnType<typeof import("./application.js").createApplication>;
type Projection = ReturnType<typeof import("./projection.js").createProjection>;
type ErrorSource = { code?: string; outcome?: string };
const serviceErrorStatus: Record<string, number> = {
  INVALID_ARGUMENT: 400, STALE_GENERATION: 409, OPERATION_CONFLICT: 409,
  REQUEST_TOO_LARGE: 413, ITEM_TOO_LARGE: 413, CAPACITY_EXHAUSTED: 503,
  UPSTREAM_UNAVAILABLE: 503, TIMEOUT: 504, NOT_FOUND: 404,
  UNSUPPORTED: 501, STALE_REQUEST: 409,
};
const endpoints = [
  ["projects", subjects.projects, "ProjectsRequest", "ProjectsResponse"],
  ["status", subjects.status, "StatusRequest", "StatusResponse"],
  ["threads", subjects.threads, "ThreadsRequest", "ThreadsResponse"],
  ["thread", subjects.thread, "ThreadReadRequest", "ThreadSnapshot"],
  ["history", subjects.history, "HistoryRequest", "HistoryResponse"],
  ["threadCreate", subjects.threadCreate, "ThreadCreateRequest", "ThreadCreateResponse"],
  ["turnStart", subjects.turnStart, "TurnStartRequest", "TurnMutationResponse"],
  ["turnSteer", subjects.turnSteer, "TurnSteerRequest", "TurnMutationResponse"],
  ["turnInterrupt", subjects.turnInterrupt, "TurnInterruptRequest", "TurnMutationResponse"],
  ["requestRespond", subjects.requestRespond, "RequestRespondRequest", "RequestRespondResponse"],
] as const;
const inputType = new Map<string, string>(endpoints.map(([key, , input]) => [key, input]));
const outputType = new Map<string, string>(endpoints.map(([key, , , output]) => [key, output]));
const isMutationEndpoint = (name: string): boolean => ["threadCreate", "turnStart", "turnSteer", "turnInterrupt", "requestRespond"].includes(name);

type QueuedEvent = { envelope: EventEnvelope; bytes: number };
type MarkerSource = Omit<EventEnvelope, "event">;
const EVENT_QUEUE_COUNT = 512;
const EVENT_QUEUE_BYTES = 8 * 1024 * 1024;
const SHUTDOWN_DRAIN_MS = 5000;
const SEND_FLUSH_MS = 10000;

async function boundedWait<T>(work: Promise<T>, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      work.then(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref();
      }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

/** Подключает этот экземпляр к явно настроенным NATS servers. */
export function connectNats(config: AgentConfig["nats"]): Promise<NatsConnection> {
  return connect({
    servers: config.servers,
    ...(config.user === undefined ? {} : { user: config.user, pass: config.password }),
    inboxPrefix: config.inboxPrefix,
    maxReconnectAttempts: -1,
    timeout: 5000,
    name: "brai_agent",
  });
}

/** Запускает NATS endpoints и одну bounded-публикацию для текущих AG-UI событий. */
export async function createNats(options: { nc: NatsConnection; application: App; projection: Projection; onError?: (error: unknown) => void }) {
  const { nc, application, projection } = options;
  let closed = false;
  let brokerConnected = !nc.isClosed();
  let sendHealthy = true;
  let pendingFlush: Promise<void> | undefined;
  let projectionHealthy = true;
  let activeRequests = 0;
  const drainedWaiters: (() => void)[] = [];
  const MAX_REQUESTS = limits.pendingRpc;
  let service: Service | undefined;
  let eventCount = 0;
  let eventBytes = 0;
  const eventQueue: QueuedEvent[] = [];
  let eventWorker = false;
  const subscriptions = new Set<() => void>();
  const latestByThread = new Map<string, MarkerSource>();
  const needsResync = new Map<string, { source: MarkerSource; reason: "gap" | "overflow" | "generation-change" | "epoch-change" | "old-epoch" }>();
  const queuedRecovery = new Set<string>();
  let resubscribeAttempts = 0;
  let sendTail: Promise<void> = Promise.resolve();
  let flush: () => Promise<void>;
  let flushProbeTimer: NodeJS.Timeout | undefined;
  let flushProbeAttempts = 0;
  let fatalSendFailure = false;
  const readiness = () => {
    const app = application.status();
    return { ...app, ready: !closed && !fatalSendFailure && brokerConnected && !nc.isClosed() && sendHealthy && projectionHealthy && app.ready };
  };
  const report = (error: unknown) => { try { options.onError?.(error); } catch { /* Логгер не управляет обработкой. */ } };
  const sendExclusive = (action: () => Promise<void>): Promise<void> => {
    const pending = sendTail.then(action);
    sendTail = pending.catch(() => undefined);
    return pending;
  };
  function scheduleFlushProbe(): void {
    if (closed || fatalSendFailure || !brokerConnected || nc.isClosed() || pendingFlush || flushProbeTimer) return;
    if (flushProbeAttempts >= 3) {
      fatalSendFailure = true;
      void service?.stop().catch(report);
      report(new Error("NATS_SEND_RECOVERY_EXHAUSTED"));
      return;
    }
    flushProbeTimer = setTimeout(() => {
      flushProbeTimer = undefined;
      flushProbeAttempts++;
      void sendExclusive(() => flush()).then(() => {
        flushProbeAttempts = 0;
        queueRecoveryMarkers();
      }).catch(scheduleFlushProbe);
    }, 1000 * (2 ** flushProbeAttempts));
    flushProbeTimer.unref();
  }
  const keyOf = (source: MarkerSource) => `${source.projectId}\0${source.threadId}`;
  const rememberLatest = (source: MarkerSource) => {
    const key = keyOf(source);
    latestByThread.delete(key);
    latestByThread.set(key, source);
    while (latestByThread.size > limits.loadedThreads)
      latestByThread.delete(latestByThread.keys().next().value!);
  };
  const markerFor = (source: MarkerSource, reason: "gap" | "overflow" | "generation-change" | "epoch-change" | "old-epoch"): EventEnvelope => ({
    ...source,
    event: { type: "CUSTOM", name: "brai.agent.resync-required", value: { reason } } as EventEnvelope["event"],
  });
  const rememberGap = (source: MarkerSource, reason: "gap" | "overflow" | "generation-change" | "epoch-change" | "old-epoch") => {
    const key = keyOf(source);
    if (!needsResync.has(key) && needsResync.size >= limits.loadedThreads) {
      projectionHealthy = false;
      report(new Error("NATS_RESYNC_CAPACITY_EXHAUSTED"));
      return;
    }
    rememberLatest(source);
    needsResync.set(key, { source, reason });
  };
  const queueRecoveryMarkers = () => {
    if (closed || !brokerConnected) return;
    for (const [key, pending] of needsResync) {
      if (queuedRecovery.has(key)) continue;
      const envelope = markerFor(pending.source, pending.reason);
      const bytes = serializedBytes(envelope);
      if (eventCount >= EVENT_QUEUE_COUNT || eventBytes + bytes > EVENT_QUEUE_BYTES) break;
      queuedRecovery.add(key);
      eventCount++;
      eventBytes += bytes;
      eventQueue.push({ envelope, bytes });
    }
    void drainEvents();
  };
  flush = async () => {
    let timer: NodeJS.Timeout | undefined;
    try {
      if (!pendingFlush) {
        const pending = nc.flush();
        pendingFlush = pending;
        void pending.then(() => {
          if (pendingFlush === pending) pendingFlush = undefined;
          if (!closed && brokerConnected && !nc.isClosed()) {
            sendHealthy = true;
            queueRecoveryMarkers();
          }
        }, () => {
          if (pendingFlush === pending) pendingFlush = undefined;
          sendHealthy = false;
          queueMicrotask(scheduleFlushProbe);
        });
      }
      await Promise.race([
        pendingFlush,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("NATS_FLUSH_TIMEOUT")), SEND_FLUSH_MS);
          timer.unref();
        }),
      ]);
      sendHealthy = true;
      flushProbeAttempts = 0;
      if (flushProbeTimer) clearTimeout(flushProbeTimer);
      flushProbeTimer = undefined;
    } catch (error) {
      sendHealthy = false;
      report(error);
      scheduleFlushProbe();
      throw error;
    } finally { if (timer) clearTimeout(timer); }
  };
  const emit = async (entry: QueuedEvent) => {
    if (closed) return;
    const source: MarkerSource = {
      projectId: entry.envelope.projectId,
      threadId: entry.envelope.threadId,
      turnId: entry.envelope.turnId,
      generation: entry.envelope.generation,
      streamEpoch: entry.envelope.streamEpoch,
      seq: entry.envelope.seq,
    };
    const key = keyOf(source);
    try {
      if (!brokerConnected || nc.isClosed() || !sendHealthy) throw new Error("NATS_SEND_UNAVAILABLE");
      await sendExclusive(async () => {
        if (!brokerConnected || nc.isClosed() || !sendHealthy) throw new Error("NATS_SEND_UNAVAILABLE");
        nc.publish(subjects.event, Buffer.from(JSON.stringify(entry.envelope)));
        await flush();
      });
      if (entry.envelope.event.type === "CUSTOM" && entry.envelope.event.name === "brai.agent.resync-required") {
        const saved = needsResync.get(key);
        if (saved?.source.seq === entry.envelope.seq) needsResync.delete(key);
        queuedRecovery.delete(key);
      }
    } catch (error) {
      if (nc.isClosed()) brokerConnected = false;
      rememberGap(source, "gap");
      report(error);
      for (const queued of eventQueue.splice(0)) {
        eventCount--;
        eventBytes -= queued.bytes;
        const queuedSource = { projectId: queued.envelope.projectId, threadId: queued.envelope.threadId, turnId: queued.envelope.turnId, generation: queued.envelope.generation, streamEpoch: queued.envelope.streamEpoch, seq: queued.envelope.seq };
        rememberGap(queuedSource, "gap");
      }
      queuedRecovery.clear();
    } finally {
      eventCount--;
      eventBytes -= entry.bytes;
    }
  };
  const drainEvents = async () => {
    if (eventWorker) return;
    eventWorker = true;
    try { while (!closed && eventQueue.length) await emit(eventQueue.shift()!); }
    finally { eventWorker = false; }
  };
  const enqueueEvent = (envelope: EventEnvelope) => {
    if (closed) return;
    const bytes = serializedBytes(envelope);
    if (!validateEventEnvelope(envelope) || bytes > limits.natsSseFrameBytes) {
      projectionHealthy = false;
      report(new Error("INVALID_AGENT_EVENT"));
      return;
    }
    const source: MarkerSource = { projectId: envelope.projectId, threadId: envelope.threadId, turnId: envelope.turnId, generation: envelope.generation, streamEpoch: envelope.streamEpoch, seq: envelope.seq };
    const key = keyOf(source);
    rememberLatest(source);
    if (!brokerConnected || nc.isClosed() || !sendHealthy) { rememberGap(source, "gap"); return; }
    if (eventCount >= EVENT_QUEUE_COUNT || eventBytes + bytes > EVENT_QUEUE_BYTES) {
      for (const queued of eventQueue.splice(0)) {
        eventCount--;
        eventBytes -= queued.bytes;
        rememberGap({ projectId: queued.envelope.projectId, threadId: queued.envelope.threadId, turnId: queued.envelope.turnId, generation: queued.envelope.generation, streamEpoch: queued.envelope.streamEpoch, seq: queued.envelope.seq }, "overflow");
      }
      queuedRecovery.clear();
      rememberGap(source, "overflow");
      report(new Error("NATS_EVENT_QUEUE_FULL"));
      queueRecoveryMarkers();
      return;
    }
    eventCount++;
    eventBytes += bytes;
    eventQueue.push({ envelope: structuredClone(envelope), bytes });
    void drainEvents();
  };

  const errorReply = (msg: ServiceMsg, error: unknown, operationId?: string): Promise<void> => {
    const generation = application.status().generation;
    const { body } = toErrorResponse(error, generation, operationId);
    const status = serviceErrorStatus[body.code] ?? 503;
    const hdr = headers();
    hdr.set(ServiceErrorHeader, body.code);
    hdr.set(ServiceErrorCodeHeader, String(status));
    const payload = Buffer.from(JSON.stringify(body));
    return sendExclusive(async () => {
      if (!brokerConnected || nc.isClosed() || !sendHealthy) throw new Error("NATS_SEND_UNAVAILABLE");
        if (!msg.respond(payload, { headers: hdr })) throw new Error("NATS_REPLY_UNAVAILABLE");
      await flush();
    }).catch((failure) => { report(failure); });
  };

  let overflowErrors = 0;
  async function handle(name: string, message: ServiceMsg): Promise<void> {
    if (activeRequests >= MAX_REQUESTS) {
      if (!message.reply || overflowErrors >= MAX_REQUESTS) {
        report(new Error("NATS_REQUEST_REJECTION_QUEUE_FULL"));
        return;
      }
      overflowErrors++;
      await errorReply(message, Object.assign(new Error("Request capacity exhausted"), { code: "CAPACITY_EXHAUSTED", outcome: "not-sent" })).finally(() => { overflowErrors--; });
      return;
    }
    activeRequests++;
    let request: any;
    let replyAttempted = false;
    try {
    if (closed || !brokerConnected || nc.isClosed() || !sendHealthy) {
      await errorReply(message, Object.assign(new Error("Service is closing"), { code: "UPSTREAM_UNAVAILABLE", outcome: "not-sent" }));
      return;
    }
    if (!message.reply) {
      return;
    }
    const expected = inputType.get(name)!;
    const raw = message.data;
    const max = name === "turnStart" || name === "turnSteer" ? limits.inputTextBytes : limits.natsSseFrameBytes;
    if (raw.byteLength > max) {
      await errorReply(message, Object.assign(new Error("Request too large"), { code: "REQUEST_TOO_LARGE", outcome: "not-sent" }));
      return;
    }
    try { request = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)); }
    catch {
      await errorReply(message, Object.assign(new Error("Invalid JSON"), { code: "INVALID_ARGUMENT", outcome: "not-sent" }));
      return;
    }
    if (!validateDto(expected as any, request)) {
      const operationId = (request as { operationId?: unknown } | undefined)?.operationId;
      const opId = typeof operationId === "string" ? operationId : undefined;
      await errorReply(message, Object.assign(new Error("Invalid request"), { code: "INVALID_ARGUMENT", outcome: "not-sent" }), opId);
      return;
    }
      let result: unknown;
      switch (name) {
        case "projects": result = application.projects(); break;
        case "status": result = readiness(); break;
        case "threads": result = await application.threads(request as ThreadsRequest); break;
        case "thread": result = await application.thread(request as ThreadReadRequest); break;
        case "history": result = await application.history(request as HistoryRequest); break;
        case "threadCreate": result = await application.threadCreate(request as ThreadCreateRequest); break;
        case "turnStart": result = await application.turnStart(request as TurnStartRequest); break;
        case "turnSteer": result = await application.turnSteer(request as TurnSteerRequest); break;
        case "turnInterrupt": result = await application.turnInterrupt(request as TurnInterruptRequest); break;
        case "requestRespond": result = await application.requestRespond(request as RequestRespondRequest); break;
        default: throw Object.assign(new Error("Unknown endpoint"), { code: "UNSUPPORTED", outcome: "not-sent" });
      }
      const output = outputType.get(name)!;
      const responseOutcome = isMutationEndpoint(name) ? "unknown" : "query";
      if (!validateDto(output as any, result)) throw Object.assign(new Error("Invalid service response"), { code: "CAPACITY_EXHAUSTED", outcome: responseOutcome });
      const payload = Buffer.from(JSON.stringify(result));
      if (payload.byteLength > limits.natsSseFrameBytes) throw Object.assign(new Error("Response too large"), { code: "CAPACITY_EXHAUSTED", outcome: responseOutcome });
      await sendExclusive(async () => {
        if (!brokerConnected || nc.isClosed() || !sendHealthy) throw Object.assign(new Error("NATS disconnected before reply"), { code: "UPSTREAM_UNAVAILABLE", outcome: responseOutcome });
        replyAttempted = true;
        if (!message.respond(payload)) throw Object.assign(new Error("NATS reply unavailable"), { code: "UPSTREAM_UNAVAILABLE", outcome: responseOutcome });
        await flush();
      });
    } catch (error) {
      const rawOperationId = (request as { operationId?: unknown } | undefined)?.operationId;
      const operationId = typeof rawOperationId === "string" ? rawOperationId : undefined;
      if (replyAttempted) report(error);
      else await errorReply(message, error as ErrorSource, operationId);
    } finally {
      activeRequests--;
      if (activeRequests === 0) for (const resolve of drainedWaiters.splice(0)) resolve();
    }
  }

  service = await nc.services.add({ name: "brai_agent", version: "1.0.0", description: "Brai agent service", queue: "brai_agent" });
  for (const [name, subject] of endpoints) {
    service.addEndpoint(name, {
      subject,
      queue: "brai_agent",
      handler: (error, message) => {
        if (error) { report(error); return; }
        void handle(name, message as ServiceMsg).catch(report);
      },
    });
  }
  const subscribeProjection = () => {
    const unsubscribe = projection.subscribe((event) => { enqueueEvent(event); }, (reason) => {
      subscriptions.delete(unsubscribe);
      if (reason === "closed" || closed) return;
      projectionHealthy = false;
      report(new Error(`PROJECTION_${reason.toUpperCase()}`));
      if (resubscribeAttempts >= 3) return;
      resubscribeAttempts++;
      queueMicrotask(() => {
        if (closed) return;
        try {
          subscribeProjection();
          projectionHealthy = true;
          for (const source of latestByThread.values()) rememberGap(source, "overflow");
          queueRecoveryMarkers();
        } catch (error) { report(error); }
      });
    });
    subscriptions.add(unsubscribe);
  };
  subscribeProjection();
  void (async () => {
    try {
      for await (const status of nc.status()) {
        if (status.type === Events.Disconnect) {
          brokerConnected = false;
          sendHealthy = false;
          for (const queued of eventQueue.splice(0)) {
            eventCount--;
            eventBytes -= queued.bytes;
            rememberGap({ projectId: queued.envelope.projectId, threadId: queued.envelope.threadId, turnId: queued.envelope.turnId, generation: queued.envelope.generation, streamEpoch: queued.envelope.streamEpoch, seq: queued.envelope.seq }, "gap");
          }
          queuedRecovery.clear();
        } else if (status.type === Events.Reconnect) {
          brokerConnected = true;
          sendHealthy = false;
          void sendExclusive(() => flush()).then(queueRecoveryMarkers).catch(report);
        }
      }
    } catch (error) { if (!closed) report(error); }
  })();
  let closePromise: Promise<void> | undefined;
  return {
    instanceId: service.info().id,
    /** Проверяет транспорт, native инициализацию Codex и авторизацию. */
    status() {
      return readiness();
    },
    /** Останавливает собственные подписки сервиса и завершает отправку событий. */
    close() {
      if (closePromise) return closePromise;
      closed = true;
      if (flushProbeTimer) clearTimeout(flushProbeTimer);
      flushProbeTimer = undefined;
      closePromise = (async () => {
      for (const remove of subscriptions) remove();
      subscriptions.clear();
      if (service) await boundedWait(service.stop(), SHUTDOWN_DRAIN_MS);
      if (activeRequests > 0) await boundedWait(new Promise<void>((resolve) => drainedWaiters.push(resolve)), SHUTDOWN_DRAIN_MS);
      eventQueue.length = 0;
      eventCount = 0;
      eventBytes = 0;
      })();
      return closePromise;
    },
  };
}
