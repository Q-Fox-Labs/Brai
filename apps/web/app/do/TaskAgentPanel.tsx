"use client";
// ABOUTME: Сохраняет исходный вид панели агента задачи September.
// ABOUTME: Панель демо не запускает модель и не обращается к серверу.
import { formatShortDateTime } from "./format";
import { useTasks } from "./TasksContext";
type DemoAgentEvent = { id: string; message: string; createdAt: number; kind: string };

/** Показывает исходное состояние незапущенного агента на синтетических данных. */
export default function TaskAgentPanel({ canRun }: { taskId: string; canRun: boolean; isActive: boolean }) {
  const { setError } = useTasks();
  const effectiveStatus = { isRunning: false, isInterrupted: false, events: [] as DemoAgentEvent[] };
  const status = effectiveStatus;
  const isLoading = false, isStarting = false, elapsed = null;
  const statusLabel = () => "Не запускался";
  const taskAgentActionLabel = () => "Выполнить Агентом";
  const start = () => setError("Демонстрационные данные: запуск агента не подключён");
  return (
    <section className="grid gap-4" aria-label="Журнал агента">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-brai-line bg-brai-surface-subtle px-4 py-3">
        <div className="grid gap-1">
          <span className="text-[11px] font-medium tracking-[0.04em] text-brai-muted uppercase">
            Состояние
          </span>
          <div className="flex items-center gap-2 text-[14px] font-semibold text-brai-ink">
            <span className={`size-2 rounded-full ${effectiveStatus.isRunning ? "bg-brai-accent animate-pulse" : effectiveStatus.isInterrupted || effectiveStatus.events.at(-1)?.kind === "failed" ? "bg-brai-danger" : "bg-brai-muted/50"}`} />
            <span>{isLoading ? "Загрузка…" : statusLabel()}</span>
            {elapsed && <span className="font-mono text-[12px] font-normal tabular-nums text-brai-muted">{elapsed}</span>}
          </div>
        </div>
        {canRun && (
          <button
            className="rounded-lg border border-brai-accent/35 bg-brai-accent px-3 py-2 text-[13px] font-medium text-white hover:bg-brai-accent/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brai-accent/40 disabled:cursor-wait disabled:opacity-60"
            type="button"
            disabled={isLoading || isStarting || effectiveStatus.isRunning}
            onClick={() => void start()}
          >
            {taskAgentActionLabel()}
          </button>
        )}
      </div>

      {!canRun && (
        <p className="m-0 text-[13px] text-brai-muted">
          Запуск и продолжение доступны только для активных обычных задач.
        </p>
      )}

      {status.events.length === 0 ? (
        <p className="m-0 text-[13px] text-brai-muted">
          {isLoading ? "Загрузка журнала…" : "Журнал пока пуст"}
        </p>
      ) : (
        <ol className="m-0 grid list-none gap-2 p-0" aria-live="polite">
          {status.events.map((event) => (
            <li className="grid grid-cols-[auto_1fr] gap-x-3 rounded-lg border border-brai-line bg-brai-card px-3 py-2.5" key={event.id}>
              <span className="mt-1.5 size-2 rounded-full bg-brai-accent/70" aria-hidden="true" />
              <div className="min-w-0">
                <p className="m-0 text-[13px] leading-5 text-brai-ink">{event.message}</p>
                <time className="mt-1 block text-[11px] tabular-nums text-brai-muted" dateTime={new Date(event.createdAt).toISOString()}>
                  {formatShortDateTime(event.createdAt)}
                </time>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
