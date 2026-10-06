// ABOUTME: Проверяет HTTP границу уведомлений и доверенную сессию перед NATS.
// ABOUTME: Мутации принимают пустой JSON; ключ записи задаёт URL, владельца задаёт Auth.
import { checkOrigin, requireSession } from "./auth";
import { GatewayError } from "./gateway";
import { failure } from "./http";
import { alertsRequest, getAlert, listAlerts } from "./alerts";
import { readBoundedJson, RequestBodyFailure } from "./request-body";
type Key = { service: string; id: string };
/** Отклоняет старый клиент аккаунта; ожидаемый ID только ограничивает серверную сессию. */
export async function requireAlertsSession(request: Request, events = false) {
 const session = await requireSession(request);
 const expected = events ? new URL(request.url).searchParams.get("expectedUserId") : request.headers.get("x-brai-user");
 if (!expected || expected !== session.user.id) throw new GatewayError(401, "ACCOUNT_CHANGED", "not-published");
 return session;
}
/** Обрабатывает чтение или явную отметку; переданные браузером user_id и scope запрещены. */
export async function alertsHttp(request: Request, operation: "list" | "get" | "summary" | "read" | "read_all", key?: Key): Promise<Response> {
 try {
  const mutation = operation === "read" || operation === "read_all";
  if (mutation) checkOrigin(request);
  const session = await requireAlertsSession(request), query = new URL(request.url).searchParams;
  if (operation !== "list" && query.size) throw new GatewayError(400, "INVALID_ARGUMENT");
  if (mutation) {
   if (!request.headers.get("content-type")?.startsWith("application/json")) throw new GatewayError(415, "CONTENT_TYPE");
   const body = await readBoundedJson(request, 2048, 10000);
   if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length) throw new GatewayError(400, "INVALID_ARGUMENT");
  }
  const result = operation === "list" ? await listAlerts(session.user.id, query)
   : operation === "get" ? await getAlert(session.user.id, key!.service, key!.id)
   : await alertsRequest(operation, { user_id: session.user.id, ...(key ? { service_id: key.service, id: key.id } : {}) });
  return Response.json(result, { headers: { "Cache-Control": "no-store" } });
 } catch (error) { return failure(error instanceof RequestBodyFailure ? new GatewayError(error.status, error.code) : error); }
}
