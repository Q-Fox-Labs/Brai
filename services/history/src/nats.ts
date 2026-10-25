// ABOUTME: Регистрирует сервис истории и преобразует NATS сообщения в вызовы ядра.
// ABOUTME: Источник записи удостоверяется ACL subject; SQL и проверка DTO принадлежат соседним слоям.
import { AckPolicy, DeliverPolicy, DiscardPolicy, RetentionPolicy, ReplayPolicy, StorageType, connect, type ConsumerMessages, type JsMsg, type NatsConnection, type Service, type ServiceMsg } from "nats";
import { randomUUID } from "node:crypto";
import { decodeJson, errorStatus, limits } from "./contracts.js";
import { HistoryFault, type HistoryHandlers } from "./domain.js";
import type { Config } from "./config.js";
import type { LoadGate } from "./load.js";

const appendSubject = "brai.history.v1.append.*";
const listSubject = "brai.history.v1.query.list";
const getSubject = "brai.history.v1.query.get";
const sourcePattern = /^[a-z][a-z0-9_]{0,63}$/;
const gameCoreStream = "BRAI_GAME_CORE_EVENTS_V1";
const gameCoreDurable = "history_game_core_events";
const gameCoreSubject = "brai.game-core.v1.events.>";

/** Подключает service identity и использует inbox, разрешённый его ACL. */
export function connectNats(config: Config): Promise<NatsConnection> {
  return connect({
    servers: config.natsServers,
    user: config.natsUser,
    pass: config.natsPassword,
    inboxPrefix: config.natsInboxPrefix,
    maxReconnectAttempts: -1,
    timeout: 5_000,
    name: "service_history",
  });
}

function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HistoryFault("INVALID_ARGUMENT");
  return value as Record<string, unknown>;
}

function appendSource(subject: string): string {
  const parts = subject.split(".");
  const source = parts[4];
  if (parts.length !== 5 || parts.slice(0, 4).join(".") !== "brai.history.v1.append" || !sourcePattern.test(source ?? "")) {
    throw new HistoryFault("INVALID_ARGUMENT");
  }
  return source;
}

function safeFault(error: unknown): HistoryFault {
  if (error instanceof HistoryFault) return error;
  return new HistoryFault("INTERNAL");
}

function errorBody(error: HistoryFault): Buffer {
  return Buffer.from(JSON.stringify({ code: error.code, message: error.code, retryable: error.retryable }), "utf8");
}

function respondError(message: ServiceMsg, error: HistoryFault): void {
  message.respondError(errorStatus[error.code], error.code, errorBody(error));
}

function eventId(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const id = (raw as Record<string, unknown>).id;
  return typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
    ? id.toLowerCase()
    : undefined;
}

function logResult(fields: { requestId: string; executor: string; operation: string; eventId?: string; source?: string; durationMs: number; result: string }): void {
  console.log(JSON.stringify(fields));
}

