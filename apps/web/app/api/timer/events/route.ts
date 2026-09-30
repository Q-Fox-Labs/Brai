// ABOUTME: Открывает личный поток только после проверки текущей сессии.
// ABOUTME: Каждая выдача и heartbeat повторно проверяют сессию; чужие события отсекает hub.
import { snapshot } from "@/server/gateway";
import { requireSession, requireTimerSession } from "@/server/auth";
import { eventStream } from "@/server/hub";
import { runtime as webRuntime } from "@/server/runtime";
import { failure } from "@/server/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Присоединяет личного подписчика до snapshot; отзыв прекращает выдачу данных. */
export async function GET(request: Request) {
 try {
  const session = await requireTimerSession(request, true);
  const instance = webRuntime();
  await Promise.race([instance.ready, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("UNAVAILABLE")), 3000))]);
  const authorized = async () => {
   try { const current = await requireSession(request); return current.session.id === session.session.id && current.user.id === session.user.id; }
   catch { return false; }
  };
  return new Response(eventStream(instance.hub, () => snapshot(session.user.id), request.signal, session.user.id, session.session.id, authorized), { headers: {
   "Content-Type": "text/event-stream", "Cache-Control": "no-store, no-transform", "Connection": "keep-alive", "X-Accel-Buffering": "no" } });
 } catch (error) { return failure(error); }
}
