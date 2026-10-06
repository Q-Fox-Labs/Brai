// ABOUTME: Форматирует данные окна лимита для интерфейса Agent.
// ABOUTME: Время сброса использует локальный часовой пояс среды, которая его отображает.

/** Считает полные дни/часы до Unix seconds относительно now в миллисекундах и долю окна; неизвестные значения скрывает. */
export function limitCountdown(resetsAt: number | null, windowDurationMins: number | null, now: number): { label: string; percent: number | null } | null {
  if (resetsAt === null || !Number.isFinite(new Date(resetsAt * 1000).getTime()) || !Number.isFinite(now)) return null;
  const remainingMs = Math.max(0, resetsAt * 1000 - now);
  const hours = Math.floor(remainingMs / 3_600_000), days = Math.floor(hours / 24);
  return {
    label: days ? `${days} дн. ${hours % 24} ч` : `${hours} ч`,
    percent: windowDurationMins !== null && Number.isFinite(windowDurationMins) && windowDurationMins > 0
      ? Math.min(100, remainingMs / (windowDurationMins * 60_000) * 100) : null,
  };
}

/** Форматирует Unix seconds в локальном часовом поясе; некорректное время скрывает. */
export function formatLimitReset(resetsAt: number | null): { label: string; title: string; iso: string } | null {
  if (resetsAt === null) return null;
  const date = new Date(resetsAt * 1000);
  if (!Number.isFinite(date.getTime())) return null;
  try {
    return {
      label: new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }).format(date),
      title: new Intl.DateTimeFormat("ru-RU", { dateStyle: "full", timeStyle: "short" }).format(date),
      iso: date.toISOString(),
    };
  } catch { return null; }
}
