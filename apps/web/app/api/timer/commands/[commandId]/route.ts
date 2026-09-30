// ABOUTME: Проверяет сохранённый результат ожидающей команды.
// ABOUTME: NOT_FOUND означает отсутствие результата, а не отсутствие команды в очереди.
import { requireTimerSession } from "@/server/auth";
import { command } from "@/server/gateway";
import { failure } from "@/server/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Возвращает ledger result либо HTTP 404 NOT_FOUND. */
export async function GET(request: Request, context: { params: Promise<{ commandId: string }> }) {
 try { const session = await requireTimerSession(request); return Response.json(await command(session.user.id, (await context.params).commandId), { headers: { "Cache-Control": "no-store" } }); } catch (error) { return failure(error); }
}
