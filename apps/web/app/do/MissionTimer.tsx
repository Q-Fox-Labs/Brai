// ABOUTME: Восстанавливает исходный компонент MissionTimer.tsx из Brai September.
// ABOUTME: Использует локальный TasksContext; серверные операции задач отсутствуют.
import {
  formatCompactDuration,
  type TimeSession,
  useTimerNow,
} from "./demo-timer";
import { Button } from "@/components/ui/button";

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
    <div data-mission-timer className="my-1 inline-flex min-h-7 items-center gap-2 text-brai-mission">
      <span className="text-sm font-bold tabular-nums" role="timer" aria-label={`Таймер миссии: ${duration}`}>
        {duration}
      </span>
      <Button className="h-7 rounded-md border-brai-mission/40 bg-brai-mission/10 px-2.5 text-xs font-semibold text-brai-mission hover:bg-brai-mission/15" variant="outline" size="xs" type="button" onClick={onStop} disabled={isStopping}>
        {isStopping ? "Останавливаем…" : "Стоп"}
      </Button>
    </div>
  );
}
