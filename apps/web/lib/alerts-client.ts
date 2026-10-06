// ABOUTME: Синхронизирует ленту и счётчик одного аккаунта через HTTP и SSE signals.
// ABOUTME: Остановка отменяет запросы; неизвестный счётчик не становится нулём при отказе связи.
import type { AlertNotification, AlertPage, AlertSummary } from "./alerts-types";
export type AlertsState = { summary: AlertSummary | null; items: AlertNotification[] | null; nextCursor: string | null;
 loading: boolean; loadingMore: boolean; reading: string | null; error: string; live: boolean };
type Events = { addEventListener: (name: string, listener: () => void) => void; close: () => void };
type Dependencies = { userId: string; fetch: typeof fetch; events: () => Events; onUnauthorized: () => void };
/** Уникальный ключ уведомления включает сервис источника. */
export const alertKey = (item: Pick<AlertNotification, "service_id" | "id">) => item.service_id + "/" + item.id;
/** Один экземпляр принадлежит смонтированному аккаунту; пользовательские операции явно запускает UI. */
export class AlertsClient {
 private state: AlertsState = { summary: null, items: null, nextCursor: null, loading: false, loadingMore: false, reading: null, error: "", live: false };
 private listeners = new Set<() => void>();
 private lifetime: AbortController | null = null;
 private sync: AbortController | null = null;
 private source: Events | null = null;
 private timer: ReturnType<typeof setInterval> | undefined;
 private requested = false;
 private feed = false;
 private pages = 1;
 private revision = 0;
 private focus = () => this.refresh();
 private dependencies: Dependencies;
 constructor(dependencies: Dependencies) { this.dependencies = dependencies; }
 /** Снимок стабилен до следующего изменения; подходит useSyncExternalStore. */
 getSnapshot = () => this.state;
 /** Подписывает UI на изменения, не открывая дополнительных подключений. */
 subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
 private update(patch: Partial<AlertsState>) { this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener(); }
 /** Запускает SSE, сверку каждые 15 секунд и при возвращении фокуса. */
 start() {
  if (this.lifetime) return;
  const lifetime = this.lifetime = new AbortController();
  this.source = this.dependencies.events();
  this.source.addEventListener("open", () => { if (lifetime !== this.lifetime) return; this.update({ live: true }); this.refresh(); });
  this.source.addEventListener("ready", () => { if (lifetime === this.lifetime) this.refresh(); });
  this.source.addEventListener("changed", () => { if (lifetime === this.lifetime) this.refresh(); });
  this.source.addEventListener("error", () => { if (lifetime === this.lifetime) this.update({ live: false }); });
  this.timer = setInterval(this.focus, 15000);
  if (typeof window !== "undefined") window.addEventListener("focus", this.focus);
  this.refresh();
 }
 /** Прекращает все запросы и SSE при выходе, отзыве или смене аккаунта. */
 stop() {
  this.lifetime?.abort(); this.lifetime = null; this.sync?.abort(); this.sync = null;
  this.source?.close(); this.source = null; clearInterval(this.timer);
  if (typeof window !== "undefined") window.removeEventListener("focus", this.focus);
  this.revision++; this.requested = false;
 }
 private async request<T>(path: string, signal: AbortSignal, mutation = false): Promise<T> {
  const response = await this.dependencies.fetch("/api/alerts" + path, { cache: "no-store", signal,
   headers: { "x-brai-user": this.dependencies.userId, ...(mutation ? { "Content-Type": "application/json" } : {}) },
   ...(mutation ? { method: "POST", body: "{}" } : {}) });
  if (signal.aborted) throw new Error("ABORTED");
  if (response.status === 401) { this.stop(); this.dependencies.onUnauthorized(); throw new Error("UNAUTHORIZED"); }
  if (!response.ok) throw new Error("UNAVAILABLE");
  const data = await response.json() as T;
  if (signal.aborted) throw new Error("ABORTED");
  return data;
 }
 /** Включает чтение ленты один раз после её первого посещения; не отмечает записи. */
 openFeed() { if (!this.feed) { this.feed = true; this.refresh(); } }
 /** Объединяет одновременные signals и перечитывает все уже загруженные страницы атомарно. */
 refresh = () => {
  if (!this.lifetime) return;
  if (this.sync || this.state.reading) { this.requested = true; return; }
  const controller = new AbortController(), lifetime = this.lifetime, revision = this.revision;
  const abort = () => controller.abort(); lifetime.signal.addEventListener("abort", abort, { once: true });
  this.sync = controller; this.requested = false;
  this.update({ loading: this.feed && this.state.items === null });
  void (async () => {
   try {
    const summary = await this.request<AlertSummary>("/summary", controller.signal);
    if (revision !== this.revision || lifetime !== this.lifetime) return;
    this.update({ summary });
    if (this.feed) {
     const items: AlertNotification[] = []; let cursor: string | null = null;
     for (let page = 0; page < this.pages; page++) {
      const result: AlertPage = await this.request("?limit=50" + (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""), controller.signal);
      items.push(...result.items); cursor = result.next_cursor; if (!cursor) break;
     }
     if (revision !== this.revision || lifetime !== this.lifetime) return;
     this.update({ items: [...new Map(items.map(item => [alertKey(item), item])).values()], nextCursor: cursor });
    }
    this.update({ error: "" });
   } catch { if (!controller.signal.aborted && lifetime === this.lifetime) this.update({ error: "Не удалось обновить уведомления. Повторим при восстановлении связи." }); }
   finally {
    lifetime.signal.removeEventListener("abort", abort);
    if (this.sync === controller) { this.sync = null; this.update({ loading: false, loadingMore: false }); if (this.requested) this.refresh(); }
   }
  })();
 };
 /** Загружает ещё одну страницу, сохраняя единый порядок и прежнюю ленту при ошибке. */
 loadMore = () => {
  if (!this.lifetime || !this.state.nextCursor || this.state.loadingMore || this.state.reading) return;
  this.pages++; this.update({ loadingMore: true }); this.refresh();
 };
 /** Отмечает только выбранную запись либо все; запуск не зависит от просмотра ленты. */
 read = async (item?: AlertNotification) => {
  const lifetime = this.lifetime;
  if (!lifetime || this.state.reading) return;
  this.revision++; this.sync?.abort(); this.update({ reading: item ? alertKey(item) : "all", error: "" });
  try {
   const summary = await this.request<AlertSummary>(item ? `/${encodeURIComponent(item.service_id)}/${encodeURIComponent(item.id)}/read` : "/read-all", lifetime.signal, true);
   if (lifetime !== this.lifetime) return;
   this.update({ summary });
  } catch { if (!lifetime.signal.aborted) this.update({ error: "Не удалось подтвердить прочтение. Обновите ленту и повторите." }); }
  finally { if (lifetime === this.lifetime) { this.update({ reading: null }); this.refresh(); } }
 };
}
