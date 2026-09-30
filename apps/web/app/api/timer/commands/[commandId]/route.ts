// ABOUTME: Проверяет сохранённый результат ожидающей команды.
// ABOUTME: NOT_FOUND означает отсутствие результата, а не отсутствие команды в очереди.
import { command } from "@/server/gateway";
import { failure } from "@/server/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Возвращает ledger result либо HTTP 404 NOT_FOUND. */
export async function GET(_request: Request, context: { params: Promise<{ commandId: string }> }) {
 try { return Response.json(await command((await context.params).commandId)); } catch (error) { return failure(error); }
}
