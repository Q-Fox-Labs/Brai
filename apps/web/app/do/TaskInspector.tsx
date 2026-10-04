// ABOUTME: Восстанавливает исходный компонент TaskInspector.tsx из Brai September.
// ABOUTME: Использует локальный TasksContext; серверные операции задач отсутствуют.
import { useState } from "react";
import { formatShortDateTime } from "./format";
import { isContainer, isCountedStatus, taskKind } from "./model";
import TaskAgentButton from "./TaskAgentButton";
import TaskAgentPanel from "./TaskAgentPanel";
import TaskComments from "./TaskComments";
import TaskDetail from "./TaskDetail";
import TaskHistory from "./TaskHistory";
import TaskStructure from "./TaskStructure";
import { useTasks } from "./TasksContext";
import type { Task } from "./types";

const inspectorTabs = [
  { id: "details", label: "Подробности" },
  { id: "connections", label: "Связи" },
  { id: "comments", label: "Комментарии" },
  { id: "history", label: "История" },
  { id: "agent", label: "Агент" },
] as const;

type InspectorTab = typeof inspectorTabs[number]["id"];

function TaskConnections({
  task,
  blockedTasks,
  onOpenTask,
}: {
  task: Task;
  blockedTasks: Task[];
  onOpenTask: (taskId: string) => void;
}) {
  if (task.blockers.length === 0 && blockedTasks.length === 0) {
    return <p className="m-0 text-[13px] text-brai-muted">Взаимосвязей пока нет</p>;
  }

  return (
    <div className="grid gap-2">
      {task.blockers.map((blocker) => (
        <button
          className="w-full rounded-lg border border-brai-line bg-brai-surface-subtle px-3 py-2.5 text-left text-[13px] text-brai-ink hover:bg-brai-surface-soft focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brai-accent/40"
          type="button"
          key={`blocker-${blocker.id}`}
          aria-label={`Открыть блокер «${blocker.title}»`}
          onClick={() => onOpenTask(blocker.id)}
        >
          <span className="mr-2 text-brai-muted">Блокер:</span>
          <span className="mr-2 font-mono text-[11px] tabular-nums text-brai-muted">
            {blocker.publicId}
          </span>
          {blocker.title}
        </button>
      ))}
      {blockedTasks.map((blockedTask) => (
        <button
          className="w-full rounded-lg border border-brai-line bg-brai-surface-subtle px-3 py-2.5 text-left text-[13px] text-brai-ink hover:bg-brai-surface-soft focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brai-accent/40"
          type="button"
          key={`blocked-${blockedTask.id}`}
          aria-label={`Открыть зависимый элемент «${blockedTask.title}»`}
          onClick={() => onOpenTask(blockedTask.id)}
        >
          <span className="mr-2 text-brai-muted">Зависит:</span>
          <span className="mr-2 font-mono text-[11px] tabular-nums text-brai-muted">
            {blockedTask.publicId}
          </span>
          {blockedTask.title}
        </button>
      ))}
    </div>
  );
}

