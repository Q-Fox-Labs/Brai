// ABOUTME: Начинает DEV SSO на preview и связывает переход с браузером.
// ABOUTME: Секрет verifier остаётся только в host-only HttpOnly cookie.
import { newProof, proofCookie, secureHeaders, ssoConfig } from "@/server/sso";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Создаёт challenge и отправляет браузер на фиксированный адрес DEV. */
export function GET(): Response {
 const config = ssoConfig();
 if (!config || config.role !== "preview") return new Response("SSO недоступен", { status: 404, headers: secureHeaders });
 const { verifier, challenge } = newProof();
 const url = new URL("/api/auth/sso/authorize", config.hub);
 url.search = new URLSearchParams({ targetOrigin: config.origin, challenge }).toString();
 return new Response(null, { status: 302, headers: { ...secureHeaders, Location: url.toString(), "Set-Cookie": proofCookie(verifier, 600) } });
}
