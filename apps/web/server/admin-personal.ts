// ABOUTME: Даёт администратору чтение личных сервисов выбранного аккаунта с аудитом.
// ABOUTME: Область выводится из ответа Auth; браузер передаёт только аккаунт и вид данных.
import type { NatsConnection } from "nats";
import { serviceDataScope } from "../../../services/auth/contracts/service-data-scope.mjs";
import { GatewayError, history as timerHistory, snapshot as timerSnapshot } from "./gateway";
import { listHistory } from "./history";
import { listAlerts } from "./alerts";
import { goalsRequest } from "./goals";

const titles = { history: "История", timer: "Таймер", alerts: "Уведомления", goals: "Цели" } as const;
type Kind = keyof typeof titles;
type Headers = Record<string, string>;
function object(value: unknown): value is Record<string, unknown> {
 return !!value && typeof value === "object" && !Array.isArray(value);
}
/** Повторная проверка Auth и аудит завершаются до обращения к личным данным. */
export async function readAdminPersonal(nc: NatsConnection, headers: Headers, input: Record<string, unknown>) {
 if (Object.keys(input).some(key => !["userId", "service", "cursor"].includes(key)) ||
     typeof input.userId !== "string" || !input.userId || input.userId === "__quarantine__" ||
     typeof input.service !== "string" || !Object.hasOwn(titles, input.service) ||
     input.cursor !== undefined && (typeof input.cursor !== "string" || input.cursor.length > 2048))
  throw new GatewayError(400, "INVALID_ARGUMENT");
 const userId = input.userId, service = input.service as Kind;
 async function auth(operation: "users-get" | "admin-audit", body: object) {
  const reply = await nc.request("brai.auth.v2." + operation, Buffer.from(JSON.stringify({ headers, body })), { timeout: 10000 });
  if (reply.data.byteLength > 65536) throw new GatewayError(503, "AUTH_UNAVAILABLE");
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(reply.data)); }
  catch { throw new GatewayError(503, "AUTH_UNAVAILABLE"); }
  if (!object(value) || !Number.isInteger(value.status)) throw new GatewayError(503, "AUTH_UNAVAILABLE");
  if (value.status !== 200) throw new GatewayError(value.status === 403 ? 403 : value.status === 404 ? 404 : 503,
   value.status === 403 ? "FORBIDDEN" : value.status === 404 ? "NOT_FOUND" : "AUTH_UNAVAILABLE");
  return value.body;
 }
 const target = await auth("users-get", { userId });
 if (!object(target) || !object(target.user) || target.user.id !== userId || typeof target.user.profileId !== "string")
  throw new GatewayError(404, "PROFILE_NOT_READY");
 const owner = serviceDataScope(target.user.profileId);
 await auth("admin-audit", { userId, action: "personal.read" });
 const parameters = new URLSearchParams({ limit: "50", ...(input.cursor ? { cursor: input.cursor as string } : {}) });
 let data: unknown;
 if (service === "history") data = await listHistory(owner, parameters);
 else if (service === "alerts") data = await listAlerts(owner, parameters);
 else if (service === "timer") {
  const [page, current] = await Promise.all([timerHistory(owner, 50, input.cursor as string ?? null), timerSnapshot(owner)]);
  data = { ...page, current };
 }
 else {
  if (input.cursor) throw new GatewayError(400, "INVALID_ARGUMENT");
  data = await goalsRequest(owner, "goals_overview", {});
 }
 const cursor = object(data) ? data.next_cursor ?? data.nextCursor ?? null : null;
 return { service, title: titles[service], data, nextCursor: typeof cursor === "string" ? cursor : null };
}
