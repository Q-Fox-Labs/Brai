// ABOUTME: Возвращает карту Элементов после проверки сессии пользователя.
// ABOUTME: HTTP-клиент не задаёт NATS subject или владельца данных.
import { requireSession } from "@/server/auth";
import { loadGameCoreBoard } from "@/server/game-core";
import { GatewayError } from "@/server/gateway";
import { failure } from "@/server/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Читает граф из GameCore и исключает кеширование персонального ответа. */
export async function GET(request: Request) {
 try {
  const session = await requireSession(request);
  if (new URL(request.url).search) throw new GatewayError(400, "INVALID_ARGUMENT");
  return Response.json(await loadGameCoreBoard(session.user.id), { headers: { "Cache-Control": "no-store" } });
 } catch (error) { return failure(error); }
}
