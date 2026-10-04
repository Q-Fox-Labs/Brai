// ABOUTME: Восстанавливает исходный компонент TaskBlockerSearch.tsx из Brai September.
// ABOUTME: Использует локальный TasksContext; серверные операции задач отсутствуют.
import { isCountedStatus, taskKind, type OrderedTask } from "./model";
import { useTasks } from "./TasksContext";
import { normalizedSearchText } from "./task-ui";

/** Сохраняет разметку и взаимодействия исходного компонента September на локальных данных. */
export default function TaskBlockerSearch({ task }: { task: OrderedTask }) {
  const {
    blockerQuery,
    blockerSearchInputRef,
    blockerSearchResults,
    closeBlockerSearch,
    isTaskChanging,
    selectBlocker,
    setBlockerQuery,
  } = useTasks();
  const nestingClassName = [
    "pl-[50px]",
    "ml-[34px] w-[calc(100%-34px)] pl-12",
    "ml-[68px] w-[calc(100%-68px)] pl-12",
    "ml-[102px] w-[calc(100%-102px)] pl-12",
  ][task.nestingDepth] ?? "pl-[50px]";

  return (
    <section
      className={`border-b border-brai-line pt-0 pr-[18px] pb-[14px] ${nestingClassName}`}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) closeBlockerSearch();
      }}
    >
      <label className="sr-only" htmlFor={`blocker-search-${task.id}`}>
        Выбрать блокер для «{task.title}»
      </label>
      <input
        ref={blockerSearchInputRef}
        className="block h-[34px] w-full rounded-[7px] border border-brai-line bg-brai-surface-soft px-2.5 text-[13px] text-brai-ink outline-none focus:border-brai-accent/50"
        id={`blocker-search-${task.id}`}
        type="search"
        value={blockerQuery}
        onChange={(event) => setBlockerQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && blockerSearchResults[0]) {
            event.preventDefault();
            void selectBlocker(blockerSearchResults[0].task.id);
          }
          if (event.key === "Escape") {
            event.preventDefault();
            closeBlockerSearch();
          }
        }}
        placeholder="Начните вводить блокер"
        aria-controls={`blocker-results-${task.id}`}
        aria-activedescendant={blockerSearchResults[0]
          ? `blocker-result-${blockerSearchResults[0].task.id}`
          : undefined}
        autoComplete="off"
        disabled={isTaskChanging(task.id)}
      />
      {normalizedSearchText(blockerQuery).length >= 3 && (
        blockerSearchResults.length > 0 ? (
          <ul className="m-0 mt-1 list-none rounded-lg border border-brai-line bg-brai-card p-1" id={`blocker-results-${task.id}`} role="listbox">
            {blockerSearchResults.map((result, index) => {
              const kind = taskKind(result.task);
              return (
                <li
                  className=""
                  id={`blocker-result-${result.task.id}`}
                  key={result.task.id}
                  role="option"
                  aria-selected={index === 0}
                >
                  <button
                    aria-disabled={result.isUnavailable}
                    className={`flex w-full items-center gap-2 rounded-[5px] border-0 bg-transparent px-2 py-1.5 text-left text-[13px] text-brai-ink hover:bg-brai-surface-hover focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brai-accent/35 disabled:cursor-wait disabled:opacity-65 ${index === 0 ? "bg-brai-surface-hover" : ""} ${result.isUnavailable ? "cursor-not-allowed text-brai-muted" : ""}`}
                    type="button"
                    disabled={isTaskChanging(task.id)}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => void selectBlocker(result.task.id)}
                  >
                    {result.isUnavailable && (
                      <span aria-hidden="true" className="relative inline-flex size-[11px] shrink-0 items-center justify-center rounded-full border-[1.5px] border-brai-muted after:absolute after:h-[1.5px] after:w-3 after:rotate-[-45deg] after:bg-brai-muted after:content-['']" />
                    )}
                    <span className={`min-w-0 flex-1 ${isCountedStatus(result.task.status) ? "opacity-[0.52] line-through" : ""}`}>
                      <span className="mr-2 font-mono text-[11px] tabular-nums text-brai-muted">
                        {result.task.publicId}
                      </span>
                      {result.task.title}
                    </span>
                    <span
                      aria-label={kind.label}
                      className={`size-[9px] shrink-0 rounded-full ${kind.kind === "mission" ? "bg-brai-mission-fill" : kind.kind === "quest" ? "bg-brai-quest-fill" : kind.kind === "goal" ? "bg-brai-goal-fill" : "bg-brai-muted"}`}
                      role="img"
                    />
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="mt-1.5 mb-0 text-[13px] text-brai-muted">Совпадений нет</p>
        )
      )}
    </section>
  );
}
