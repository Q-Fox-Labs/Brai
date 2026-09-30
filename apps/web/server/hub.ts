// ABOUTME: Разветвляет один durable event consumer в ограниченные SSE соединения.
// ABOUTME: Подписчик присоединяется до snapshot; переполнение и gap требуют нового снимка.
import type { Snapshot, TimerEvent } from "../lib/types";
export type Frame = { type: "snapshot"; data: Snapshot } | { type: "change"; data: TimerEvent } | { type: "heartbeat"; data: null };
export const MAX_QUEUE = 64;
export const MAX_CLIENTS = 128;
/** Bounded hub не хранит прикладное состояние и не ожидает медленного получателя. */
export class Hub {
 private clients = new Set<{ userId: string; sessionId: string; event: (event: TimerEvent) => void; close: () => void }>();
 private seen = new Set<string>();
 /** Присоединяет клиента до чтения снимка; возвращает обязательное освобождение. */
 attach(userId: string, sessionId: string, event: (event: TimerEvent) => void, close: () => void): () => void {
  if (this.clients.size >= MAX_CLIENTS) throw new Error("CLIENT_LIMIT");
  const client = { userId, sessionId, event, close }; this.clients.add(client);
  return () => { this.clients.delete(client); };
 }
 /** ACK допустим после bounded fan-out; disconnected clients восстановятся по snapshot/ledger. */
 broadcast(event: TimerEvent): void {
  const identity = JSON.stringify([event.userId, event.eventId]);
  if (this.seen.has(identity)) return;
  this.seen.add(identity);
  if (this.seen.size > 1024) this.seen.delete(this.seen.values().next().value!);
  for (const client of this.clients) if (client.userId === event.userId) client.event(event);
 }
 /** Немедленно закрывает все потоки отозванной сессии текущего процесса. */
 invalidate(sessionId: string): void { for (const client of [...this.clients]) if (client.sessionId === sessionId) client.close(); }
 /** Закрывает потоки при потере брокера; браузер синхронизируется заново. */
 disconnect(): void { for (const client of [...this.clients]) client.close(); }
}
/** Создаёт SSE поток с bootstrap buffer, bounded backpressure и освобождением ресурсов. */
export function eventStream(hub: Hub, getSnapshot: () => Promise<Snapshot>, signal: AbortSignal, userId: string, sessionId: string, authorized: () => Promise<boolean>): ReadableStream<Uint8Array> {
 let stop = () => {};
 let pump = () => {};
 const encoder = new TextEncoder();
 return new ReadableStream<Uint8Array>({
  start(controller) {
   let closed = false, bootstrapping = true, version = 0, pumping = false;
   const queue: Frame[] = [];
   const buffered: TimerEvent[] = [];
   let detach = () => {};
   const lifecycle: { heartbeat?: ReturnType<typeof setInterval> } = {};
   stop = () => {
    if (closed) return;
    closed = true; detach(); clearInterval(lifecycle.heartbeat); signal.removeEventListener("abort", stop);
    try { controller.close(); } catch { /* Поток уже отменён читателем. */ }
   };
   pump = () => {
    if (pumping || closed) return;
    pumping = true;
    void (async () => {
     try {
      while (!closed && queue.length && (controller.desiredSize ?? 0) > 0) {
       if (!await authorized()) { stop(); return; }
       if (closed) return;
       const frame = queue.shift()!;
       controller.enqueue(encoder.encode(`event: ${frame.type}\ndata: ${JSON.stringify(frame.data)}\n\n`));
      }
     } catch { stop(); }
     finally { pumping = false; if (!closed && queue.length && (controller.desiredSize ?? 0) > 0) pump(); }
    })();
   };
   const push = (frame: Frame) => {
    if (closed) return;
    if (queue.length >= MAX_QUEUE) { stop(); return; }
    queue.push(frame); pump();
   };
   const apply = (event: TimerEvent) => {
    if ("version" in event) {
     if (event.version > version + 1) { stop(); return; }
     version = Math.max(version, event.version);
    }
    // AIDEV-NOTE: Даже старое событие разрешает pending commandId; rejection не имеет версии.
    push({ type: "change", data: event });
   };
   try {
    detach = hub.attach(userId, sessionId, event => {
     if (closed) return;
     if (bootstrapping) {
      if (buffered.length >= MAX_QUEUE) { stop(); return; }
      buffered.push(event);
     } else apply(event);
    }, stop);
   } catch { stop(); return; }
   signal.addEventListener("abort", stop, { once: true });
   if (signal.aborted) { stop(); return; }
   const sync = async () => {
    if (closed || !bootstrapping) return;
    try {
     const data = await getSnapshot();
     if (closed) return;
     version = data.version; push({ type: "snapshot", data });
     bootstrapping = false;
     for (const event of buffered.splice(0)) apply(event);
    } catch { stop(); }
   };
   void sync();
   lifecycle.heartbeat = setInterval(() => {
    if (closed || bootstrapping) return;
    push({ type: "heartbeat", data: null });
   }, 2000);
  },
  pull() { pump(); },
  cancel() { stop(); },
 }, { highWaterMark: 1 });
}
