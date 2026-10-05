// ABOUTME: Передаёт пользовательское чтение истории по публичным схемам владельца.
// ABOUTME: Идентичность задаёт серверная сессия; браузер не выбирает scope или NATS subject.
import { valid } from "./contracts";
import { GatewayError, natsConnection } from "./gateway";
const schema = "https://brai.invalid/contracts/history/v1/messages.schema.json#/definitions/";
const requestBytes = 64 * 1024, responseBytes = 512 * 1024;
const filters = new Set(["source", "category_id", "type_id", "actor_id", "object_type", "object_id", "occurred_from", "occurred_to"]);
const errorStatuses: Record<string, number> = {
 INVALID_ARGUMENT: 400, INVALID_CURSOR: 400, NOT_FOUND: 404, EVENT_ID_CONFLICT: 409,
 REQUEST_TOO_LARGE: 413, RESULT_TOO_LARGE: 413, BUSY: 503, DATABASE_UNAVAILABLE: 503,
 DEADLINE_EXCEEDED: 504, INTERNAL: 500,
};
async function query(name: "list" | "get", body: object): Promise<unknown> {
 if (!valid(schema + name + "Request", body)) throw new GatewayError(400, "INVALID_ARGUMENT");
 const data = Buffer.from(JSON.stringify(body));
 if (data.byteLength > requestBytes) throw new GatewayError(413, "REQUEST_TOO_LARGE");
 let reply;
 try {
  const nc = await natsConnection();
  if (nc.isClosed() || nc.isDraining()) throw new GatewayError(503, "UNAVAILABLE");
  reply = await nc.request(`brai.history.v1.query.${name}`, data, { timeout: 10000 });
 } catch (error) {
  if (error instanceof GatewayError) throw error;
  throw new GatewayError((error as { code?: string })?.code === "TIMEOUT" ? 504 : 503,
   (error as { code?: string })?.code === "TIMEOUT" ? "DEADLINE_EXCEEDED" : "UNAVAILABLE");
 }
 if (reply.data.byteLength > responseBytes) throw new GatewayError(502, "BAD_REPLY");
 const hasError = reply.headers?.has("Nats-Service-Error") || reply.headers?.has("Nats-Service-Error-Code");
 let value: unknown;
 try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(reply.data)); }
 catch { throw new GatewayError(502, "BAD_REPLY"); }
 if (hasError) {
  if (!valid(schema + "serviceError", value)) throw new GatewayError(502, "BAD_REPLY");
  const code = (value as { code: string }).code, status = errorStatuses[code];
  if (reply.headers?.get("Nats-Service-Error") !== code || reply.headers?.get("Nats-Service-Error-Code") !== String(status)) throw new GatewayError(502, "BAD_REPLY");
  // AIDEV-NOTE: Сообщение владельца не публикуется: оно может содержать детали внешнего отказа.
  throw new GatewayError(status, code);
 }
 if (!valid(schema + name + "Response", value)) throw new GatewayError(502, "BAD_REPLY");
 return value;
}
/** Читает одну страницу текущего пользователя; неизвестные и повторные query-поля запрещены. */
export async function listHistory(userId: string, parameters: URLSearchParams): Promise<unknown> {
 const body: Record<string, unknown> = { user_id: userId };
 const selected: Record<string, unknown> = {}, seen = new Set<string>();
 for (const [key, value] of parameters) {
  if (seen.has(key) || (!filters.has(key) && key !== "limit" && key !== "cursor")) throw new GatewayError(400, "INVALID_ARGUMENT");
  seen.add(key);
  let parsed: string | number = value;
  if (["category_id", "type_id", "limit"].includes(key)) {
   if (!/^[0-9]+$/.test(value)) throw new GatewayError(400, "INVALID_ARGUMENT");
   parsed = Number(value);
  }
  if (filters.has(key)) selected[key] = parsed; else body[key] = parsed;
 }
 if (Object.keys(selected).length) body.filters = selected;
 return query("list", body);
}
/** Получает событие по двум частям ключа; чужая строка остаётся NOT_FOUND владельца. */
export async function getHistory(userId: string, source: string, id: string): Promise<unknown> {
 return query("get", { user_id: userId, source, id });
}