/** Регистрирует запись и доверенное web-чтение; PING, INFO и STATS предоставляет NATS SDK. */
export async function runNats(nc: NatsConnection, handlers: HistoryHandlers, gate: LoadGate): Promise<{ service: Service; stop: () => Promise<unknown> }> {
  await handlers.ready();
  await nc.flush();
  const service = await nc.services.add({
    name: "service_history",
    version: "1.0.0",
    description: "Brai immutable history service",
    queue: "service_history",
  });

  async function handle(operation: "append" | "list" | "get", msg: ServiceMsg): Promise<void> {
    const requestId = randomUUID();
    const started = performance.now();
    let rawSource: string | undefined;
    let decoded: unknown;
    let id: string | undefined;
    try {
      if (operation === "append") rawSource = appendSource(msg.subject);
      if (msg.data.length > limits.maxRequestBytes) throw new HistoryFault("REQUEST_TOO_LARGE");
      try { decoded = decodeJson(msg.data); }
      catch { throw new HistoryFault("INVALID_ARGUMENT"); }
      id = eventId(decoded);
      const result = await gate.run(async context => {
        const value = objectValue(decoded);
        if (operation === "append") {
          if (Object.hasOwn(value, "source") || rawSource === undefined) throw new HistoryFault("INVALID_ARGUMENT");
          return handlers.appendEvent({ ...value, source: rawSource }, context);
        }
        return operation === "list" ? handlers.listForWeb(value, context) : handlers.getForWeb(value, context);
      });
      const payload = Buffer.from(JSON.stringify(result), "utf8");
      if (payload.byteLength > limits.maxResponseBytes) throw new HistoryFault("RESULT_TOO_LARGE");
      msg.respond(payload);
      logResult({ requestId, executor: service.info().id, operation, ...(id ? { eventId: id } : {}), ...(rawSource ? { source: rawSource } : {}), durationMs: Math.round(performance.now() - started), result: "OK" });
    } catch (cause) {
      const error = safeFault(cause);
      respondError(msg, error);
      logResult({ requestId, executor: service.info().id, operation, ...(id ? { eventId: id } : {}), ...(rawSource ? { source: rawSource } : {}), durationMs: Math.round(performance.now() - started), result: error.code });
    }
  }

  try {
    service.addEndpoint("append", { subject: appendSubject, queue: "service_history", handler: (error, msg) => { if (!error) void handle("append", msg); } });
    service.addEndpoint("list", { subject: listSubject, queue: "service_history", handler: (error, msg) => { if (!error) void handle("list", msg); } });
    service.addEndpoint("get", { subject: getSubject, queue: "service_history", handler: (error, msg) => { if (!error) void handle("get", msg); } });
  } catch (error) {
    await service.stop();
    throw error;
  }
  return { service, stop: () => service.stop() };
}

/** Подключает опциональный durable consumer общего GameCore stream; ACK следует за COMMIT истории. */
export async function runGameCoreEvents(nc: NatsConnection, handlers: HistoryHandlers, gate: LoadGate): Promise<{ finished: Promise<void>; stop: () => Promise<void> }> {
  const manager = await nc.jetstreamManager(); const stream = (await manager.streams.info(gameCoreStream)).config;
  if (stream.storage !== StorageType.File || stream.retention !== RetentionPolicy.Limits || !stream.subjects?.includes(gameCoreSubject)) throw new Error("HISTORY_GAME_CORE_STREAM_CONFIG_MISMATCH");
  const consumer = await manager.consumers.info(gameCoreStream, gameCoreDurable);
  if (consumer.config.ack_policy !== AckPolicy.Explicit || consumer.config.deliver_policy !== DeliverPolicy.All || consumer.config.replay_policy !== ReplayPolicy.Instant || consumer.config.filter_subject !== gameCoreSubject || consumer.config.max_deliver !== -1 || consumer.config.headers_only || consumer.config.deliver_subject) throw new Error("HISTORY_GAME_CORE_CONSUMER_CONFIG_MISMATCH");
  const pull = await nc.jetstream().consumers.get(gameCoreStream, gameCoreDurable); let stopped = false; let messages: ConsumerMessages | undefined;
  const finished = (async () => { while (!stopped && !nc.isClosed()) { try { messages = await pull.consume({ max_messages: 1, expires: 1_000 }); for await (const message of messages) { if (stopped) { message.nak(); break; } await consumeElementEvent(message, handlers, gate); } } catch (error) { if (!stopped) console.error(JSON.stringify({ service: "service_history", operation: "game-core.consume", result: error instanceof Error ? error.name : "UNKNOWN" })); } finally { messages?.stop(); messages = undefined; } } })();
  return { finished, async stop() { stopped = true; messages?.stop(); await finished; } };
}
async function consumeElementEvent(message: JsMsg, handlers: HistoryHandlers, gate: LoadGate): Promise<void> {
  try { const value = decodeJson(message.data); await gate.run(context => handlers.appendGameCoreEvent(value, context)); message.ack(); }
  catch (error) { const failure = safeFault(error); if (["INVALID_ARGUMENT", "EVENT_ID_CONFLICT", "NOT_FOUND"].includes(failure.code)) message.term(); else message.nak(Math.min(30_000, 1000 * 2 ** Math.min(5, message.info.deliveryCount - 1))); }
}
