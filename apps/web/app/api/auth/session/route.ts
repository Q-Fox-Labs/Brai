// ABOUTME: Передаёт HTTP авторизации отдельному NATS сервису Better Auth.
// ABOUTME: Cookie передаются сервером; JSON входа не раскрывает сессионные токены.
import { requireSession } from "@/server/auth";
import { publicUser } from "@/server/account-session";
import { failure } from "@/server/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Возвращает публичные данные аккаунта; сессионный токен не покидает сервер. */
export async function GET(request: Request) {
 try { const session = await requireSession(request); return Response.json({ user: publicUser(session.user) }, { headers: { "Cache-Control": "no-store" } }); }
 catch (error) { return failure(error); }
}
