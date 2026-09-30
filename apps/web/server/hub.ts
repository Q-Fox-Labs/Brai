// ABOUTME: Разветвляет один durable event consumer в ограниченные SSE соединения.
// ABOUTME: Подписчик присоединяется до snapshot; переполнение и gap требуют нового снимка.
import type { Snapshot, TimerEvent } from "../lib/types";
export type Frame = { type: "snapshot"; data: Snapshot } | { type: "change"; data: TimerEvent } | { type: "heartbeat"; data: null };
export const MAX_QUEUE = 64;
export const MAX_CLIENTS = 128;
/** Bounded hub не хранит прикладное состояние и не ожидает медленного получателя. */
export class Hub {
 private clients = new Set<{ event: (event: TimerEvent) => void; close: () => void }>();
 private seen = new Set<string>();
 /** Присоединяет клиента до чтения снимка; возвращает обязательное освобождение. */
 attach(event: (event: TimerEvent) => void, close: () => void): () => void {
  if (this.clients.size >= MAX_CLIENTS) throw new Error("CLIENT_LIMIT");
  const client = { event, close }; this.clients.add(client);
  return () => { this.clients.delete(client); };
 }
 /** ACK допустим после bounded fan-out; disconnected clients восстановятся по snapshot/ledger. */
 broadcast(event: TimerEvent): void {
  if (this.seen.has(event.eventId)) return;
  this.seen.add(event.eventId);
  if (this.seen.size > 1024) this.seen.delete(this.seen.values().next().value!);
  for (const client of this.clients) client.event(event);
 }
 /** Закрывает потоки при потере брокера; браузер синхронизируется заново. */
 disconnect(): void { for (const client of [...this.clients]) client.close(); }
}
/** Создаёт SSE поток с bootstrap buffer, bounded backpressure и освобождением ресурсов. */
export function eventStream(hub: Hub, getSnapshot: () => Promise<Snapshot>, signal: AbortSignal): ReadableStream<Uint8Array> {
 let stop = () => {};
 let pump = () => {};
 const encoder = new TextEncoder();
 return new ReadableStream<Uint8Array>({
  start(controller) {
   let closed = false, bootstrapping = true, version = 0;
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
    while (!closed && queue.length && (controller.desiredSize ?? 0) > 0) {
     const frame = queue.shift()!;
     controller.enqueue(encoder.encode(`event: ${frame.type}\ndata: ${JSON.stringify(frame.data)}\n\n`));
    }
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
    detach = hub.attach(event => {
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
   }, 15000);
  },
  pull() { pump(); },
  cancel() { stop(); },
 }, { highWaterMark: 1 });
}
