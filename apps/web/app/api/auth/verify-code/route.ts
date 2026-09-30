// ABOUTME: Передаёт HTTP авторизации отдельному NATS сервису Better Auth.
// ABOUTME: Cookie передаются сервером; JSON входа не раскрывает сессионные токены.
import { authRequest, authResponse, checkOrigin } from "@/server/auth";
import { GatewayError } from "@/server/gateway";
import { failure } from "@/server/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Выполняет одну попытку verify-code; неизвестный исход входа восстанавливают проверкой сессии. */
export async function POST(request: Request) {
 try {
  checkOrigin(request);
  if (!request.headers.get("content-type")?.startsWith("application/json")) throw new GatewayError(415, "CONTENT_TYPE");
  const reader = request.body?.getReader(); if (!reader) throw new GatewayError(400, "INVALID_ARGUMENT");
  const chunks: Uint8Array[] = []; let bytes = 0;
  for (;;) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.length;
   if (bytes > 2048) { await reader.cancel(); throw new GatewayError(413, "TOO_LARGE"); } chunks.push(chunk.value); }
  let body: unknown; try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new GatewayError(400, "INVALID_ARGUMENT"); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new GatewayError(400, "INVALID_ARGUMENT");
  const reply = await authRequest(request, "verify-code", body);
  return authResponse(reply, reply.status < 300 ? { success: true } : reply.body);
 } catch (error) { return failure(error); }
}
