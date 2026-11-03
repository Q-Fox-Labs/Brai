// ABOUTME: Выдаёт одноразовый SSO ticket после проверки DEV сессии.
// ABOUTME: Допускает только настроенный preview и не передаёт ticket в query.
import { authRequest, requireSession } from "@/server/auth";
import { GatewayError } from "@/server/gateway";
import { continuation, secureHeaders, ssoConfig } from "@/server/sso";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Проверяет сессию hub и отправляет ticket в fragment preview. */
export async function GET(request: Request): Promise<Response> {
 const config = ssoConfig(), params = new URL(request.url).searchParams;
 const next = continuation(params, config);
 if (!config || !next) return new Response("Переход недоступен", { status: 400, headers: secureHeaders });
 try {
  await requireSession(request);
  const headers = new Headers();
  for (const name of ["cookie", "user-agent"]) { const value = request.headers.get(name); if (value) headers.set(name, value); }
  headers.set("origin", config.origin); headers.set("sec-fetch-site", "same-origin");
  const internal = new Request(`${config.origin}/api/auth/sso/authorize`, { headers });
  const result = await authRequest(internal, "sso-issue", { targetOrigin: params.get("targetOrigin"), challenge: params.get("challenge") });
  const body = result.body as { ticket?: unknown } | null;
  if (result.status !== 200 || typeof body?.ticket !== "string" || !/^[A-Za-z0-9_-]{1,4096}$/.test(body.ticket)) throw new Error("ISSUE_FAILED");
  const target = new URL("/auth/sso/callback", params.get("targetOrigin")!);
  target.hash = new URLSearchParams({ ticket: body.ticket }).toString();
  return new Response(null, { status: 302, headers: { ...secureHeaders, Location: target.toString() } });
 } catch (error) {
  if (error instanceof GatewayError && error.status === 401) return new Response(null, { status: 302, headers: { ...secureHeaders, Location: `/auth?${new URLSearchParams({ targetOrigin: params.get("targetOrigin")!, challenge: params.get("challenge")! })}` } });
  return new Response("Не удалось продолжить вход. Вернитесь в preview и начните заново.", { status: 503, headers: secureHeaders });
 }
}
