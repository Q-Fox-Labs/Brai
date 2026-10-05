// ABOUTME: Регистрирует сервис истории и преобразует NATS сообщения в вызовы ядра.
// ABOUTME: Источник записи удостоверяется ACL subject; SQL и проверка DTO принадлежат соседним слоям.
import { connect, type NatsConnection, type Service, type ServiceMsg } from "nats";
import { randomUUID } from "node:crypto";
import { decodeJson, errorStatus, limits } from "./contracts.js";
import { HistoryFault, type HistoryHandlers } from "./domain.js";
import type { Config } from "./config.js";
import type { LoadGate } from "./load.js";

const appendSubject = "brai.history.v1.append.*";
const listSubject = "brai.history.v1.query.list";
const getSubject = "brai.history.v1.query.get";
const sourcePattern = /^[a-z][a-z0-9_]{0,63}$/;

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