/** Сохраняет разметку и взаимодействия исходного компонента September на локальных данных. */
export default function TaskInspector() {
  const [activeTab, setActiveTab] = useState<InspectorTab>("details");
  const [commentCount, setCommentCount] = useState(0);
  const {
    blockedTasksByBlocker,
    blockedTaskIds,
    dragArea,
    editingId,
    editingTitleArea,
    isTaskChanging,
    openTaskInInspector,
    previewTaskTitle,
    saveTaskTitle,
    selectedTask: task,
    startEditingTitle,
    setSelectedTaskId,
    stopDragScrolling,
    taskTitleDrafts,
    updateTask,
    updateDragScrolling,
  } = useTasks();

  if (!task) {
    return (
      <section
        className="flex h-full min-h-[220px] items-center justify-center rounded-2xl border border-brai-line bg-brai-card px-5 py-8 max-[800px]:rounded-b-none max-[800px]:rounded-t-[20px]"
        aria-live="polite"
      >
        <p className="m-0 text-center text-[13px] text-brai-muted">
          Выберите элемент слева
        </p>
      </section>
    );
  }

  const kind = taskKind(task);
  const blockedTasks = blockedTasksByBlocker.get(task.id) ?? [];
  const isBlocked = blockedTaskIds.has(task.id);
  const isCompleted = task.status === "completed";
  const canRunAgent = !isContainer(task) && task.status === "active";
  const kindClassName = task.isMission
    ? "border-brai-mission/35 bg-brai-mission/14 text-brai-mission"
    : task.isQuest
      ? "border-brai-quest/35 bg-brai-quest/14 text-brai-quest"
      : task.isGoal
        ? "border-brai-goal/35 bg-brai-goal/16 text-brai-goal"
        : "border-brai-muted/30 bg-brai-surface-soft text-brai-ink";
  const checkboxToneClassName = task.isMission
    ? "border-[3px] border-brai-mission checked:!border-brai-mission checked:!bg-brai-mission-fill"
    : task.isQuest
      ? "border-brai-quest checked:!border-brai-quest checked:!bg-brai-quest-fill"
      : task.isGoal
        ? "border-brai-goal checked:!border-brai-goal checked:!bg-brai-goal-fill"
        : "border-brai-muted checked:border-brai-muted checked:bg-brai-muted";
  const selectTab = (tab: InspectorTab) => {
    setActiveTab(tab);
    window.requestAnimationFrame(() => {
      document.getElementById(`task-${task.id}-panel`)?.scrollTo({ top: 0 });
    });
  };

  return (
    <section
      className="flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-brai-line bg-brai-card max-[800px]:rounded-b-none max-[800px]:rounded-t-[20px]"
      aria-labelledby="selected-task-heading"
      aria-live="polite"
    >
      <header className={`shrink-0 border-b border-brai-line px-5 py-4 transition-colors ${isCompleted ? "bg-[#eaf8ef] dark:bg-[#173924]" : ""}`}>
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 flex-1 items-start gap-[13px]">
            <span className="relative mt-[5px] size-[19px] shrink-0">
              <input
                className={`size-full appearance-none rounded border-2 bg-brai-field disabled:cursor-wait ${checkboxToneClassName} ${task.status === "not_completed" ? "!border-[#c94432] !bg-brai-field checked:!border-[#c94432] checked:!bg-brai-field" : ""}`}
                type="checkbox"
                checked={isCountedStatus(task.status)}
                disabled={isContainer(task) || task.isDraft || isTaskChanging(task.id) || isBlocked}
                aria-label={isBlocked
                  ? `Элемент «${task.title}» ждёт выполнения блокера`
                  : `${isCountedStatus(task.status) ? "Вернуть" : "Выполнить"} элемент «${task.title}»`}
                onChange={isContainer(task) || task.isDraft ? undefined : (event) => {
                  const status = event.target.checked ? "completed" : "active";
                  void updateTask(task.id, { status }, "Не удалось изменить задачу");
                }}
              />
              {isCountedStatus(task.status) && (
                <span
                  aria-hidden="true"
                  className={`pointer-events-none absolute inset-0 grid place-items-center text-[15px] leading-none font-bold ${task.status === "not_completed" ? "text-[#c94432]" : "text-white"}`}
                >
                  {task.status === "not_completed" ? "×" : "✓"}
                </span>
              )}
            </span>
            <div className="min-w-0 flex-1">
              <textarea
                className="[field-sizing:content] block min-h-[1.3em] w-full resize-none overflow-hidden rounded border-0 bg-transparent p-0 text-[22px] leading-[1.3] font-semibold tracking-[-0.02em] text-brai-ink wrap-anywhere outline-none read-only:cursor-text focus:bg-brai-surface-focus focus:shadow-[0_0_0_3px_var(--surface-focus)] disabled:cursor-wait disabled:opacity-65"
                id="selected-task-heading"
                value={taskTitleDrafts.get(task.id) ?? task.title}
                rows={1}
                maxLength={200}
                readOnly={editingId !== task.id || editingTitleArea !== "right"}
                disabled={isTaskChanging(task.id)}
                aria-label={`Название элемента «${task.title}»`}
                spellCheck
                onFocus={() => startEditingTitle(task.id, "right")}
                onChange={(event) => {
                  event.currentTarget.style.height = "auto";
                  event.currentTarget.style.height = `${event.currentTarget.scrollHeight}px`;
                  previewTaskTitle(task.id, event.currentTarget.value);
                }}
                onBlur={(event) => void saveTaskTitle(task, event.currentTarget)}
                onKeyDown={(event) => {
                  event.stopPropagation();
                  if (event.key === "Enter") {
                    event.preventDefault();
                    event.currentTarget.blur();
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    event.currentTarget.value = task.title;
                    event.currentTarget.blur();
                  }
                }}
              />
              <div className="mt-2.5 flex min-w-0 items-center justify-between gap-3 text-[13px] text-brai-muted">
                <div className="flex items-center gap-2">
                  <span className={`inline-flex min-h-8 shrink-0 items-center rounded-lg border px-3 py-1.5 text-[12px] font-bold tracking-[0.02em] uppercase ${kindClassName}`}>
                    {kind.label}
                  </span>
                  <span className="font-mono text-[12px] tabular-nums text-brai-muted">
                    {task.publicId}
                  </span>
                  {task.relativeNumber && (
                    <span
                      className="font-mono text-[12px] tabular-nums text-brai-muted"
                      title="Относительный номер в иерархии"
                    >
                      {task.relativeNumber}
                    </span>
                  )}
                </div>
                <time className="shrink-0 tabular-nums" dateTime={new Date(task.createdAt).toISOString()}>
                  {formatShortDateTime(task.createdAt)}
                </time>
              </div>
              {canRunAgent && (
                <div className="mt-3 flex justify-end">
                  <TaskAgentButton key={task.id} taskId={task.id} />
                </div>
              )}
            </div>
          </div>
          <button
            className="grid size-8 shrink-0 place-items-center rounded-lg border-0 bg-transparent text-[22px] leading-none font-light text-brai-muted hover:bg-brai-surface-soft hover:text-brai-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brai-accent/40"
            type="button"
            aria-label="Закрыть подробности"
            onClick={() => setSelectedTaskId(null)}
          >
            ×
          </button>
        </div>
      </header>

      <nav className="shrink-0 border-b border-brai-line px-5" aria-label="Разделы элемента">
        <div className="flex min-w-0 gap-6 overflow-x-auto" role="tablist" aria-label="Разделы элемента">
          {inspectorTabs.map((tab, index) => {
            const isActive = activeTab === tab.id;
            return (
              <button
                className={`relative min-h-11 shrink-0 border-0 border-b-2 bg-transparent px-0 text-[13px] font-medium transition-colors ${isActive ? "border-brai-accent text-brai-ink" : "border-transparent text-brai-muted hover:text-brai-ink"}`}
                type="button"
                role="tab"
                id={`task-${task.id}-${tab.id}-tab`}
                aria-controls={`task-${task.id}-panel`}
                aria-selected={isActive}
                tabIndex={isActive ? 0 : -1}
                key={tab.id}
                onClick={() => selectTab(tab.id)}
                onKeyDown={(event) => {
                  let nextIndex: number | null = null;
                  if (event.key === "ArrowRight") nextIndex = (index + 1) % inspectorTabs.length;
                  if (event.key === "ArrowLeft") nextIndex = (index - 1 + inspectorTabs.length) % inspectorTabs.length;
                  if (event.key === "Home") nextIndex = 0;
                  if (event.key === "End") nextIndex = inspectorTabs.length - 1;
                  if (nextIndex === null) return;

                  event.preventDefault();
                  const nextTab = inspectorTabs[nextIndex];
                  selectTab(nextTab.id);
                  window.requestAnimationFrame(() => {
                    document.getElementById(`task-${task.id}-${nextTab.id}-tab`)?.focus();
                  });
                }}
              >
                <span className="inline-flex items-center gap-1.5">
                  <span>{tab.label}</span>
                  {tab.id === "comments" && commentCount > 0 && (
                    <span className="font-mono text-[11px] tabular-nums" aria-label={`${commentCount} комментариев`}>
                      {commentCount}
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      </nav>

      <div
        className="grid min-h-0 flex-1 content-start gap-4 overscroll-contain overflow-y-auto px-5 py-4"
        id={`task-${task.id}-panel`}
        role="tabpanel"
        aria-labelledby={`task-${task.id}-${activeTab}-tab`}
        tabIndex={0}
        data-task-scroll-container
        data-task-drag-area="right"
        onDragOver={(event) => {
          if (dragArea !== "right") return;
          const bounds = event.currentTarget.getBoundingClientRect();
          if (event.clientY < bounds.top + 64) updateDragScrolling(event, "top");
          else if (event.clientY > bounds.bottom - 64) updateDragScrolling(event, "bottom");
          else stopDragScrolling();
        }}
        onDragLeave={(event) => {
          const nextTarget = event.relatedTarget as Node | null;
          if (!nextTarget || !event.currentTarget.contains(nextTarget)) stopDragScrolling();
        }}
      >
        <div className="grid gap-4" hidden={activeTab !== "details"}>
          <TaskDetail key={`${task.id}-description`} task={task} field="description" />
          <TaskDetail key={`${task.id}-result`} task={task} field="result" />
          {isContainer(task) && <TaskStructure key={task.id} task={task} />}
        </div>

        <div hidden={activeTab !== "connections"}>
          <TaskConnections
            task={task}
            blockedTasks={blockedTasks}
            onOpenTask={openTaskInInspector}
          />
        </div>

        <div hidden={activeTab !== "comments"}>
          <TaskComments key={task.id} taskId={task.id} onCountChange={setCommentCount} />
        </div>

        <div hidden={activeTab !== "history"}>
          <TaskHistory
            key={task.id}
            task={task}
            isActive={activeTab === "history"}
          />
        </div>

        <div hidden={activeTab !== "agent"}>
          <TaskAgentPanel
            key={task.id}
            taskId={task.id}
            canRun={canRunAgent}
            isActive={activeTab === "agent"}
          />
        </div>
      </div>
    </section>
  );
}
