// ABOUTME: Возвращает полную дневную статистику владельца timer.
// ABOUTME: Запрос использует проверенную сессию и не суммирует браузерные страницы.
import { personalDataScope, requireTimerSession } from "@/server/auth";
import { statistics } from "@/server/gateway";
import { failure } from "@/server/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Читает statistics через NATS Services без кеширования. */
export async function GET(request: Request) {
 try {
  const session = await requireTimerSession(request);
  return Response.json(await statistics(personalDataScope(session)), { headers: { "Cache-Control": "no-store" } });
 } catch (error) { return failure(error); }
}
