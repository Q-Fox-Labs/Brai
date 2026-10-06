// ABOUTME: Держит локальный секундомер отдельно от подтверждённой личной истории.
// ABOUTME: Ограниченный FIFO сохраняет неизменные намерения до окончательного owner-результата.
import type { Active, History, Pending, Snapshot, Statistics, TimerEvent } from "./types";
import { applyEvent, applySnapshot, duration, initialView, isIntentTimestamp, isPending, mergeIntervals, rejectionMessage, sumCompleted, type View } from "./model.ts";
export const OUTBOX_KEY = "brai.timer.outbox.v2";
export const OUTBOX_LIMIT = 512;
type Entry = { command: Pending; accepted: boolean; uncertain: boolean };
type Stored = { entries: Entry[]; local: Active | null; elapsed: number; savedAt: number; hold: boolean; barrier: number; localCommandId: string | null };
export type ClientPorts = {
 now: () => number; wall?: () => number; id: () => string; storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
 fetch: (path: string, options?: RequestInit) => Promise<Response>;
 stream: (snapshot: (data: Snapshot) => void, event: (data: TimerEvent) => void, lost: () => void) => () => void;
};
/** Собирает браузерные I/O; локальные START/STOP доступны при любом состоянии связи. */
export function createClient(ports: ClientPorts, userId: string) {
 if (!userId) throw new Error("USER_REQUIRED");
 const accountFetch = (path: string, options: RequestInit = {}) => {
  const headers = new Headers(options.headers); headers.set("X-Brai-User", userId);
  return ports.fetch(path, { ...options, headers });
 };
 const storageKey = `${OUTBOX_KEY}:${encodeURIComponent(userId)}`;
 let view = initialView(), entries: Entry[] = [], disposed = false, close = () => {}, publishing = false, lookingUp = false;
 let hold = false, barrier = 0, pollIndex = 0, generation = 0, historyEpoch = 0, statisticsRequest = 0, localCommandId: string | null = null, storageBlocked = false, fillingHistory = false;
 let polling: ReturnType<typeof setInterval> | undefined, reconnectTimer: ReturnType<typeof setTimeout> | undefined;
 const lifetime = new AbortController();
 const wall = ports.wall ?? Date.now;
 // AIDEV-NOTE: Wall-clock нужен только для первоначального anchor и восстановления между документами.
 const initialEpoch = wall(), initialMono = ports.now();
 const listeners = new Set<(view: View) => void>();
 const update = (next: View) => { if (!disposed) { view = { ...next, queued: entries.length }; for (const listener of listeners) listener(view); } };
 const signal = () => AbortSignal.any([lifetime.signal, AbortSignal.timeout(5000)]);
 const persist = () => {
  if (storageBlocked) return false;
  try {
   const data: Stored = { entries, local: view.local, elapsed: duration(view, ports.now()), savedAt: wall(), hold, barrier, localCommandId };
   ports.storage.setItem(storageKey, JSON.stringify(data)); return true;
  } catch { update({ ...view, message: "Не удалось сохранить действия в этой вкладке. Не закрывайте её до сохранения истории." }); return false; }
 };
 const followOwner = () => {
  if (entries.length || hold || view.version < barrier || !view.connected) return;
  update({ ...view, local: view.active, localElapsed: view.active ? Math.max(0, view.anchorServer + ports.now() - view.anchorMono - Date.parse(view.active.startedAt)) : 0, localMono: ports.now() });
 };
 const invalidateHistory = () => {
  historyEpoch++;
  update({ ...view, items: [], cursor: null, paged: false, loading: false, totalCompletedMs: null, totalFromHistory: false });
 };
 const mutationEvent = (event: TimerEvent) => !("error" in event) && "operation" in event && (event.operation === "edit" || event.operation === "delete");
 const onEvent = (event: TimerEvent) => {
  if (disposed) return;
  const previousVersion = view.version, historyMutation = mutationEvent(event);
  const index = entries.findIndex(item => item.command.commandId === event.commandId);
  view = applyEvent(view, event);
  const successfulTransition = !("error" in event) && "version" in event && event.version > previousVersion;
  if (index >= 0) {
   entries.splice(index, 1);
   if ("error" in event) { if (event.commandId === localCommandId) hold = true; view = { ...view, message: rejectionMessage(event.error.code) }; }
   else { barrier = Math.max(barrier, event.version); if (event.commandId === localCommandId) { hold = false; view = { ...view, message: "" }; } }
   persist();
  }
  if (historyMutation && successfulTransition) {
   invalidateHistory();
   void loadStatistics();
   reconnect();
   return;
  }
  update(view); followOwner();
  if (!view.connected) reconnect();
  else if (successfulTransition) void loadStatistics();
 };
 const scheduleReconnect = () => { if (!disposed && !reconnectTimer) reconnectTimer = setTimeout(() => { reconnectTimer = undefined; connect(); }, 1000); };
 const reconnect = () => { generation++; historyEpoch++; close(); update({ ...view, connected: false, loading: false }); scheduleReconnect(); };
 const connect = () => {
  if (disposed) return;
  close(); update({ ...view, connected: false });
  const current = ++generation;
  close = ports.stream(data => {
   if (disposed || generation !== current) return;
   if (data.version < view.version) { reconnect(); return; }
   const fresh = data.version >= view.version;
   update(applySnapshot(view, data, ports.now())); followOwner(); void recover(); void completeLegacyHistory();
   if (fresh) void loadStatistics();
  }, event => { if (!disposed && generation === current) onEvent(event); }, () => { if (!disposed && generation === current) reconnect(); });
 };
 const lookup = async (entry: Entry) => {
  const response = await accountFetch(`/api/timer/commands/${entry.command.commandId}`, { cache: "no-store", signal: signal() });
  if (response.ok) { const data = await response.json(); if (!disposed) onEvent(data.result as TimerEvent); return true; }
  return response.status !== 404;
 };
 const flush = async () => {
  if (disposed || publishing) return;
  publishing = true;
  try {
   for (;;) {
    const entry = entries.find(item => !item.accepted);
    if (!entry || disposed) break;
    if (entry.uncertain && await lookup(entry)) { if (!entries.includes(entry)) continue; break; }
    if (!entries.includes(entry)) continue;
    const { type, ...body } = entry.command;
    entry.uncertain = true; if (!persist()) break;
    const response = await accountFetch(`/api/timer/${type}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: signal() });
    if (disposed) break;
    // AIDEV-NOTE: Результат SSE может удалить запись раньше задержанного HTTP ответа.
    if (!entries.includes(entry)) continue;
    if (response.status === 202) { entry.accepted = true; entry.uncertain = false; persist(); update(view); continue; }
    const failure = await response.json() as { outcome?: string };
    if (disposed || !entries.includes(entry)) continue;
    if (failure.outcome === "not-published") entry.uncertain = false;
    update({ ...view, message: "История пока не сохранена. Повторяем отправку тех же действий." }); persist(); break;
   }
  } catch { if (!disposed) update({ ...view, message: "История пока не сохранена. Проверяем результат отправки." }); }
  finally { publishing = false; }
 };
 const recover = async () => {
  if (disposed) return;
  void flush();
  if (lookingUp) return;
  const accepted = entries.filter(item => item.accepted);
  if (accepted.length) {
   lookingUp = true;
   try { for (let n = 0; n < Math.min(8, accepted.length); n++) {
    const entry = accepted[pollIndex++ % accepted.length];
    if (entries.includes(entry)) await lookup(entry);
   } } catch { /* Принятая команда остаётся в ledger lookup, без повторной публикации. */ }
   finally { lookingUp = false; }
  }
 };
 const loadHistory = async () => {
  if (!view.cursor || view.loading || !view.connected) return false;
  const cursor = view.cursor, epoch = historyEpoch, revision = view.historyRevision; update({ ...view, loading: true });
  try {
   const response = await accountFetch(`/api/timer/history?cursor=${encodeURIComponent(cursor)}`, { cache: "no-store", signal: signal() });
   if (!response.ok) {
    const failure = await response.json().catch(() => ({})) as { code?: string };
    if (failure.code === "HISTORY_CHANGED") { invalidateHistory(); reconnect(); return false; }
    throw new Error("HISTORY");
   }
   const data = await response.json() as History;
   if (disposed) return false;
   if (epoch !== historyEpoch || revision !== view.historyRevision || data.historyRevision !== undefined && data.historyRevision !== revision) return false;
   const items = mergeIntervals(view.items, data.items);
   // AIDEV-NOTE: Новый snapshot может переставить границу страниц, пока запрос ещё в пути.
   const sameCursor = view.cursor === cursor;
   const nextCursor = sameCursor ? data.nextCursor : view.cursor;
   update({ ...view, items, cursor: nextCursor, paged: sameCursor || view.paged, loading: false,
    totalCompletedMs: view.totalFromHistory && nextCursor === null ? sumCompleted(items) : view.totalCompletedMs });
   return true;
  } catch { if (!disposed) update({ ...view, loading: false, message: "Не удалось загрузить историю. Повторите загрузку." }); return false; }
 };
 const loadStatistics = async (): Promise<void> => {
  if (disposed) return;
  const current = ++statisticsRequest;
  update({ ...view, statisticsLoading: true });
  try {
   const response = await accountFetch("/api/timer/statistics", { cache: "no-store", signal: signal() });
   if (!response.ok) throw new Error("STATISTICS");
   const data = await response.json() as Statistics;
   if (disposed || current !== statisticsRequest) return;
   update({ ...view, statistics: data.version >= view.version ? data : view.statistics, statisticsLoading: false });
  } catch {
   if (!disposed && current === statisticsRequest) update({ ...view, statisticsLoading: false });
  }
 };
 const enqueueMutation = (type: "edit" | "delete", timerId: string, startedAt?: string, stoppedAt?: string): string | null => {
  if (disposed) return null;
  if (storageBlocked) { update({ ...view, message: "Это действие не сохранится: хранилище вкладки недоступно или повреждено." }); return null; }
  if (entries.length >= OUTBOX_LIMIT) { update({ ...view, message: "Очередь заполнена: дождитесь сохранения предыдущих действий." }); return null; }
  const command: Pending = { type, commandId: ports.id(), timerId, expectedVersion: view.version, ...(startedAt ? { startedAt } : {}), ...(stoppedAt ? { stoppedAt } : {}) };
  entries.push({ command, accepted: false, uncertain: false });
  update({ ...view, message: "" });
  if (!persist()) { entries.pop(); update({ ...view, message: "Не удалось сохранить действие в очереди браузера." }); return null; }
  void flush();
  return command.commandId;
 };
 const completeLegacyHistory = async () => {
  if (fillingHistory) return;
  fillingHistory = true;
  try {
   while (!disposed && view.totalFromHistory && view.totalCompletedMs === null && view.cursor && view.connected) {
    if (!await loadHistory()) break;
   }
  } finally { fillingHistory = false; }
 };
 return {
  /** Возвращает локальный отсчёт и подтверждённую проекцию. */
  getView: () => view,
  /** Подписывает страницу на изменения без ожидания сервера. */
  subscribe(listener: (view: View) => void) { listeners.add(listener); listener(view); return () => { listeners.delete(listener); }; },
  /** Восстанавливает только очередь текущего аккаунта; анонимные данные v1 не читает. */
  start() {
   try {
    const raw = ports.storage.getItem(storageKey);
    if (raw) {
     const data = JSON.parse(raw) as Stored;
     if (!Array.isArray(data.entries) || data.entries.length > OUTBOX_LIMIT || !data.entries.every(item => isPending(item.command) && typeof item.accepted === "boolean" && typeof item.uncertain === "boolean") || !Number.isFinite(data.elapsed) || !Number.isFinite(data.savedAt) || !Number.isSafeInteger(data.barrier) || typeof data.hold !== "boolean" || data.local && (!data.local.timerId || !Number.isFinite(Date.parse(data.local.startedAt)))) throw new Error("BAD_STORAGE");
     entries = data.entries; hold = data.hold; barrier = data.barrier; localCommandId = data.localCommandId ?? null;
     update({ ...view, local: data.local, localElapsed: data.local ? data.elapsed + Math.max(0, initialEpoch - data.savedAt) : 0, localMono: ports.now() });
    }
   } catch { storageBlocked = true; hold = true; update({ ...view, message: "Сохранённые действия повреждены или недоступны. Не закрывайте вкладку; проверьте хранилище браузера." }); }
   connect(); polling = setInterval(() => { void recover(); }, 2000); void recover();
  },
  /** Мгновенно меняет отсчёт; очередь ограничена и не заменяет старые намерения. */
  command() {
   if (disposed) return;
   const mono = ports.now(), active = view.local;
   const epoch = view.anchorServer ? view.anchorServer + mono - view.anchorMono : initialEpoch + mono - initialMono;
   const command: Pending = active
    ? { type: "stop", commandId: ports.id(), timerId: active.timerId, stoppedAt: new Date(Date.parse(active.startedAt) + Math.floor(duration(view, mono))).toISOString() }
    : { type: "start", commandId: ports.id(), timerId: ports.id(), startedAt: new Date(epoch).toISOString() };
   hold = true; localCommandId = command.commandId;
   update({ ...view, local: active ? null : { timerId: command.timerId!, startedAt: command.startedAt! }, localElapsed: 0, localMono: mono, message: "" });
   if (storageBlocked) { update({ ...view, message: "Это действие не сохранится: хранилище вкладки недоступно или повреждено." }); return; }
   if (entries.length >= OUTBOX_LIMIT) { update({ ...view, message: "Очередь заполнена: это действие не сохранится в истории. Дождитесь сохранения предыдущих действий." }); persist(); return; }
   entries.push({ command, accepted: false, uncertain: false });
   update(view); if (persist()) void flush();
  },
  /** Ставит неизменную millisecond-точную правку в FIFO с ожидаемой версией владельца. */
  editInterval(timerId: string, startedAt: string, stoppedAt: string): string | null {
   if (!isIntentTimestamp(startedAt) || !isIntentTimestamp(stoppedAt) || Date.parse(startedAt) >= Date.parse(stoppedAt)) {
    update({ ...view, message: "Укажите корректное начало раньше завершения с точностью до миллисекунд." }); return null;
   }
   if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(timerId)) {
    update({ ...view, message: "Не удалось определить сессию для изменения." }); return null;
   }
   return enqueueMutation("edit", timerId, startedAt, stoppedAt);
  },
  /** Ставит удаление завершённой сессии в FIFO без изменения локального отсчёта. */
  deleteInterval(timerId: string): string | null {
   if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(timerId)) {
    update({ ...view, message: "Не удалось определить сессию для удаления." }); return null;
   }
   return enqueueMutation("delete", timerId);
  },
  /** Читает полную owner-статистику отдельно от загруженных страниц истории. */
  loadStatistics,
  /** Загружает устойчивую следующую страницу без замены live истории. */
  async loadHistory() { await loadHistory(); await completeLegacyHistory(); },
  /** Возвращение страницы обновляет только историю и anchor владельца. */
  resync: reconnect,
  /** Отменяет I/O; неизменная очередь остаётся для следующего документа. */
  stop() { disposed = true; generation++; persist(); lifetime.abort(); close(); clearInterval(polling); clearTimeout(reconnectTimer); listeners.clear(); },
 };
}
