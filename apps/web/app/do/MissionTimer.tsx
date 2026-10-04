// ABOUTME: Восстанавливает исходный компонент MissionTimer.tsx из Brai September.
// ABOUTME: Использует локальный TasksContext; серверные операции задач отсутствуют.
import {
  formatCompactDuration,
  type TimeSession,
  useTimerNow,
} from "./demo-timer";

/** Сохраняет разметку и взаимодействия исходного компонента September на локальных данных. */
export default function MissionTimer({
  session,
  isStopping,
  onStop,
}: {
  session: TimeSession;
  isStopping: boolean;
  onStop: () => void;
}) {
  const now = useTimerNow();
  const duration = formatCompactDuration(Math.floor((now - session.startedAt) / 1000));

  return (
    <div data-mission-timer className="my-1.5 mb-[5px] inline-flex min-h-7 items-center gap-[9px] text-brai-mission">
      <span className="text-[13px] font-bold tabular-nums" role="timer" aria-label={`Таймер миссии: ${duration}`}>
        {duration}
      </span>
      <button className="min-h-7 rounded-[7px] border border-brai-mission/38 bg-[#f4fbf6] px-[9px] text-[12px] font-bold text-[#257848] hover:not-disabled:border-brai-mission hover:not-disabled:bg-[#e5f7eb] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brai-mission/50 disabled:cursor-wait disabled:opacity-65 dark:border-[#6ec990]/45 dark:bg-[#1d3525] dark:text-[#8cdbab] dark:hover:not-disabled:bg-[#25472f]" type="button" onClick={onStop} disabled={isStopping}>
        {isStopping ? "Останавливаем…" : "Стоп"}
      </button>
    </div>
  );
}
