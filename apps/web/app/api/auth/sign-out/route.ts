// ABOUTME: Передаёт HTTP авторизации отдельному NATS сервису Better Auth.
// ABOUTME: Cookie передаются сервером; JSON входа не раскрывает сессионные токены.
import { authRequest, authResponse, checkOrigin, requireSession } from "@/server/auth";
import { failure } from "@/server/http";
import { runtime as webRuntime } from "@/server/runtime";
import { invalidateAgentSession } from "@/server/agent-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Отзывает сессию, закрывает SSE и удаляет cookie только при подтверждённом выходе. */
export async function POST(request: Request) {
 try {
  checkOrigin(request); const session = await requireSession(request);
  const reply = await authRequest(request, "sign-out");
  if (reply.status >= 200 && reply.status < 300) {
   webRuntime().hub.invalidate(session.session.id);
   invalidateAgentSession(session.session.id);
  }
  return authResponse(reply, reply.status < 300 ? { success: true } : { code: "SIGN_OUT_FAILED" });
 } catch (error) { return failure(error); }
}
