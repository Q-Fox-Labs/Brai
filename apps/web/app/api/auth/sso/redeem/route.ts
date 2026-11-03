// ABOUTME: Обменивает одноразовый ticket на cookie сессии preview.
// ABOUTME: Проверяет Origin и verifier до обращения к сервису авторизации.
import { authRequest, authResponse } from "@/server/auth";
import { proofCookie, readProof, secureHeaders, ssoConfig, validVerifier } from "@/server/sso";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Принимает ограниченный ticket только от текущего preview. */
export async function POST(request: Request): Promise<Response> {
 const config = ssoConfig();
 const fail = () => Response.json({ code: "SSO_FAILED" }, { status: 400, headers: secureHeaders });
 if (!config || config.role !== "preview" || request.headers.get("origin") !== config.origin || request.headers.get("content-type") !== "application/json") return fail();
 const lengthHeader = request.headers.get("content-length");
 if (lengthHeader !== null && (!/^\d+$/.test(lengthHeader) || Number(lengthHeader) > 9000)) return fail();
 const verifier = readProof(request.headers.get("cookie"));
 if (!validVerifier(verifier)) return fail();
 try {
  const reader = request.body?.getReader(); if (!reader) return fail();
  const chunks: Uint8Array[] = []; let size = 0;
  for (;;) {
   const { done, value } = await reader.read(); if (done) break;
   size += value.byteLength; if (size > 9000) { await reader.cancel(); return fail(); }
   chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const text = new TextDecoder().decode(bytes);
  const data: unknown = JSON.parse(text);
  if (!data || typeof data !== "object" || Object.keys(data).length !== 1 || !("ticket" in data) || typeof data.ticket !== "string" || !/^[A-Za-z0-9_-]{1,4096}$/.test(data.ticket)) return fail();
  const reply = await authRequest(request, "sso-redeem", { ticket: data.ticket, verifier, targetOrigin: config.origin });
  if (reply.status !== 200 || !reply.setCookies.length) return fail();
  const response = authResponse(reply, { success: true });
  response.headers.set("Referrer-Policy", "no-referrer"); response.headers.append("Set-Cookie", proofCookie("", 0));
  return response;
 } catch { return fail(); }
}
