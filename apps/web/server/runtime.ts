// ABOUTME: Собирает единый NATS consumer и HTTP/SSE hub процесса Next.js.
// ABOUTME: Нет БД, внутренних импортов сервиса или отдельных процессов шлюза.
import { Hub } from "./hub";
import { eventConsumer, natsConnection, parseEvent } from "./gateway";
const key = Symbol.for("brai.web.runtime.v2");
type Runtime = { hub: Hub; ready: Promise<void> };
const globals = globalThis as typeof globalThis & { [key]?: Runtime };
/** Запускает один consumer для всех маршрутов и переподключает его с bounded delay. */
export function runtime(): Runtime {
 if (globals[key]) return globals[key];
 const hub = new Hub();
 let resolveReady: () => void = () => {};
 const ready = new Promise<void>(resolve => { resolveReady = resolve; });
 globals[key] = { hub, ready };
 void (async () => {
  let watched: Awaited<ReturnType<typeof natsConnection>> | undefined;
  for (;;) {
   try {
    const nc = await natsConnection();
    if (watched !== nc) {
     watched = nc;
     void (async () => { for await (const status of nc.status()) {
      if (status.type === "disconnect" || status.type === "reconnect" || status.type === "error") hub.disconnect();
     } })();
    }
    const consumer = await eventConsumer(nc);
    resolveReady();
    const messages = await consumer.consume({ max_messages: 32, expires: 5000 });
    for await (const message of messages) {
     try { hub.broadcast(parseEvent(message.data)); message.ack(); }
     catch { hub.disconnect(); message.term(); console.error(JSON.stringify({ operation: "web_events", error: "BAD_EVENT" })); }
    }
   } catch (error) {
    hub.disconnect();
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "UNAVAILABLE";
    console.error(JSON.stringify({ operation: "web_events.consume", code: /^[A-Z0-9_]+$/.test(code) ? code : "UNAVAILABLE" }));
   }
   await new Promise(resolve => setTimeout(resolve, 1000));
  }
 })();
 return globals[key];
}
