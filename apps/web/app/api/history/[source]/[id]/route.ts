// ABOUTME: Читает одну запись общей истории по source и UUID.
// ABOUTME: Пользователь берётся из сессии; RLS владельца закрывает чужие и системные строки.
import { requireSession } from "@/server/auth";
import { getHistory } from "@/server/history";
import { GatewayError } from "@/server/gateway";
import { failure } from "@/server/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Возвращает событие либо безопасную ошибку; дополнительные query-поля запрещены. */
export async function GET(request: Request, context: { params: Promise<{ source: string; id: string }> }) {
 try {
  const session = await requireSession(request);
  if (new URL(request.url).search) throw new GatewayError(400, "INVALID_ARGUMENT");
  const { source, id } = await context.params;
  return Response.json(await getHistory(session.user.id, source, id), { headers: { "Cache-Control": "no-store" } });
 } catch (error) { return failure(error); }
}
