// ABOUTME: Применяет подтверждённые snapshots/events и рассчитывает монотонные часы.
// ABOUTME: Не выполняет I/O и не создаёт commandId; история сохраняет ранее загруженные страницы.
import type { Active, Interval, Pending, Snapshot, Statistics, TimerEvent } from "./types";
export type View = { active: Active | null; version: number; historyRevision: number; items: Interval[]; cursor: string | null; paged: boolean; totalCompletedMs: number | null; totalFromHistory: boolean;
 statistics: Statistics | null; statisticsLoading: boolean;
 anchorServer: number; anchorMono: number; connected: boolean; local: Active | null; localElapsed: number; localMono: number; queued: number; message: string; loading: boolean };
/** Возвращает исходное состояние до первого свежего snapshot. */
export function initialView(): View { return { active: null, version: 0, historyRevision: 0, items: [], cursor: null, paged: false, totalCompletedMs: null, totalFromHistory: false,
 statistics: null, statisticsLoading: false,
 anchorServer: 0, anchorMono: 0, connected: false, local: null, localElapsed: 0, localMono: 0, queued: 0, message: "", loading: false }; }
/** Объединяет страницы/live запись без повторов по timerId. */
export function mergeIntervals(a: Interval[], b: Interval[]): Interval[] {
 return [...new Map([...a, ...b].map(item => [item.timerId, item])).values()].sort((x, y) =>
 y.startedAt.localeCompare(x.startedAt) || y.timerId.localeCompare(x.timerId));
}
/** Суммирует миллисекунды завершённых уникальных интервалов до форматирования. */
export function sumCompleted(items: Interval[]): number {
 return [...new Map(items.map(item => [item.timerId, item])).values()].reduce((sum, item) => sum + item.durationMs, 0);
}
/** Снимок заменяет state и clock anchor, сохраняя историю и курсор загруженных старых страниц. */
export function applySnapshot(view: View, data: Snapshot, mono: number): View {
 // AIDEV-NOTE: Без overlap >50 новых записей могут лежать между snapshot и старым курсором.
 if (data.version < view.version) return { ...view, connected: false };
 const historyRevision = data.historyRevision ?? view.historyRevision;
 const historyChanged = data.historyRevision !== undefined && data.historyRevision !== view.historyRevision;
 if (historyChanged) return { ...view, active: data.active, version: data.version, historyRevision, items: mergeIntervals([], data.recentCompleted),
  cursor: data.nextCursor, paged: false, totalFromHistory: data.totalCompletedMs === undefined,
  totalCompletedMs: data.totalCompletedMs ?? (data.nextCursor === null ? sumCompleted(data.recentCompleted) : null),
  loading: false, anchorServer: Date.parse(data.serverTime), anchorMono: mono, connected: true };
 const overlap = data.recentCompleted.some(item => view.items.some(old => old.timerId === item.timerId));
 const paged = view.paged && overlap;
 const items = mergeIntervals(view.items, data.recentCompleted), cursor = paged ? view.cursor : data.nextCursor;
 return { ...view, active: data.active, version: data.version, historyRevision,
  items, cursor, paged, totalFromHistory: data.totalCompletedMs === undefined,
  totalCompletedMs: data.totalCompletedMs ?? (cursor === null ? sumCompleted(items) : null),
  anchorServer: Date.parse(data.serverTime), anchorMono: mono, connected: true };
}
/** Применяет только подтверждённую историю; локальные намерения здесь не меняются. */
export function applyEvent(view: View, event: TimerEvent): View {
 if (!("version" in event) || event.version <= view.version) return view;
 if (event.version !== view.version + 1) return { ...view, connected: false };
 const next = { ...view, version: event.version };
 if ("interval" in event) {
  if ("operation" in event && event.operation === "edit") return { ...next, connected: false };
  const items = mergeIntervals(next.items, [event.interval]);
  // AIDEV-NOTE: Старый DTO считает по уникальным строкам: history может опередить доставку SSE.
  return { ...next, active: null, items, totalCompletedMs: next.totalCompletedMs === null ? null :
   next.totalFromHistory ? sumCompleted(items) : next.totalCompletedMs + event.interval.durationMs };
 }
 if ("operation" in event && event.operation === "delete") return { ...next, connected: false };
 return { ...next, active: { timerId: event.timerId, startedAt: event.startedAt } };
}
/** Локальный STOP всегда даёт ноль; тики не накапливаются и не читают Date.now. */
export function duration(view: View, mono: number): number {
 return view.local ? Math.max(0, view.localElapsed + mono - view.localMono) : 0;
}
/** Подтверждённый активный интервал считает часы владельца независимо от локального STOP. */
export function ownerDuration(view: View, mono: number): number {
 return view.active ? Math.max(0, view.anchorServer + mono - view.anchorMono - Date.parse(view.active.startedAt)) : 0;
}
/** Форматирует часы без ограничения суток, отбрасывая неполную секунду. */
export function formatDuration(ms: number): string {
 const seconds = Math.max(0, Math.floor(ms / 1000));
 return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map(n => String(n).padStart(2, "0")).join(":");
}
/** Переводит окончательный отказ сервиса в действие для пользователя. */
export function rejectionMessage(code: string): string {
 if (code === "INTERVAL_OVERLAP") return "Интервал пересекается с другой сессией. Измените время и повторите.";
 if (code === "NOT_FOUND") return "Сессия больше не найдена. История будет обновлена.";
 return code === "VERSION_CONFLICT" || code === "TIMER_ALREADY_ACTIVE" || code === "TIMER_NOT_ACTIVE"
  ? "Действие не записано: общий таймер изменился в другом окне. Локальный отсчёт продолжается независимо."
  : "Команда отклонена. Обновите состояние и повторите действие.";
}
/** Принимает только точные UTC миллисекунды из timer command schema, не переписывая строку. */
export function isIntentTimestamp(value: unknown): value is string {
 if (typeof value !== "string" || !/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/.test(value)) return false;
 const parsed = Date.parse(value);
 return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}
/** Проверяет целую pending запись, чтобы после reload повторить исходную команду. */
export function isPending(value: unknown): value is Pending {
 if (!value || typeof value !== "object") return false;
 const p = value as Pending;
 const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
 if (!uuid.test(p.commandId) || !["start", "stop", "edit", "delete"].includes(p.type)) return false;
 if (p.expectedVersion !== undefined && (!Number.isSafeInteger(p.expectedVersion) || p.expectedVersion < 0)) return false;
 if (p.type === "edit") return p.expectedVersion !== undefined && typeof p.timerId === "string" && uuid.test(p.timerId) &&
  isIntentTimestamp(p.startedAt) && isIntentTimestamp(p.stoppedAt) && Date.parse(p.startedAt) < Date.parse(p.stoppedAt);
 if (p.type === "delete") return p.expectedVersion !== undefined && typeof p.timerId === "string" && uuid.test(p.timerId);
 if (p.expectedVersion !== undefined) return p.type === "start" && p.timerId === undefined || p.type === "stop" && typeof p.timerId === "string" && uuid.test(p.timerId);
 const time = p.type === "start" ? p.startedAt : p.stoppedAt;
 return typeof p.timerId === "string" && uuid.test(p.timerId) && isIntentTimestamp(time);
}
