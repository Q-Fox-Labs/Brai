// ABOUTME: Применяет подтверждённые snapshots/events и рассчитывает монотонные часы.
// ABOUTME: Не выполняет I/O и не создаёт commandId; история сохраняет ранее загруженные страницы.
import type { Active, Interval, Pending, Snapshot, TimerEvent } from "./types";
export type View = { active: Active | null; version: number; items: Interval[]; cursor: string | null; paged: boolean;
 anchorServer: number; anchorMono: number; connected: boolean; pending: Pending | null; message: string; loading: boolean };
/** Возвращает исходное состояние до первого свежего snapshot. */
export function initialView(): View { return { active: null, version: 0, items: [], cursor: null, paged: false,
 anchorServer: 0, anchorMono: 0, connected: false, pending: null, message: "", loading: false }; }
/** Объединяет страницы/live запись без повторов по timerId. */
export function mergeIntervals(a: Interval[], b: Interval[]): Interval[] {
 return [...new Map([...a, ...b].map(item => [item.timerId, item])).values()].sort((x, y) =>
 y.startedAt.localeCompare(x.startedAt) || y.timerId.localeCompare(x.timerId));
}
/** Снимок заменяет state и clock anchor, сохраняя историю и курсор загруженных старых страниц. */
export function applySnapshot(view: View, data: Snapshot, mono: number): View {
 // AIDEV-NOTE: Без overlap >50 новых записей могут лежать между snapshot и старым курсором.
 const overlap = data.recentCompleted.some(item => view.items.some(old => old.timerId === item.timerId));
 const paged = view.paged && overlap;
 return { ...view, active: data.active, version: data.version,
  items: mergeIntervals(view.items, data.recentCompleted), cursor: paged ? view.cursor : data.nextCursor, paged,
  anchorServer: Date.parse(data.serverTime), anchorMono: mono, connected: true };
}
/** Разрешает pending независимо от версии; gap требует свежего снимка. */
export function applyEvent(view: View, event: TimerEvent): View {
 const resolved = view.pending?.commandId === event.commandId;
 let next = { ...view, pending: resolved ? null : view.pending,
  message: resolved ? ("error" in event ? rejectionMessage(event.error.code) : "") : view.message };
 if (!("version" in event) || event.version <= view.version) return next;
 if (event.version !== view.version + 1) return { ...next, connected: false };
 next = { ...next, version: event.version };
 if ("interval" in event) return { ...next, active: null, items: mergeIntervals(next.items, [event.interval]) };
 return { ...next, active: { timerId: event.timerId, startedAt: event.startedAt } };
}
/** Вычисляет duration по serverTime + performance.now; системные часы браузера не участвуют. */
export function duration(view: View, mono: number): number {
 return view.active ? Math.max(0, view.anchorServer + mono - view.anchorMono - Date.parse(view.active.startedAt)) : view.items[0]?.durationMs ?? 0;
}
/** Форматирует часы без ограничения суток, отбрасывая неполную секунду. */
export function formatDuration(ms: number): string {
 const seconds = Math.max(0, Math.floor(ms / 1000));
 return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map(n => String(n).padStart(2, "0")).join(":");
}
/** Переводит окончательный отказ сервиса в действие для пользователя. */
export function rejectionMessage(code: string): string {
 return code === "VERSION_CONFLICT" || code === "TIMER_ALREADY_ACTIVE" || code === "TIMER_NOT_ACTIVE"
  ? "Таймер уже изменился в другом окне. Состояние обновлено; повторите действие."
  : "Команда отклонена. Обновите состояние и повторите действие.";
}
/** Проверяет целую pending запись, чтобы после reload повторить исходную команду. */
export function isPending(value: unknown): value is Pending {
 if (!value || typeof value !== "object") return false;
 const p = value as Pending;
 const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
 return uuid.test(p.commandId) && Number.isSafeInteger(p.expectedVersion) && p.expectedVersion >= 0 &&
  (p.type === "start" && p.timerId === undefined || p.type === "stop" && typeof p.timerId === "string" && uuid.test(p.timerId));
}
