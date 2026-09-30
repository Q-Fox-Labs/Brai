// ABOUTME: Возвращает согласованный снимок владельца состояния таймера.
// ABOUTME: Ответ не кешируется и не читает БД напрямую.
import { requireTimerSession } from "@/server/auth";
import { snapshot } from "@/server/gateway";
import { failure } from "@/server/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Запрашивает snapshot NATS Services. */
export async function GET(request: Request) { try { const session = await requireTimerSession(request); return Response.json(await snapshot(session.user.id), { headers: { "Cache-Control": "no-store" } }); } catch (error) { return failure(error); } }
