// ABOUTME: Разветвляет Core NATS signals в ограниченные авторизованные SSE потоки.
// ABOUTME: Подписка предшествует bootstrap; каждый frame и heartbeat заново проверяют сессию.
export const MAX_ALERT_CLIENTS = 128, MAX_ALERT_QUEUE = 64;
/** Не хранит уведомления; сигнал null предназначен всем аккаунтам. */
export class AlertsHub {
 private clients = new Set<{ userId: string; sessionId: string; changed: () => void; close: () => void }>();
 /** Присоединяет bounded клиента; возвращает обязательное освобождение. */
 attach(userId: string, sessionId: string, changed: () => void, close: () => void) {
  if (this.clients.size >= MAX_ALERT_CLIENTS) throw new Error("CLIENT_LIMIT");
  const client = { userId, sessionId, changed, close }; this.clients.add(client);
  return () => { this.clients.delete(client); };
 }
 /** Доставляет только владельцу личного сигнала либо всем для общей записи. */
 broadcast(userId: string | null) { for (const client of this.clients) if (userId === null || client.userId === userId) client.changed(); }
 /** Закрывает все потоки при отзыве данной сессии в текущем процессе. */
 invalidate(sessionId: string) { for (const client of [...this.clients]) if (client.sessionId === sessionId) client.close(); }
 /** Потеря брокера завершает все потоки, требуя браузерной сверки после reconnect. */
 disconnect() { for (const client of [...this.clients]) client.close(); }
}
/** Возвращает signal-only SSE с bounded очередью и закрытием при отказе Auth. */
export function alertsStream(hub: AlertsHub, bootstrap: () => Promise<unknown>, signal: AbortSignal, userId: string, sessionId: string, authorized: () => Promise<boolean>) {
 let stop = () => {}, pump = () => {};
 return new ReadableStream<Uint8Array>({
  start(controller) {
   let closed = false, bootstrapping = true, pumping = false, buffered = 0, checkingHeartbeat = false;
   const queue: string[] = [], encoder = new TextEncoder();
   let detach = () => {};
   const lifecycle: { heartbeat?: ReturnType<typeof setInterval> } = {};
   stop = () => { if (closed) return; closed = true; detach(); clearInterval(lifecycle.heartbeat); signal.removeEventListener("abort", stop); try { controller.close(); } catch { /* Читатель отменил поток. */ } };
   pump = () => {
    if (closed || pumping) return; pumping = true;
    void (async () => {
     try { while (!closed && queue.length && (controller.desiredSize ?? 0) > 0) {
      if (!await authorized()) { stop(); return; } if (closed) return;
      controller.enqueue(encoder.encode(`event: ${queue.shift()}\ndata: null\n\n`));
     } } catch { stop(); }
     finally { pumping = false; if (!closed && queue.length && (controller.desiredSize ?? 0) > 0) pump(); }
    })();
   };
   const push = (event: string) => { if (closed) return; if (queue.length >= MAX_ALERT_QUEUE) { stop(); return; } queue.push(event); pump(); };
   try { detach = hub.attach(userId, sessionId, () => {
    if (bootstrapping) { if (++buffered > MAX_ALERT_QUEUE) stop(); } else push("changed");
   }, stop); } catch { stop(); return; }
   signal.addEventListener("abort", stop, { once: true });
   if (signal.aborted) { stop(); return; }
   void (async () => { try {
    await bootstrap(); if (closed) return; push("ready"); bootstrapping = false;
    while (buffered-- > 0 && !closed) push("changed");
   } catch { stop(); } })();
   lifecycle.heartbeat = setInterval(() => {
    if (closed || bootstrapping || checkingHeartbeat) return;
    checkingHeartbeat = true;
    void (async () => { try { if (!await authorized()) stop(); else push("heartbeat"); }
     catch { stop(); } finally { checkingHeartbeat = false; } })();
   }, 2000);
  }, pull() { pump(); }, cancel() { stop(); },
 }, { highWaterMark: 1 });
}
