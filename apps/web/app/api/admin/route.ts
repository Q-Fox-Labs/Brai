// ABOUTME: Предоставляет администратору закрытые операции Auth и просмотр данных выбранного пользователя.
// ABOUTME: Проверяет сессию и Origin; не подменяет владельца сессии целевым пользователем.
import { checkOrigin, requireSession, authResponse } from "@/server/auth";
import { GatewayError, natsConnection } from "@/server/gateway";
import { failure } from "@/server/http";
import { adminDownload } from "@/server/admin-download";
import { readBoundedJson } from "@/server/request-body";
import { readAdminPersonal } from "@/server/admin-personal";
import { ssoConfig } from "@/server/sso";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const reads = new Set(["users-list", "users-get", "users-operation-get", "invite-list", "admin-memory-list", "admin-memory-get", "admin-chats-list", "admin-chats-get", "admin-artifacts-list", "admin-artifacts-get", "admin-artifacts-download", "admin-personal-get"]);
const writes = new Set(["users-add", "users-revoke", "role-set", "status-set", "sessions-revoke", "invite-create", "invite-revoke", "admin-chats-pause", "admin-chats-resume"]);
/** Выполняет операцию активного администратора без автоматического повтора. */
async function handle(request: Request) {
 try {
  const session = await requireSession(request);
  if (session.user.role !== "admin" || session.user.status !== "active") throw new GatewayError(403, "FORBIDDEN");
  if (request.method !== "GET") checkOrigin(request);
  const value = request.method === "GET" ? Object.fromEntries(new URL(request.url).searchParams) : await readBoundedJson(request, 4096, 5000);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new GatewayError(400, "INVALID_ARGUMENT");
  const { operation, preview, ...input } = value as Record<string, unknown>;
  if (typeof operation !== "string" || !(request.method === "GET" ? reads : writes).has(operation)) throw new GatewayError(404, "NOT_FOUND");
  if (request.method !== "GET" && input.userId === "__quarantine__") throw new GatewayError(400, "INVALID_ARGUMENT");
  const headers = Object.fromEntries(["cookie", "origin"].flatMap(name => { const item = request.headers.get(name); return item ? [[name, item]] : []; }));
  if (!headers.origin && request.method === "GET") headers.origin = new URL(process.env.WEB_ORIGIN ?? request.url).origin;
  const bridge = operation.startsWith("admin-");
  const sso = bridge ? ssoConfig() : null;
  if (sso?.role === "preview") {
   if (headers.origin !== sso.origin) throw new GatewayError(403, "ORIGIN");
   // AIDEV-NOTE: Общий Control проверяет origin DEV; адрес превью уже проверен Web.
   // Cookie администратора сохраняется для повторной проверки сессии и аудита владельцем.
   headers.origin = sso.hub;
  }
  if (bridge && (typeof input.userId !== "string" || !input.userId)) throw new GatewayError(400, "INVALID_ARGUMENT");
  if (preview !== undefined && (operation !== "admin-artifacts-download" || preview !== "1")) throw new GatewayError(400, "INVALID_ARGUMENT");
  if (bridge && typeof input.limit === "string") {
    if (!/^(?:[1-9][0-9]?|100)$/.test(input.limit)) throw new GatewayError(400, "INVALID_ARGUMENT");
    input.limit = Number(input.limit);
  }
  const nc = await natsConnection();
  if (operation === "admin-personal-get") return Response.json(await readAdminPersonal(nc, headers, input));
  const reply = await nc.request(`${bridge ? "brai.hermes.identity.v1" : "brai.auth.v2"}.${operation}`, Buffer.from(JSON.stringify(bridge ? { ...input, headers } : { headers, body: input })), { timeout: 10000 });
  const serviceError = reply.headers?.get("Nats-Service-Error"), serviceStatus = reply.headers?.get("Nats-Service-Error-Code");
  if (reply.headers?.has("Nats-Service-Error") || reply.headers?.has("Nats-Service-Error-Code")) {
   const codes: Record<string, string> = { "400": "INVALID_ARGUMENT", "401": "UNAUTHORIZED", "403": "FORBIDDEN", "404": "NOT_FOUND", "413": "PAYLOAD_TOO_LARGE", "503": "SOURCE_UNAVAILABLE" };
   const code = serviceStatus && codes[serviceStatus];
   throw new GatewayError(code && serviceError ? Number(serviceStatus) : 503, code && serviceError ? code : "ADMIN_UNAVAILABLE");
  }
  if (operation === "admin-artifacts-download" && reply.data.byteLength > 710000) throw new Error("BAD_REPLY");
  const result = JSON.parse(Buffer.from(reply.data).toString()) as { status: number; body: unknown; setCookies: string[] };
  if (!Number.isInteger(result.status) || result.status < 200 || result.status > 599 || !Array.isArray(result.setCookies) || !result.setCookies.every(item => typeof item === "string" && !/[\r\n]/.test(item))) throw new Error("BAD_REPLY");
  if (operation === "admin-artifacts-download" && result.status === 200) return await adminDownload(result.body, input.artifactId, request.signal, preview === "1", request.headers.get("range"));
  return authResponse(result);
 } catch (error) { return failure(error instanceof GatewayError ? error : new GatewayError(503, "ADMIN_UNAVAILABLE")); }
}
export { handle as GET, handle as POST };
