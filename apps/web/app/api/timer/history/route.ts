// ABOUTME: Возвращает следующую страницу завершённых интервалов.
// ABOUTME: Курсор непрозрачен для web; limit проверяется схемой владельца.
import { history } from "@/server/gateway";
import { failure } from "@/server/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Передаёт курсор без перекодирования сервису. */
export async function GET(request: Request) {
 try { const params = new URL(request.url).searchParams;
  return Response.json(await history(params.has("limit") ? Number(params.get("limit")) : 50, params.get("cursor")));
 } catch (error) { return failure(error); }
}
