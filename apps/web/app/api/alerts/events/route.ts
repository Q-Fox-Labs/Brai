// ABOUTME: Открывает личные и общие alerts signals только для действующей сессии.
// ABOUTME: Подписчик подключается до сверки; каждый frame проверяет неизменность сессии.
import { requireSession } from "@/server/auth";
import { requireAlertsSession } from "@/server/alerts-http";
import { alertsRequest } from "@/server/alerts";
import { alertsRuntime } from "@/server/alerts-runtime";
import { alertsStream } from "@/server/alerts-hub";
import { GatewayError } from "@/server/gateway";
import { failure } from "@/server/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Возвращает bounded SSE signals; потеря Auth или брокера прекращает поток. */
export async function GET(request: Request) {
 try {
  const query = new URL(request.url).searchParams;
  if (query.size !== 1 || !query.has("expectedUserId")) throw new GatewayError(400, "INVALID_ARGUMENT");
  const session = await requireAlertsSession(request, true), instance = alertsRuntime();
  await instance.connect();
  const authorized = async () => {
   try { const current = await requireSession(request); return current.user.id === session.user.id && current.session.id === session.session.id; }
   catch { return false; }
  };
  return new Response(alertsStream(instance.hub, () => alertsRequest("summary", { user_id: session.user.id }), request.signal,
   session.user.id, session.session.id, authorized), { headers: {
   "Content-Type": "text/event-stream", "Cache-Control": "no-store, no-transform", "Connection": "keep-alive", "X-Accel-Buffering": "no" } });
 } catch (error) { return failure(error); }
}
