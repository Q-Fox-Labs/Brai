// ABOUTME: Обеспечивает отображение синтетического таймера миссии.
// ABOUTME: Не вызывает настоящий таймер Brai и не сохраняет сессии.
import { useEffect, useState } from "react";
export type TimeSession = { missionId: string; startedAt: number };

/** Обновляет локальные часы раз в секунду; освобождает интервал при размонтировании. */
export function useTimerNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, []);
  return now;
}

/** Возвращает исходный компактный формат длительности в секундах. */
export function formatCompactDuration(seconds: number) {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor(safeSeconds % 3600 / 60);
  const rest = safeSeconds % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
  if (minutes > 0) return `${minutes}:${String(rest).padStart(2, "0")}`;
  return String(rest);
}
