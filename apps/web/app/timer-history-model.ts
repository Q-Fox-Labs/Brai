// ABOUTME: Делит отображение истории по московским дням и рассчитывает правки целых сессий.
// ABOUTME: Чистая модель сохраняет миллисекундную точность и не знает о клиенте или React.
import type { Active, Interval } from "../lib/types";

export type EditField = "start" | "duration" | "end";
export type EditDraft = {
 timerId: string;
 originalStartMs: number;
 originalEndMs: number;
 startMs: number;
 endMs: number;
};
export type IntervalSegment = {
 rowId: string;
 interval: Interval;
 startedAt: string;
 stoppedAt: string;
 durationMs: number;
 split: boolean;
};
export type IntervalDay = { date: string; items: IntervalSegment[] };

const MOSCOW = "Europe/Moscow";
const STEP_MS = 5 * 60_000;
const dayParts = new Intl.DateTimeFormat("en-CA", { timeZone: MOSCOW, year: "numeric", month: "2-digit", day: "2-digit" });
const clockParts = new Intl.DateTimeFormat("en-GB", { timeZone: MOSCOW, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const offsetParts = new Intl.DateTimeFormat("en", { timeZone: MOSCOW, timeZoneName: "longOffset" });

/** Делит только отображение на московские дни; interval всегда хранит полный диапазон владельца. */
export function groupIntervalsByMoscowDate(items: Interval[]): IntervalDay[] {
 const groups = new Map<string, IntervalSegment[]>();
 for (const interval of items) {
  const start = Date.parse(interval.startedAt), end = Date.parse(interval.stoppedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
  const split = end > start && dayParts.format(start) !== dayParts.format(end - 1);
  let cursor = start;
  do {
   const date = dayParts.format(cursor);
   const segmentEnd = Math.min(end, nextMoscowMidnight(cursor));
   if (segmentEnd < cursor) break;
   const segment: IntervalSegment = {
    rowId: `${date}:${interval.timerId}`, interval,
    startedAt: new Date(cursor).toISOString(), stoppedAt: new Date(segmentEnd).toISOString(),
    durationMs: segmentEnd - cursor, split,
   };
   groups.set(date, [...(groups.get(date) ?? []), segment]);
   cursor = segmentEnd;
  } while (cursor < end);
 }
 return [...groups].sort(([left], [right]) => right.localeCompare(left)).map(([date, rows]) => ({
  date,
  items: rows.sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.interval.timerId.localeCompare(a.interval.timerId)),
 }));
}

function nextMoscowMidnight(epoch: number): number {
 const date = Object.fromEntries(dayParts.formatToParts(epoch).filter(part => part.type !== "literal").map(part => [part.type, Number(part.value)]));
 const civilMidnight = Date.UTC(date.year, date.month - 1, date.day + 1);
 let candidate = civilMidnight;
 // AIDEV-NOTE: IANA offset следующей границы может отличаться от offset начала сессии.
 for (let attempt = 0; attempt < 3; attempt++) candidate = civilMidnight - moscowOffsetMs(candidate);
 return candidate;
}

function moscowOffsetMs(epoch: number): number {
 const offset = offsetParts.formatToParts(epoch).find(part => part.type === "timeZoneName")?.value ?? "GMT+03:00";
 if (offset === "GMT") return 0;
 const match = /^GMT([+-])(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(offset);
 if (!match) throw new Error("Недоступно смещение московского календаря.");
 const milliseconds = (Number(match[2]) * 3600 + Number(match[3]) * 60 + Number(match[4] ?? 0)) * 1000;
 return match[1] === "-" ? -milliseconds : milliseconds;
}

/** Создаёт draft из исходных UTC-меток, сохраняя полный миллисекундный диапазон. */
export function createEditDraft(item: Interval): EditDraft | null {
 const startMs = Date.parse(item.startedAt), endMs = Date.parse(item.stoppedAt);
 if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
 return { timerId: item.timerId, originalStartMs: startMs, originalEndMs: endMs, startMs, endMs };
}

/** Возвращает ISO диапазон без округления канонических меток. */
export function draftRange(draft: EditDraft): { startedAt: string; stoppedAt: string } {
 return { startedAt: new Date(draft.startMs).toISOString(), stoppedAt: new Date(draft.endMs).toISOString() };
}

/** Проверяет, отличается ли draft от исходных timestamp, включая миллисекунды. */
export function draftChanged(draft: EditDraft): boolean {
 return draft.startMs !== draft.originalStartMs || draft.endMs !== draft.originalEndMs;
}

/** Форматирует время или длительность для редактирования в московском времени. */
export function formatEditValue(field: EditField, startMs: number, endMs: number): string {
 if (field === "duration") {
  const minutes = Math.floor((endMs - startMs) / 60_000);
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
 }
 return clockParts.format(field === "start" ? startMs : endMs);
}

/** Проверяет текст HH:mm; длительность допускает часы свыше суток. */
export function normalizeEditValue(field: EditField, value: string): string | null {
 const minutes = parseEditMinutes(field, value);
 if (minutes === null) return null;
 return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/** Применяет правку ввода, сохраняя секунды и миллисекунды исходной метки/длительности. */
export function applyEditInput(draft: EditDraft, field: EditField, value: string): EditDraft | null {
 const minutes = parseEditMinutes(field, value);
 if (minutes === null) return null;
 if (field === "duration") {
  const tail = (draft.endMs - draft.startMs) % 60_000;
  return validDraft({ ...draft, endMs: draft.startMs + minutes * 60_000 + tail });
 }
 const oldMs = field === "start" ? draft.startMs : draft.endMs;
 const nextMs = setMoscowClock(oldMs, minutes);
 if (field === "start") {
  const delta = nextMs - draft.startMs;
  return validDraft({ ...draft, startMs: nextMs, endMs: draft.endMs + delta });
 }
 return validDraft({ ...draft, endMs: nextMs });
}

/** Сдвигает старт вместе с финишем; длительность меняет финиш, старт остаётся на месте. */
export function applyEditStep(draft: EditDraft, field: EditField, direction: -1 | 1): EditDraft | null {
 if (field === "start") {
  const delta = direction * STEP_MS;
  return validDraft({ ...draft, startMs: draft.startMs + delta, endMs: draft.endMs + delta });
 }
 const nextEnd = draft.endMs + direction * STEP_MS;
 return validDraft({ ...draft, endMs: field === "duration" ? Math.max(draft.startMs + STEP_MS, nextEnd) : nextEnd });
}

/** Возвращает понятную ошибку для неверного диапазона или наложения на загруженный/активный таймер. */
export function editRangeError(draft: EditDraft, items: Interval[], active: Active | null): string | null {
 if (!Number.isFinite(draft.startMs) || !Number.isFinite(draft.endMs) || draft.endMs <= draft.startMs) return "Финиш должен быть позже старта.";
 const overlaps = (start: number, end: number) => draft.startMs < end && start < draft.endMs;
 for (const item of items) {
  if (item.timerId === draft.timerId) continue;
  const start = Date.parse(item.startedAt), end = Date.parse(item.stoppedAt);
  if (Number.isFinite(start) && Number.isFinite(end) && overlaps(start, end)) return "Интервал пересекается с другой записью.";
 }
 if (active) {
  const start = Date.parse(active.startedAt);
  if (Number.isFinite(start) && overlaps(start, Number.POSITIVE_INFINITY)) return "Интервал пересекается с активным таймером.";
 }
 return null;
}

/** Форматирует продолжительность без ограничения 24 часами; отбрасывает секунды только в подписи. */
export function formatHistoryDuration(ms: number): string {
 const seconds = Math.max(0, Math.floor(ms / 1000));
 return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map(value => String(value).padStart(2, "0")).join(":");
}

/** Форматирует московское время; при указанном дне добавляет дату для границы вне него. */
export function formatIntervalEdge(value: string, dayDate?: string): string {
 const epoch = Date.parse(value);
 if (!Number.isFinite(epoch)) return "—";
 const date = dayParts.format(epoch);
 return `${!dayDate || date === dayDate ? "" : `${date.slice(8, 10)} ${new Intl.DateTimeFormat("ru-RU", { timeZone: MOSCOW, month: "short" }).format(epoch).replace(/\.$/, "")} `}${clockParts.format(epoch)}`;
}

/** Отображает день в русской локали по календарной дате Москвы. */
export function formatMoscowDay(date: string): string {
 const epoch = Date.parse(`${date}T12:00:00+03:00`);
 return new Intl.DateTimeFormat("ru-RU", { timeZone: MOSCOW, weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(epoch);
}

/** Форматирует полный дневной итог без секунд для заголовка группы. */
export function formatDayDuration(ms: number): string {
 const minutes = Math.floor(Math.max(0, ms) / 60_000);
 const hours = Math.floor(minutes / 60), remainder = minutes % 60;
 return hours ? `${hours} ч ${remainder} мин` : `${remainder} мин`;
}

/** Показывает точность процента статистики, округляя только подпись. */
export function formatDayPercent(percent: number): string {
 const safe = Math.max(0, percent);
 return `${new Intl.NumberFormat("ru-RU", { maximumFractionDigits: safe >= 100 ? 0 : 1 }).format(safe)}%`;
}

function parseEditMinutes(field: EditField, value: string): number | null {
 const match = /^(\d{1,4}):(\d{2})$/.exec(value.trim());
 if (!match) return null;
 const hours = Number(match[1]), minutes = Number(match[2]);
 if (!Number.isInteger(hours) || !Number.isInteger(minutes) || minutes > 59) return null;
 if (field !== "duration" && (hours > 23 || hours < 0)) return null;
 const total = hours * 60 + minutes;
 return field === "duration" && total <= 0 ? null : total;
}

function setMoscowClock(epoch: number, minutes: number): number {
 const date = Object.fromEntries(dayParts.formatToParts(epoch).filter(part => part.type !== "literal").map(part => [part.type, Number(part.value)]));
 const seconds = new Date(epoch).getUTCSeconds(), milliseconds = new Date(epoch).getUTCMilliseconds();
 const minuteOfDay = Math.floor(minutes);
 const offset = offsetParts.formatToParts(epoch).find(part => part.type === "timeZoneName")?.value ?? "GMT+03:00";
 const [, sign, hours, remainder] = /^GMT([+-])(\d{2}):(\d{2})$/.exec(offset) ?? ["", "+", "03", "00"];
 const offsetMinutes = (Number(hours) * 60 + Number(remainder)) * (sign === "-" ? -1 : 1);
 return Date.UTC(date.year, date.month - 1, date.day, Math.floor(minuteOfDay / 60), minuteOfDay % 60, seconds, milliseconds) - offsetMinutes * 60_000;
}

function validDraft(draft: EditDraft): EditDraft | null {
 return draft.endMs > draft.startMs ? draft : null;
}
