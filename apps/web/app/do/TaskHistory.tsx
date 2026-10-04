// ABOUTME: Сохраняет исходную разметку истории изменений September.
// ABOUTME: История содержит только изменения синтетических данных текущего экрана.
import { useTasks } from "./TasksContext";
import { formatShortDateTime } from "./format";
import type { Task } from "./types";

/** Отображает локальные изменения в исходной ленте истории. */
export default function TaskHistory({ task }: { task: Task; isActive: boolean }) {
  const { historyByTask } = useTasks();
  const events = historyByTask[task.id] ?? [];
  const isLoading = false;
  const loadHistory = () => {};
  return (
    <section aria-labelledby={`task-history-${task.id}`}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3
          className="m-0 text-[12px] font-bold tracking-[0.04em] text-brai-muted uppercase"
          id={`task-history-${task.id}`}
        >
          История
        </h3>
        <button
          className="rounded-md border-0 bg-transparent px-2 py-1 text-[12px] text-brai-muted hover:bg-brai-surface-soft hover:text-brai-ink disabled:cursor-wait disabled:opacity-50"
          type="button"
          disabled={isLoading}
          onClick={() => void loadHistory()}
        >
          Обновить
        </button>
      </div>

      {isLoading && events.length === 0 ? (
        <p className="m-0 text-[13px] text-brai-muted">Загрузка…</p>
      ) : events.length === 0 ? (
        <p className="m-0 text-[13px] text-brai-muted">
          История появится после первого изменения
        </p>
      ) : (
        <ol className="m-0 grid list-none gap-3 p-0">
          {events.map((event) => {
            const change = event.change;
            return (
              <li
                className="relative border-l border-brai-line pl-3 text-[13px] before:absolute before:top-1.5 before:-left-[4px] before:size-[7px] before:rounded-full before:bg-brai-accent"
                key={event.id}
              >
                <div className="font-semibold text-brai-ink">
                  {event.label}
                  {event.publicId && (
                    <span className="ml-2 font-mono text-[11px] font-normal tabular-nums text-brai-muted">
                      {event.publicId}
                    </span>
                  )}

                </div>
                {change && (
                  <div className="mt-1 line-clamp-3 whitespace-pre-wrap text-brai-text-secondary">
                    {change}
                  </div>
                )}
                <div className="mt-1 text-[11px] text-brai-muted">
                  <span>{"demo"}</span>
                  <span aria-hidden="true"> · </span>
                  <time dateTime={new Date(event.occurredAt).toISOString()}>
                    {formatShortDateTime(event.occurredAt)}
                  </time>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
