// ABOUTME: Передаёт чтения и долговечные команды через NATS таймеру.
// ABOUTME: Секреты используются только в серверном процессе; HTTP 202 требует PubAck.
import { connect, AckPolicy, DeliverPolicy, ReplayPolicy, nanos, type NatsConnection, type Consumer } from "nats";
import { valid } from "./contracts";
import type { Snapshot, History, CommandResult, Statistics, TimerEvent } from "../lib/types";
/** Ошибка границы HTTP; unknown означает возможное сохранение команды. */
export class GatewayError extends Error {
 constructor(public status: number, public code: string, public outcome: "not-published" | "unknown" | "query" = "query") { super(code); }
}
let connection: Promise<NatsConnection> | undefined;
const connected = new WeakMap<NatsConnection, boolean>();
function ready(nc: NatsConnection) { return !nc.isClosed() && !nc.isDraining() && connected.get(nc) !== false; }
/** Возвращает одно соединение процесса; ошибки начального подключения допускают повтор. */
export async function natsConnection(): Promise<NatsConnection> {
 if (!connection) {
  if (!process.env.NATS_URL) throw new GatewayError(503, "UNAVAILABLE", "not-published");
  connection = connect({ servers: process.env.NATS_URL, user: process.env.NATS_USER, pass: process.env.NATS_PASSWORD,
   inboxPrefix: process.env.NATS_INBOX_PREFIX || "_INBOX.brai_web", name: "brai_web", timeout: 2000, maxReconnectAttempts: -1 });
    connection.then(nc => {
   connected.set(nc, true);
   void (async () => { for await (const status of nc.status()) {
    if (status.type === "disconnect") connected.set(nc, false);
    if (status.type === "reconnect") connected.set(nc, true);
   } connected.set(nc, false); })();
  }).catch(() => { connection = undefined; });
 }
 const nc = await connection;
 if (nc.isClosed()) { connection = undefined; throw new GatewayError(503, "UNAVAILABLE", "not-published"); }
 return nc;
}
/** Выполняет NATS Services query; проверяет стандартные заголовки до DTO. */
export async function query<T>(name: "snapshot" | "history" | "command" | "statistics", body: object): Promise<T> {
 const dto = name === "snapshot" ? "Snapshot" : name === "history" ? "History" : name === "command" ? "CommandLookup" : "Statistics";
 if (!valid(`messages.schema.json#/definitions/${dto}Request`, body)) throw new GatewayError(400, "INVALID_ARGUMENT");
 try {
  const nc = await natsConnection();
  if (!ready(nc)) throw new GatewayError(503, "UNAVAILABLE");
  const reply = await nc.request(`brai.timer.v2.query.${name}`, Buffer.from(JSON.stringify(body)), { timeout: 2000 });
  if (reply.headers?.has("Nats-Service-Error") || reply.headers?.has("Nats-Service-Error-Code")) {
   const error: unknown = JSON.parse(Buffer.from(reply.data).toString());
   if (!valid("common.schema.json#/definitions/error", error)) throw new GatewayError(502, "BAD_REPLY");
   const code = (error as { code: string }).code;
   const status = code === "NOT_FOUND" ? 404 : code === "INVALID_ARGUMENT" ? 400 :
    ["HISTORY_CHANGED", "INTERVAL_OVERLAP", "VERSION_CONFLICT"].includes(code) ? 409 : 503;
   throw new GatewayError(status, code);
  }
  const data: unknown = JSON.parse(Buffer.from(reply.data).toString());
  if (!valid(`messages.schema.json#/definitions/${dto}Response`, data)) throw new GatewayError(502, "BAD_REPLY");
  return data as T;
 } catch (error) {
  if (error instanceof GatewayError) throw error;
  throw new GatewayError(503, "UNAVAILABLE");
 }
}
/** Проверяет вход до публикации; повтор требует исходного body и commandId. */
export async function publish(type: "start" | "stop" | "edit" | "delete", body: unknown): Promise<void> {
 const dto = { start: "StartCommand", stop: "StopCommand", edit: "EditCommand", delete: "DeleteCommand" }[type];
 if (!valid(`commands.schema.json#/definitions/${dto}`, body)) throw new GatewayError(400, "INVALID_ARGUMENT", "not-published");
 let nc: NatsConnection;
 try { nc = await natsConnection(); } catch { throw new GatewayError(503, "UNAVAILABLE", "not-published"); }
 if (!ready(nc)) throw new GatewayError(503, "UNAVAILABLE", "not-published");
 try {
  await nc.jetstream().publish(`brai.timer.v2.command.${type}`, Buffer.from(JSON.stringify(body)), { timeout: 2000 });
 } catch (error) {
  // AIDEV-NOTE: Только явный отрицательный ответ брокера доказывает отказ; timeout может скрыть PubAck.
  const api = (error as { api_error?: unknown }).api_error;
  throw new GatewayError(api ? 503 : 502, api ? "PUBLISH_REJECTED" : "PUBLISH_UNKNOWN", api ? "not-published" : "unknown");
 }
}
/** Создаёт только разрешённый web_events durable с ограниченным числом unacked событий. */
export async function eventConsumer(nc: NatsConnection): Promise<Consumer> {
 const manager = await nc.jetstreamManager();
 await manager.consumers.add("BRAI_TIMER_EVENTS_V2", { durable_name: "web_events", filter_subject: "brai.timer.v2.event.*",
  ack_policy: AckPolicy.Explicit, ack_wait: nanos(30000), max_ack_pending: 64, max_deliver: -1,
  deliver_policy: DeliverPolicy.All, replay_policy: ReplayPolicy.Instant });
 return nc.jetstream().consumers.get("BRAI_TIMER_EVENTS_V2", "web_events");
}
/** Валидирует одно событие по варианту owner schema. */
export function parseEvent(data: Uint8Array): TimerEvent {
 const event: unknown = JSON.parse(Buffer.from(data).toString());
 if (!["StartedEvent", "StoppedEvent", "TimerEditedEvent", "TimerDeletedEvent", "RejectedEvent"].some(dto => valid(`messages.schema.json#/definitions/${dto}`, event))) throw new Error("BAD_EVENT");
 return event as TimerEvent;
}
/** Читает согласованный снимок владельца. */
export const snapshot = (userId: string) => query<Snapshot>("snapshot", { userId });
/** Передаёт непрозрачный owner cursor без изменения. */
export const history = (userId: string, limit: number, cursor: string | null) => query<History>("history", { userId, limit, cursor });
/** Читает окончательный ledger result; NOT_FOUND не отменяет команду. */
export const command = (userId: string, commandId: string) => query<CommandResult>("command", { userId, commandId });
/** Возвращает полную дневную и челлендж статистику timer владельца. */
export const statistics = (userId: string) => query<Statistics>("statistics", { userId });
