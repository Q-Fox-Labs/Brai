// ABOUTME: Восстанавливает исходный компонент TaskContent.tsx из Brai September.
// ABOUTME: Использует локальный TasksContext; серверные операции задач отсутствуют.
import { detailOffsetAtPoint } from "./task-ui";
import { formatShortDateTime } from "./format";
import { isContainer, isCountedStatus, taskKind, type OrderedTask } from "./model";
import type { Task } from "./types";
import { useTasks } from "./TasksContext";
import MissionTimer from "./MissionTimer";
import TaskMenu from "./TaskMenu";
import TaskInlineDetail from "./TaskInlineDetail";
import type { TaskDragArea } from "./use-task-drag";
import { Textarea } from "@/components/ui/textarea";

function resizeTaskTitle(element: HTMLTextAreaElement) {
  element.style.height = "auto";
  const lineHeight = Number.parseFloat(window.getComputedStyle(element).lineHeight);
  element.style.height = `${Math.min(element.scrollHeight, lineHeight * 2)}px`;
}

/** Сохраняет разметку и взаимодействия исходного компонента September на локальных данных. */
export default function TaskContent({
  task,
  childTasks,
  primaryBlockedTask,
  blockedTasks,
  canChangeKind,
  isBlocked,
  area = "left",
}: {
  task: OrderedTask;
  childTasks: Task[];
  primaryBlockedTask?: Task;
  blockedTasks: Task[];
  canChangeKind: boolean;
  isBlocked: boolean;
  area?: TaskDragArea;
}) {
  const {
    activeSession,
    blockedTaskIds,
    editingId,
    editingTitleArea,
    isTaskChanging,
    isTimerMutating,
    openDescriptionFromTitle,
    openTaskInInspector,
    projects,
    previewTaskTitle,
    removeBlocker,
    revealTask,
    saveTaskTitle,
    startEditingTitle,
    splitTaskAtCursor,
    stopMissionTimer,
    selectedProjectFilter,
    taskTitleDrafts,
    titleElementKey,
    titleElementsRef,
  } = useTasks();
  const completedChildCount = childTasks.filter(
    (childTask) => isCountedStatus(childTask.status),
  ).length;
  const openLinkedTask = area === "right" ? openTaskInInspector : revealTask;
  const title = taskTitleDrafts.get(task.id) ?? task.title;
  const isEditingTitle = editingId === task.id && editingTitleArea === area;
  const project = task.projectId
    ? projects.find((candidate) => candidate.id === task.projectId) ?? null
    : null;
  const showProject = area === "left"
    && task.nestingDepth === 0
    && selectedProjectFilter === "all"
    && project;
  const showRootKindBadge = area === "left" && task.nestingDepth === 0;
  const rootKind = taskKind(task);
  const rootKindBadgeClassName = task.isMission
    ? "bg-brai-mission-fill text-[#191b19]"
    : task.isQuest
      ? "bg-brai-quest-fill text-[#191b19]"
      : task.isGoal
        ? "bg-brai-goal-fill text-[#191b19]"
        : "bg-brai-surface-soft text-brai-ink";
  const completedToneClassName = isCountedStatus(task.status)
    ? isContainer(task) ? "opacity-[0.68]" : "opacity-[0.42]"
    : "";

  return (
    <div className="min-w-0 flex-1">
      <div data-task-title-row className="flex w-full min-w-0 items-start">
        <div className={`flex min-w-0 flex-1 items-start ${completedToneClassName}`}>
          {task.publicId && (
            <span className="mt-[2px] mr-2 shrink-0 font-mono text-[11px] leading-[1.7] tabular-nums text-brai-muted">
              {task.publicId}
            </span>
          )}
          <Textarea
            ref={(element) => {
              const key = titleElementKey(task.id, area);
              if (element) titleElementsRef.current.set(key, element);
              else titleElementsRef.current.delete(key);
            }}
            bare
            className={`${isEditingTitle ? "block" : "hidden"} min-h-[1.45em] max-h-[2.9em] min-w-0 flex-1 resize-none overflow-y-auto rounded border-0 bg-transparent p-0 text-sm leading-5 wrap-anywhere outline-none focus:bg-brai-surface-focus focus:shadow-[0_0_0_3px_var(--do-surface-focus)]`}
            value={title}
            aria-label={`Название задачи «${task.title}»`}
            spellCheck
            rows={1}
            readOnly={!isEditingTitle || isTaskChanging(task.id)}
            draggable={false}
            onClick={(event) => {
              event.stopPropagation();
            }}
            onDragStart={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onFocus={(event) => {
              resizeTaskTitle(event.currentTarget);
              startEditingTitle(task.id, area);
            }}
            onBlur={(event) => void saveTaskTitle(task, event.currentTarget)}
            onChange={(event) => {
              resizeTaskTitle(event.currentTarget);
              previewTaskTitle(task.id, event.currentTarget.value);
            }}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Enter") {
                event.preventDefault();
                if (event.shiftKey) {
                  void openDescriptionFromTitle(task, event.currentTarget, area);
                } else {
                  void splitTaskAtCursor(task, event.currentTarget, event.metaKey, area);
                }
              }
              if (event.key === "Escape") {
                event.preventDefault();
                event.currentTarget.value = task.title;
                event.currentTarget.blur();
              }
            }}
          />
          {!isEditingTitle && (
            <button
              className="line-clamp-2 max-h-[2.9em] min-w-0 flex-1 overflow-hidden border-0 bg-transparent p-0 text-left text-[15px] leading-[1.45] text-ellipsis wrap-anywhere text-inherit"
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                // AIDEV-NOTE: Клик сохраняет позицию, как в исходном редакторе описания.
                const caret = event.detail === 0
                  ? title.length
                  : detailOffsetAtPoint(event.currentTarget, event.clientX, event.clientY);
                startEditingTitle(task.id, area);
                window.requestAnimationFrame(() => {
                  const element = titleElementsRef.current.get(titleElementKey(task.id, area));
                  if (!element) return;
                  resizeTaskTitle(element);
                  element.focus();
                  element.setSelectionRange(caret, caret);
                });
              }}
            >
              {title}
            </button>
          )}
          {primaryBlockedTask ? (
            <a
              aria-label={`Перейти к записи «${primaryBlockedTask.title}»`}
              className="relative z-1 ml-1 inline-flex h-[22px] w-[18px] shrink-0 items-center justify-end text-base leading-none font-bold text-brai-quest no-underline hover:text-brai-quest/80 focus-visible:rounded-sm focus-visible:outline focus-visible:outline-current focus-visible:outline-offset-1 hover:after:block focus-visible:after:block after:absolute after:top-[calc(100%+3px)] after:right-[-6px] after:z-10 after:hidden after:w-max after:max-w-[min(280px,80vw)] after:rounded after:border after:border-brai-line after:bg-brai-card after:px-2 after:py-1.5 after:text-left after:text-xs after:leading-5 after:font-medium after:text-brai-ink after:content-[attr(data-tooltip)] after:wrap-anywhere"
              draggable={false}
              href={`#task-${primaryBlockedTask.id}`}
              data-tooltip={blockedTasks.map((blockedTask) => blockedTask.title).join(", ")}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                openLinkedTask(primaryBlockedTask.id);
              }}
              onDragStart={(event) => event.preventDefault()}
            >
              <span aria-hidden="true">→</span>
            </a>
          ) : (
            <span aria-hidden="true" className="ml-1 h-[22px] w-[18px] shrink-0" />
          )}
        </div>
        <TaskMenu task={task} canChangeKind={canChangeKind} isBlocked={isBlocked} area={area} />
      </div>
      <div className={completedToneClassName}>
      <TaskInlineDetail task={task} field="description" area={area} />
      <TaskInlineDetail task={task} field="result" area={area} />
      <div className="mt-1 flex items-start gap-1.5 text-[12px] leading-[1.4] text-brai-muted">
        {showRootKindBadge && (
          <span className={`inline-flex min-h-[18px] items-center rounded-[5px] px-1.5 py-px text-[10px] leading-none font-bold tracking-[0.03em] uppercase ${rootKindBadgeClassName}`}>
            {rootKind.label}
          </span>
        )}
        {showProject && (
          <span className="inline-flex min-h-[18px] max-w-[180px] items-center overflow-hidden rounded-[5px] bg-brai-accent/15 px-1.5 py-px text-[10px] leading-none font-bold text-brai-accent text-ellipsis whitespace-nowrap">
            {project.title}
          </span>
        )}
        <time dateTime={new Date(task.createdAt).toISOString()}>
          {formatShortDateTime(task.createdAt)}
        </time>
        {task.blockers.length > 0 && (
          <div className="min-w-0 flex-1 grid gap-0.5">
            {task.blockers.map((blocker) => {
              const kind = taskKind(blocker);
              const isCompleted = isCountedStatus(blocker.status);
              return (
                <div className="group/blocker flex min-w-0 items-center gap-1 text-brai-danger" key={blocker.id}>
                  <button
                    aria-label={`Удалить блокер: ${blocker.title}`}
                    className="relative mr-1 inline-flex size-[15px] shrink-0 items-center justify-center border-0 bg-transparent p-0 text-inherit disabled:cursor-wait focus-visible:outline focus-visible:outline-current focus-visible:outline-offset-2"
                    disabled={isTaskChanging(task.id)}
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      void removeBlocker(task.id, blocker.id);
                    }}
                  >
                    <span
                      aria-hidden="true"
                      className={[
                        "inline-flex size-[15px] items-center justify-center leading-none align-[-2px] transition-opacity group-hover/blocker:opacity-0 group-focus-within/blocker:opacity-0",
                        isCompleted
                          ? "rounded-sm border-[1.5px] border-brai-line bg-brai-surface-soft text-xs font-extrabold text-brai-ink"
                          : "rounded-full border border-brai-danger bg-brai-danger before:block before:h-1 before:w-[9px] before:rounded-sm before:bg-destructive-foreground before:content-['']",
                        isCompleted && kind.kind === "goal" ? "border-brai-goal bg-brai-goal-fill text-[#191b19]" : "",
                        isCompleted && kind.kind === "quest" ? "border-brai-quest bg-brai-quest-fill text-[#191b19]" : "",
                        isCompleted && kind.kind === "mission" ? "border-brai-mission bg-brai-mission-fill text-[#191b19]" : "",
                      ].filter(Boolean).join(" ")}
                    >
                      {isCompleted ? "✓" : null}
                    </span>
                    <span aria-hidden="true" className="pointer-events-none absolute inset-0 flex items-center justify-center text-lg leading-none font-normal text-brai-danger opacity-0 group-hover/blocker:opacity-100 group-focus-within/blocker:opacity-100">×</span>
                  </button>
                  <a
                    aria-label={`Блокер: ${blocker.title} (${kind.label}${isCompleted ? ", выполнен" : ""})`}
                    className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-inherit no-underline hover:underline"
                    draggable={false}
                    href={`#task-${blocker.id}`}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      openLinkedTask(blocker.id);
                    }}
                    onDragStart={(event) => event.preventDefault()}
                  >
                    {blocker.publicId} · {blocker.title}
                  </a>
                </div>
              );
            })}
          </div>
        )}
      </div>
      {task.isMission && activeSession?.missionId === task.id && (
        <MissionTimer
          session={activeSession}
          isStopping={isTimerMutating}
          onStop={() => void stopMissionTimer()}
        />
      )}
      {isContainer(task) && (
        <div
          className="mt-[7px] flex min-h-2.5 flex-wrap items-center gap-[5px]"
          role="img"
          aria-label={childTasks.length === 0
            ? `У ${task.isMission ? "миссии" : task.isQuest ? "квеста" : "цели"} пока нет ${task.isMission ? "квестов" : task.isQuest ? "целей" : "задач"}`
            : `Выполнено ${task.isMission ? "квестов" : task.isQuest ? "целей" : "задач"}: ${completedChildCount} из ${childTasks.length}`}
        >
          {childTasks.length === 0 ? (
            <span className="relative size-[9px] shrink-0 rounded-full border border-brai-muted before:absolute before:top-[3px] before:left-[-2px] before:h-px before:w-[11px] before:rotate-[-45deg] before:rounded before:bg-brai-muted before:content-['']" aria-hidden="true" />
          ) : childTasks.map((childTask, index) => (
            <span
              className={[
                "relative size-[9px] shrink-0 rounded-full border border-brai-goal",
                task.isQuest ? "border-brai-quest" : "",
                task.isMission ? "border-brai-mission" : "",
                index < completedChildCount
                  ? task.isMission
                    ? "bg-brai-mission-fill"
                    : task.isQuest
                      ? "bg-brai-quest-fill"
                      : "bg-brai-goal-fill"
                  : "",
                blockedTaskIds.has(childTask.id) && !isCountedStatus(childTask.status)
                  ? "after:absolute after:top-1/2 after:left-1/2 after:size-[3px] after:-translate-x-1/2 after:-translate-y-1/2 after:rounded-full after:bg-brai-danger after:content-['']"
                  : "",
              ].filter(Boolean).join(" ")}
              aria-hidden="true"
              key={childTask.id}
            />
          ))}
        </div>
      )}
      </div>
    </div>
  );
}
