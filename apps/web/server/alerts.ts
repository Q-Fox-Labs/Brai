// ABOUTME: Передаёт запросы уведомлений NATS Services по схеме владельца.
// ABOUTME: Пользователя задаёт только проверенная серверная сессия; ошибки не раскрывают детали.
import { valid } from "./contracts";
import { GatewayError, natsConnection } from "./gateway";
import type { AlertPage, AlertSummary, AlertNotification } from "../lib/alerts-types";
export const alertsSchema = "https://brai.app/schemas/alerts/messages.schema.json#/definitions/";
type Operation = "list" | "get" | "summary" | "read" | "read_all";
const dto = { list: "list", get: "get", summary: "summary", read: "read", read_all: "readAll" };
const statuses: Record<string, number> = { INVALID_ARGUMENT: 400, INVALID_CURSOR: 400, REQUEST_TOO_LARGE: 413,
 RESULT_TOO_LARGE: 413, NOT_FOUND: 404, EVENT_ID_CONFLICT: 409, UNKNOWN_TYPE: 400, BUSY: 503,
 DATABASE_UNAVAILABLE: 503, DEADLINE_EXCEEDED: 504, INTERNAL: 500 };
/** Выполняет один owner-valid запрос; read/read_all идемпотентны, автоматического повтора нет. */
export async function alertsRequest<T = AlertSummary>(operation: Operation, body: object): Promise<T> {
 if (!valid(alertsSchema + dto[operation] + "Request", body)) throw new GatewayError(400, "INVALID_ARGUMENT");
 const bytes = Buffer.from(JSON.stringify(body));
 if (bytes.length > 64 * 1024) throw new GatewayError(413, "REQUEST_TOO_LARGE");
 let reply;
 try {
  const nc = await natsConnection();
  if (nc.isClosed() || nc.isDraining()) throw new GatewayError(503, "UNAVAILABLE");
  reply = await nc.request(`brai.alerts.v1.${operation === "read" || operation === "read_all" ? "command" : "query"}.${operation}`, bytes, { timeout: 10000 });
 } catch (error) {
  if (error instanceof GatewayError) throw error;
  throw new GatewayError((error as { code?: string })?.code === "TIMEOUT" ? 504 : 503,
   (error as { code?: string })?.code === "TIMEOUT" ? "DEADLINE_EXCEEDED" : "UNAVAILABLE");
 }
 if (reply.data.length > 512 * 1024) throw new GatewayError(502, "BAD_REPLY");
 let result: unknown;
 try { result = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(reply.data)); }
 catch { throw new GatewayError(502, "BAD_REPLY"); }
 if (reply.headers?.has("Nats-Service-Error") || reply.headers?.has("Nats-Service-Error-Code")) {
  if (!valid(alertsSchema + "error", result)) throw new GatewayError(502, "BAD_REPLY");
  const code = (result as { code: string }).code, status = statuses[code];
  if (!status || reply.headers?.get("Nats-Service-Error") !== code || reply.headers?.get("Nats-Service-Error-Code") !== String(status)) throw new GatewayError(502, "BAD_REPLY");
  throw new GatewayError(status, code);
 }
 if (!valid(alertsSchema + dto[operation] + "Response", result)) throw new GatewayError(502, "BAD_REPLY");
 return result as T;
}
/** Читает страницу текущего аккаунта; неизвестные и повторные query-поля запрещены. */
export function listAlerts(userId: string, parameters: URLSearchParams): Promise<AlertPage> {
 const body: Record<string, unknown> = { user_id: userId }, seen = new Set<string>();
 for (const [key, value] of parameters) {
  if (seen.has(key) || !["limit", "cursor"].includes(key)) throw new GatewayError(400, "INVALID_ARGUMENT");
  seen.add(key);
  if (key === "limit") {
   if (!/^[0-9]+$/.test(value)) throw new GatewayError(400, "INVALID_ARGUMENT");
   body.limit = Number(value);
  } else body.cursor = value;
 }
 return alertsRequest<AlertPage>("list", body);
}
/** Получает одну доступную личную или общую запись, не меняя отметку прочтения. */
export const getAlert = (userId: string, serviceId: string, id: string) => alertsRequest<{ notification: AlertNotification }>("get", { user_id: userId, service_id: serviceId, id });
