// ABOUTME: Подключает браузер к одному bounded hub и свежему снимку.
// ABOUTME: Durable consumer общ для процесса; Last-Event-ID не заменяет синхронизацию.
import { snapshot } from "@/server/gateway";
import { eventStream } from "@/server/hub";
import { runtime as webRuntime } from "@/server/runtime";
import { failure } from "@/server/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Подключает поток после готовности consumer, до получения snapshot. */
export async function GET(request: Request) {
 const instance = webRuntime();
 try {
  await Promise.race([instance.ready, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("UNAVAILABLE")), 3000))]);
  return new Response(eventStream(instance.hub, snapshot, request.signal), { headers: {
   "Content-Type": "text/event-stream", "Cache-Control": "no-store, no-transform", "Connection": "keep-alive", "X-Accel-Buffering": "no" } });
 } catch (error) { return failure(error); }
}
