// ABOUTME: Форматирует данные окна лимита для интерфейса Agent.
// ABOUTME: Время сброса использует локальный часовой пояс среды, которая его отображает.

/** Форматирует Unix seconds в локальном часовом поясе; некорректное время скрывает. */
export function formatLimitReset(resetsAt: number | null): { label: string; title: string; iso: string } | null {
  if (resetsAt === null) return null;
  const date = new Date(resetsAt * 1000);
  if (!Number.isFinite(date.getTime())) return null;
  try {
    return {
      label: new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZoneName: "short" }).format(date),
      title: new Intl.DateTimeFormat("ru-RU", { dateStyle: "full", timeStyle: "long" }).format(date),
      iso: date.toISOString(),
    };
  } catch { return null; }
}
