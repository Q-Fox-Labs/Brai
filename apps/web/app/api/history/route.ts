// ABOUTME: Возвращает страницу общей истории текущего пользователя.
// ABOUTME: Scope и user_id определяются только проверенной BetterAuth-сессией.
import { requireSession } from "@/server/auth";
import { listHistory } from "@/server/history";
import { failure } from "@/server/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Проверяет текущую сессию перед чтением; ответы и ошибки не кешируются. */
export async function GET(request: Request) {
 try {
  const session = await requireSession(request);
  return Response.json(await listHistory(session.user.id, new URL(request.url).searchParams), { headers: { "Cache-Control": "no-store" } });
 } catch (error) { return failure(error); }
}
