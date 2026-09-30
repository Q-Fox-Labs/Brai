// ABOUTME: Восстанавливает SSE и pending команду через браузерные HTTP порты.
// ABOUTME: Повтор сохраняет исходный body/ID; ожидание ledger не имеет таймаута отмены.
import type { History, Pending, Snapshot, TimerEvent } from "./types";
import { applyEvent, applySnapshot, initialView, isPending, mergeIntervals, type View } from "./model.ts";
export const PENDING_KEY = "brai.timer.pending.v1";
export type ClientPorts = {
 now: () => number; id: () => string; storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
 fetch: (path: string, options?: RequestInit) => Promise<Response>;
 stream: (snapshot: (data: Snapshot) => void, event: (data: TimerEvent) => void, lost: () => void) => () => void;
};
/** Собирает lifecycle браузера; stop освобождает stream, poll и подписчиков. */
export function createClient(ports: ClientPorts) {
 let view = initialView(), disposed = false, close = () => {}, busy = false, queued = false, ambiguous = false;
 let polling: ReturnType<typeof setInterval> | undefined;
 let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
 let generation = 0;
 const listeners = new Set<(view: View) => void>();
 const seen = new Set<string>();
 const sending = new Set<string>();
 const update = (next: View) => { if (!disposed) { view = next; for (const listener of listeners) listener(view); } };
 const persist = (pending: Pending | null) => {
  try { if (pending) ports.storage.setItem(PENDING_KEY, JSON.stringify(pending)); else ports.storage.removeItem(PENDING_KEY); return true; }
  catch { update({ ...view, message: "Не удалось сохранить команду в этой вкладке. Проверьте настройки хранилища браузера." }); return false; }
 };
 const onEvent = (event: TimerEvent) => {
  if (disposed || seen.has(event.eventId)) return;
  seen.add(event.eventId); if (seen.size > 512) seen.delete(seen.values().next().value!);
  const next = applyEvent(view, event);
  if (view.pending && !next.pending) { persist(null); queued = false; ambiguous = false; }
  update(next);
  if (!next.connected) reconnect();
 };
 const connect = () => {
  if (disposed) return;
  close(); update({ ...view, connected: false });
  const current = ++generation;
  close = ports.stream(data => {
   if (disposed || generation !== current) return;
   update(applySnapshot(view, data, ports.now())); void recover();
  }, event => { if (!disposed && generation === current) onEvent(event); }, () => { if (!disposed && generation === current) { generation++; close(); update({ ...view, connected: false }); scheduleReconnect(); } });
 };
 const scheduleReconnect = () => {
  if (!reconnectTimer) reconnectTimer = setTimeout(() => { reconnectTimer = undefined; connect(); }, 1000);
 };
 const reconnect = () => { generation++; close(); update({ ...view, connected: false }); scheduleReconnect(); };
 const send = async (pending: Pending) => {
  if (sending.has(pending.commandId)) return;
  sending.add(pending.commandId);
  const { type, ...body } = pending;
  try {
   const response = await ports.fetch(`/api/timer/${type}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
   // AIDEV-NOTE: SSE мог уже завершить команду; поздний 202 не возвращает её в pending.
   if (disposed || view.pending?.commandId !== pending.commandId) return;
   if (response.status === 202) {
    queued = true; update({ ...view, message: "Команда в очереди. Ожидаем обработки…" });
   } else {
    const failure = await response.json() as { outcome?: string };
    if (disposed || view.pending?.commandId !== pending.commandId) return;
    if (failure.outcome === "not-published" && !ambiguous && !queued) {
     persist(null); update({ ...view, pending: null, message: "Команда не отправлена. Проверьте соединение и повторите действие." });
    } else {
     if (failure.outcome !== "not-published") ambiguous = true;
     update({ ...view, message: "Проверяем результат отправки…" });
    }
   }
  } catch { if (!disposed && view.pending?.commandId === pending.commandId) { ambiguous = true; update({ ...view, message: "Проверяем результат отправки…" }); } }
  finally { sending.delete(pending.commandId); }
 };
 const recover = async () => {
  if (disposed || busy || !view.pending || sending.has(view.pending.commandId)) return;
  const pending = view.pending; busy = true;
  try {
   const response = await ports.fetch(`/api/timer/commands/${pending.commandId}`, { cache: "no-store", signal: AbortSignal.timeout(5000) });
   if (disposed || view.pending?.commandId !== pending.commandId) return;
   if (response.ok) onEvent((await response.json()).result as TimerEvent);
   else if (response.status === 404 && view.connected && !queued) await send(pending);
  } catch { /* Pending сохраняется до окончательного ledger/SSE результата. */ }
  finally { busy = false; }
 };
 return {
  /** Возвращает последнее состояние. */
  getView: () => view,
  /** Подписывает UI на подтверждённые изменения. */
  subscribe(listener: (view: View) => void) { listeners.add(listener); listener(view); return () => { listeners.delete(listener); }; },
  /** Восстанавливает pending целиком и подключает SSE раньше любого state snapshot. */
  start() {
   try { const raw = ports.storage.getItem(PENDING_KEY); if (raw) { const pending: unknown = JSON.parse(raw);
    if (isPending(pending)) { ambiguous = true; update({ ...view, pending, message: "Проверяем ранее отправленную команду…" }); }
    else update({ ...view, message: "Сохранённая команда повреждена. Обновите хранилище вкладки." });
   } } catch { update({ ...view, message: "Хранилище вкладки недоступно." }); }
   connect(); polling = setInterval(() => { void recover(); }, 2000);
  },
  /** Блокирует новые команды до свежего снимка и сохраняет ID до первого POST. */
  command() {
   if (!view.connected || view.pending || disposed) return;
   const pending: Pending = { commandId: ports.id(), type: view.active ? "stop" : "start", expectedVersion: view.version,
    ...(view.active ? { timerId: view.active.timerId } : {}) };
   if (!persist(pending)) return;
   queued = false; ambiguous = false; update({ ...view, pending, message: "Отправляем команду…" }); void send(pending);
  },
  /** Загружает устойчивую следующую страницу без замены live истории. */
  async loadHistory() {
   if (!view.cursor || view.loading || !view.connected) return;
   const cursor = view.cursor; update({ ...view, loading: true });
   try {
    const response = await ports.fetch(`/api/timer/history?cursor=${encodeURIComponent(cursor)}`, { cache: "no-store", signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error("HISTORY");
    const data = await response.json() as History;
    update({ ...view, items: mergeIntervals(view.items, data.items), cursor: data.nextCursor, paged: true, loading: false });
   } catch { update({ ...view, loading: false, message: "Не удалось загрузить историю. Повторите загрузку." }); }
  },
  /** После visibility/resume обязательно обновляет serverTime anchor. */
  resync: reconnect,
  /** Останавливает I/O; уже сохранённую pending команду оставляет для reload. */
  stop() { disposed = true; generation++; close(); clearInterval(polling); clearTimeout(reconnectTimer); listeners.clear(); },
 };
}
