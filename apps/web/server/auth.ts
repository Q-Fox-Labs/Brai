// ABOUTME: Проверяет сессию Better Auth через NATS и передаёт cookie без раскрытия токена браузеру.
// ABOUTME: Ошибки сервиса закрывают доступ; мутации требуют канонического Origin.
import { isIP } from "node:net";
import { valid } from "./contracts";
import { GatewayError, natsConnection } from "./gateway";
export type Session = { session: { id: string; userId: string; expiresAt: string }; user: { id: string; email: string } };
type AuthReply = { status: number; body: unknown; setCookies: string[] };
/** Проверяет Origin до мутации; TLS-прокси передаёт явный WEB_ORIGIN. */
export function checkOrigin(request: Request): void {
 const expected = process.env.WEB_ORIGIN ? new URL(process.env.WEB_ORIGIN).origin : new URL(request.url).origin;
 if (request.headers.get("origin") !== expected) throw new GatewayError(403, "ORIGIN", "not-published");
}
/** Один request-reply без автоматического повтора отправки письма или входа. */
export async function authRequest(request: Request, operation: "send-code" | "verify-code" | "session" | "sign-out", body: object = {}): Promise<AuthReply> {
 const headers: Record<string, string> = {};
 for (const name of ["cookie", "origin", "user-agent", "sec-fetch-site"]) {
  const value = request.headers.get(name); if (value) headers[name] = value;
 }
 // AIDEV-NOTE: Включать лишь при закрытом ingress за прокси, который заменяет недоверенный XFF.
 if (process.env.WEB_TRUST_PROXY === "true") {
  const address = request.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim();
  if (address && isIP(address)) headers["x-forwarded-for"] = address;
 }
 const payload = { headers, body };
 const dto = { "send-code": "SendCodeRequest", "verify-code": "VerifyCodeRequest", session: "SessionRequest", "sign-out": "SignOutRequest" }[operation];
 if (!valid(`auth-messages.schema.json#/definitions/${dto}`, payload)) throw new GatewayError(400, "INVALID_ARGUMENT", "not-published");
 try {
  const nc = await natsConnection();
  const reply = await nc.request(`brai.auth.v1.${operation}`, Buffer.from(JSON.stringify(payload)), { timeout: 10000 });
  if (reply.headers?.has("Nats-Service-Error") || reply.headers?.has("Nats-Service-Error-Code")) throw new GatewayError(503, "AUTH_UNAVAILABLE", "not-published");
  const result: unknown = JSON.parse(Buffer.from(reply.data).toString());
  if (!valid("auth-messages.schema.json#/definitions/Response", result)) throw new Error("BAD_REPLY");
  if (!result || typeof result !== "object" || !("status" in result) || !("body" in result) || !("setCookies" in result)) throw new Error("BAD_REPLY");
  const data = result as AuthReply;
  if (!Number.isInteger(data.status) || data.status < 200 || data.status > 599 || !Array.isArray(data.setCookies) || !data.setCookies.every(item => typeof item === "string" && !/[\r\n]/.test(item))) throw new Error("BAD_REPLY");
  return data;
 } catch (error) {
  if (error instanceof GatewayError) throw error;
  throw new GatewayError(503, operation === "verify-code" ? "AUTH_OUTCOME_UNKNOWN" : "AUTH_UNAVAILABLE", "not-published");
 }
}
/** Возвращает проверенную текущую сессию; отсутствие или сбой запрещают доступ. */
export async function requireSession(request: Request): Promise<Session> {
 const reply = await authRequest(request, "session");
 const value = reply.body as Session | null;
 if (reply.status !== 200 || !value?.user?.id || !value.session?.id || value.session.userId !== value.user.id || !(Date.parse(value.session.expiresAt) > Date.now())) throw new GatewayError(401, "UNAUTHORIZED", "not-published");
 return value;
}
/** Проксирует JSON auth с отдельной обработкой всех Set-Cookie; не возвращает сессионный token. */
export function authResponse(reply: AuthReply, body: unknown = reply.body): Response {
 const headers = new Headers({ "Cache-Control": "no-store" });
 for (const cookie of reply.setCookies) headers.append("Set-Cookie", cookie);
 return Response.json(body, { status: reply.status, headers });
}

/** Проверяет привязку клиентского документа к проверенному аккаунту; header не даёт полномочий. */
export async function requireTimerSession(request: Request, eventStream = false): Promise<Session> {
 const session = await requireSession(request);
 const expected = eventStream ? new URL(request.url).searchParams.get("expectedUserId") : request.headers.get("x-brai-user");
 if (!expected || expected !== session.user.id) throw new GatewayError(401, "ACCOUNT_CHANGED", "not-published");
 return session;
}
