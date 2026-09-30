// ABOUTME: Ограничивает HTTP вход и преобразует ошибки шлюза в безопасный ответ.
// ABOUTME: Команда не публикуется при неверном origin, размере или JSON.
import { requireTimerSession, checkOrigin } from "./auth";
import { GatewayError, publish } from "./gateway";
/** Возвращает safe JSON error без серверных адресов и секретов. */
export function failure(error: unknown): Response {
 const known = error instanceof GatewayError ? error : new GatewayError(503, "UNAVAILABLE");
 return Response.json({ code: known.code, outcome: known.outcome }, { status: known.status, headers: { "Cache-Control": "no-store" } });
}
/** Читает не более 2048 bytes и публикует только owner-valid DTO. */
export async function postCommand(request: Request, type: "start" | "stop"): Promise<Response> {
 try {
  checkOrigin(request);
  const session = await requireTimerSession(request);
  if (!request.headers.get("content-type")?.startsWith("application/json")) throw new GatewayError(415, "CONTENT_TYPE", "not-published");
  const reader = request.body?.getReader();
  if (!reader) throw new GatewayError(400, "INVALID_ARGUMENT", "not-published");
  const chunks: Uint8Array[] = []; let bytes = 0;
  for (;;) {
   const chunk = await reader.read(); if (chunk.done) break;
   bytes += chunk.value.length;
   if (bytes > 2048) { await reader.cancel(); throw new GatewayError(413, "TOO_LARGE", "not-published"); }
   chunks.push(chunk.value);
  }
  let body: unknown;
  try { body = JSON.parse(Buffer.concat(chunks).toString()); }
  catch { throw new GatewayError(400, "INVALID_ARGUMENT", "not-published"); }
  if (!body || typeof body !== "object" || Array.isArray(body) || "userId" in body) throw new GatewayError(400, "INVALID_ARGUMENT", "not-published");
  await publish(type, { ...body, userId: session.user.id });
  return Response.json({ commandId: (body as { commandId: string }).commandId, status: "queued" }, { status: 202, headers: { "Cache-Control": "no-store" } });
 } catch (error) { return failure(error); }
}
