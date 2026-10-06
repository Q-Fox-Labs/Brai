// ABOUTME: Восстанавливает исходный компонент TaskRow.tsx из Brai September.
// ABOUTME: Использует локальный TasksContext; серверные операции задач отсутствуют.
import {
  Fragment,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { flushSync } from "react-dom";
import { isContainer, isCountedStatus, type OrderedTask } from "./model";
import { useTasks } from "./TasksContext";
import TaskBlockerSearch from "./TaskBlockerSearch";
import TaskContent from "./TaskContent";
import type { TaskDragArea } from "./use-task-drag";

function animateContainerToggle(
  area: TaskDragArea,
  taskId: string,
  toggle: () => void,
) {
  const scope = document.querySelector<HTMLElement>(`[data-task-drag-area="${area}"]`);
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!scope || reduceMotion) {
    toggle();
    return;
  }

  const rowsBefore = new Map(
    Array.from(scope.querySelectorAll<HTMLElement>("[data-task-row]"))
      .map((row) => [row.dataset.taskId ?? "", row.getBoundingClientRect()] as const),
  );

  flushSync(toggle);

  for (const row of scope.querySelectorAll<HTMLElement>("[data-task-row]")) {
    const previousBounds = rowsBefore.get(row.dataset.taskId ?? "");
    if (!previousBounds) {
      row.animate(
        [
          { opacity: 0, transform: "translateY(-8px)" },
          { opacity: 1, transform: "translateY(0)" },
        ],
        { duration: 170, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" },
      );
      continue;
    }

    const distance = previousBounds.top - row.getBoundingClientRect().top;
    if (Math.abs(distance) < 1) continue;
    row.animate(
      [
        { transform: `translateY(${distance}px)` },
        { transform: "translateY(0)" },
      ],
      { duration: 170, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" },
    );
  }

  const toggledRow = Array.from(scope.querySelectorAll<HTMLElement>("[data-task-row]"))
    .find((row) => row.dataset.taskId === taskId);
  toggledRow?.querySelector<HTMLElement>("[data-task-status-control]")?.animate(
    [
      { transform: "scale(0.72)" },
      { transform: "scale(1)" },
    ],
    { duration: 150, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" },
  );
}

/** Сохраняет разметку и взаимодействия исходного компонента September на локальных данных. */
export default function TaskRow({
  task,
  area = "left",
  isCollapsed,
  onToggleContainer,
}: {
  task: OrderedTask;
  area?: TaskDragArea;
  isCollapsed?: boolean;
  onToggleContainer?: (taskId: string) => void;
}) {
  const {
    blockedTaskIds,
    blockedTasksByBlocker,
    blockerSearchArea,
    blockerSearchTaskId,
    childTasksByParent,
    collapsedContainerIds,
    dragArea,
    draggedId,
    dropBesideNestedTask,
    dropBesideTopLevelContainer,
    dropIntoContainer,
    dropOutsideGoal,
    dropTarget,
    editingDetail,
    editingId,
    finishDragging,
    insertionEdge,
    isDraggingChild,
    isDraggingGoal,
    isDraggingQuest,
    isDraggingTask,
    isDraggingTopLevelContainer,
    isTaskChanging,
    openTaskInInspector,
    selectedTaskId,
    setDropTarget,
    startDragging,
    toggleContainer,
    updateTask,
  } = useTasks();
  const childTasks = childTasksByParent.get(task.id) ?? [];
  const canChangeKind = childTasks.length === 0;
  const isChild = task.nestingDepth > 0;
  const isLeft = area === "left";
  const isLocalDrag = dragArea === area;
  const isCollapsedContainer = isContainer(task) && (isLeft
    ? collapsedContainerIds.has(task.id)
    : Boolean(isCollapsed));
  const canDetachHere = isLeft
    && isLocalDrag
    && isDraggingChild
    && !isChild
    && !isContainer(task);
  const canInsertTaskHere = isLocalDrag && !isContainer(task)
    && Boolean(task.parentId)
    && isDraggingTask
    && draggedId !== task.id;
  const canInsertNestedGoalHere = isLocalDrag && task.isGoal
    && Boolean(task.parentId)
    && isDraggingGoal
    && draggedId !== task.id;
  const canInsertNestedQuestHere = isLocalDrag && task.isQuest
    && Boolean(task.parentId)
    && isDraggingQuest
    && draggedId !== task.id;
  const canDropIntoGoal = isLocalDrag && task.isGoal && isDraggingTask;
  const canDropIntoQuest = isLocalDrag && task.isQuest && isDraggingGoal;
  const canDropIntoMission = isLocalDrag && task.isMission && isDraggingQuest;
  const canInsertTopLevelContainerHere = isLeft && isLocalDrag && !task.parentId
    && isContainer(task)
    && isDraggingTopLevelContainer
    && !canDropIntoGoal
    && !canDropIntoQuest
    && !canDropIntoMission
    && draggedId !== task.id;
  const targets = {
    outside: `${area}-outside-${task.id}`,
    before: `${area}-insert-before-${task.id}`,
    after: `${area}-insert-after-${task.id}`,
    goalBefore: `${area}-insert-goal-before-${task.id}`,
    goalAfter: `${area}-insert-goal-after-${task.id}`,
    questBefore: `${area}-insert-quest-before-${task.id}`,
    questAfter: `${area}-insert-quest-after-${task.id}`,
    containerBefore: `${area}-insert-container-before-${task.id}`,
    containerAfter: `${area}-insert-container-after-${task.id}`,
    into: `${area}-into-${task.id}`,
  };
  const isContainerDropTarget = (canDropIntoGoal || canDropIntoQuest || canDropIntoMission)
    && dropTarget === targets.into;
  const isOutsideDropTarget = canDetachHere && dropTarget === targets.outside;
  const isInsertBefore = canInsertTaskHere && dropTarget === targets.before;
  const isInsertAfter = canInsertTaskHere && dropTarget === targets.after;
  const isInsertGoalBefore = canInsertNestedGoalHere && dropTarget === targets.goalBefore;
  const isInsertGoalAfter = canInsertNestedGoalHere && dropTarget === targets.goalAfter;
  const isInsertQuestBefore = canInsertNestedQuestHere && dropTarget === targets.questBefore;
  const isInsertQuestAfter = canInsertNestedQuestHere && dropTarget === targets.questAfter;
  const isInsertContainerBefore = canInsertTopLevelContainerHere
    && dropTarget === targets.containerBefore;
  const isInsertContainerAfter = canInsertTopLevelContainerHere
    && dropTarget === targets.containerAfter;
  const isDraggable = !task.isDraft
    && !isTaskChanging(task.id)
    && editingId !== task.id
    && editingDetail?.taskId !== task.id;
  const isBlocked = blockedTaskIds.has(task.id);
  const checkboxToneClass = task.isMission
    ? "pointer-events-none border-[3px] border-brai-mission checked:!border-brai-mission checked:!bg-brai-mission-fill"
    : task.isQuest
      ? "pointer-events-none border-brai-quest checked:!border-brai-quest checked:!bg-brai-quest-fill"
      : task.isGoal
        ? "pointer-events-none border-brai-goal checked:!border-brai-goal checked:!bg-brai-goal-fill"
        : "border-brai-muted checked:border-brai-accent checked:bg-brai-accent";
  const blockedTasks = blockedTasksByBlocker.get(task.id) ?? [];
  const primaryBlockedTask = blockedTasks[0];
  const nestingClassName = [
    "",
    "ml-[34px] w-[calc(100%-34px)]",
    "ml-[68px] w-[calc(100%-68px)]",
    "ml-[102px] w-[calc(100%-102px)]",
  ][task.nestingDepth] ?? "";
  const insertionOffsetClassName = [
    "before:left-0 after:left-0",
    "before:left-[-34px] after:left-[-34px]",
    "before:left-[-68px] after:left-[-68px]",
    "before:left-[-102px] after:left-[-102px]",
  ][task.nestingDepth] ?? "";
  const kindClassName = task.isMission
    ? "cursor-pointer border-l-[3px] border-l-brai-mission bg-brai-mission/10 pl-[15px] hover:bg-brai-mission/15"
    : task.isQuest
      ? "cursor-pointer hover:bg-brai-quest/10"
      : task.isGoal
        ? "cursor-pointer hover:bg-brai-goal/10"
        : "";
  const dropClassName = isContainerDropTarget || isOutsideDropTarget
    ? task.isMission
      ? "bg-brai-mission/12 shadow-[inset_0_0_0_2px_var(--do-mission)]"
      : task.isQuest
        ? "bg-brai-quest/12 shadow-[inset_0_0_0_2px_var(--do-quest)]"
        : "bg-brai-goal/12 shadow-[inset_0_0_0_2px_var(--do-goal)]"
    : "";
  const rowInteractionProps = {
    role: "button",
    tabIndex: 0,
    onClick: (event: MouseEvent<HTMLElement>) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("button, input, textarea, a, [data-mission-timer], [data-task-editor-control]")) return;
      openTaskInInspector(task.id);
    },
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      if (event.target !== event.currentTarget) return;
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openTaskInInspector(task.id);
      }
    },
  };

  const toggleAreaContainer = () => {
    if (isLeft) toggleContainer(task.id);
    else onToggleContainer?.(task.id);
  };

  const toggleAreaContainerWithAnimation = () => {
    animateContainerToggle(area, task.id, toggleAreaContainer);
  };

  const showContainerToggleFeedback = (element: HTMLElement) => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    element.animate(
      [
        { backgroundColor: "color-mix(in srgb, var(--do-accent) 18%, transparent)" },
        { backgroundColor: "transparent" },
      ],
      { duration: 260, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" },
    );
  };

  return (
    <Fragment>
      <article
        {...rowInteractionProps}
        id={isLeft ? `task-${task.id}` : undefined}
        className={[
          "relative flex min-h-[54px] cursor-grab items-start gap-2 border-b border-brai-line px-3 py-2.5 transition-[opacity,background,box-shadow] duration-150 last:border-b-0 focus-visible:z-1",
          nestingClassName,
          kindClassName,
          isContainer(task) && isDraggable ? "cursor-grab" : "",
          blockerSearchTaskId === task.id && blockerSearchArea === area
            ? "border-b-0 pb-2"
            : "",
          isLeft && selectedTaskId === task.id ? "z-1 rounded-lg bg-brai-surface-hover shadow-[inset_3px_0_0_var(--do-accent)]" : "",
          isLocalDrag && draggedId === task.id ? "cursor-grabbing opacity-20" : "",
          dropClassName,
          task.isGoal ? "focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-brai-goal/55" : "",
          task.isQuest ? "focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-brai-quest/55" : "",
          task.isMission ? "focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-brai-mission/55" : "",
          isInsertBefore || isInsertGoalBefore || isInsertQuestBefore || isInsertContainerBefore
            ? `before:absolute before:z-4 before:right-0 before:top-[-2px] before:h-1 before:rounded-sm before:bg-brai-accent before:shadow-[0_0_0_1px_var(--do-card),0_0_10px_var(--do-accent)] before:content-[''] ${insertionOffsetClassName}`
            : "",
          isInsertAfter || isInsertGoalAfter || isInsertQuestAfter || isInsertContainerAfter
            ? `after:absolute after:z-4 after:right-0 after:bottom-[-2px] after:h-1 after:rounded-sm after:bg-brai-accent after:shadow-[0_0_0_1px_var(--do-card),0_0_10px_var(--do-accent)] after:content-[''] ${insertionOffsetClassName}`
            : "",
        ].filter(Boolean).join(" ")}
        data-selected={isLeft && selectedTaskId === task.id}
        data-task-row
        data-task-id={task.id}
        draggable={isDraggable}
        onDragStart={(event) => startDragging(event, task, area)}
        onDragEnd={finishDragging}
        onDragOver={(event) => {
          if (canInsertTopLevelContainerHere) {
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            setDropTarget(insertionEdge(event) === "before"
              ? targets.containerBefore
              : targets.containerAfter);
          } else if (canInsertNestedGoalHere) {
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            setDropTarget(insertionEdge(event) === "before" ? targets.goalBefore : targets.goalAfter);
          } else if (canInsertNestedQuestHere) {
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            setDropTarget(insertionEdge(event) === "before" ? targets.questBefore : targets.questAfter);
          } else if (canDropIntoGoal || canDropIntoQuest || canDropIntoMission) {
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            setDropTarget(targets.into);
          } else if (canInsertTaskHere) {
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            setDropTarget(insertionEdge(event) === "before" ? targets.before : targets.after);
          } else if (canDetachHere) {
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            setDropTarget(targets.outside);
          }
        }}
        onDragLeave={(event) => {
          const nextTarget = event.relatedTarget as Node | null;
          if (nextTarget && event.currentTarget.contains(nextTarget)) return;
          const taskTargets = Object.values(targets);
          setDropTarget((current) => taskTargets.includes(current ?? "") ? null : current);
        }}
        onDrop={(event) => {
          if (canInsertTopLevelContainerHere) {
            void dropBesideTopLevelContainer(event, task);
          } else if (canInsertNestedGoalHere || canInsertNestedQuestHere || canInsertTaskHere) {
            void dropBesideNestedTask(event, task);
          } else if (canDropIntoMission || canDropIntoQuest || canDropIntoGoal) {
            void dropIntoContainer(event, task);
          } else if (canDetachHere) {
            void dropOutsideGoal(event);
          }
        }}
      >
        {isContainer(task) && (
          <button
            className={`group/collapse absolute inset-y-0 cursor-pointer border-0 bg-transparent p-0 focus-visible:z-2 focus-visible:outline-2 focus-visible:outline-offset-[-2px] ${task.isMission ? "left-[-7px] w-[50px]" : "left-0 w-[50px]"}`}
            type="button"
            data-task-collapse-control
            aria-label={`${isCollapsedContainer ? "Развернуть" : "Свернуть"} ${task.isMission ? "миссию" : task.isQuest ? "квест" : "цель"} «${task.title}»`}
            aria-expanded={!isCollapsedContainer}
            onClick={(event) => {
              showContainerToggleFeedback(event.currentTarget);
              toggleAreaContainerWithAnimation();
            }}
            onDragStart={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
          >
            <span
              className="pointer-events-none absolute top-[39px] left-[18px] grid h-[15px] w-[19px] place-items-center text-brai-muted opacity-0 transition-opacity duration-150 group-hover/collapse:opacity-55 group-focus-visible/collapse:opacity-55"
              aria-hidden="true"
            >
              <svg
                className={`size-[13px] fill-none stroke-current stroke-[1.8] transition-transform duration-170 [stroke-linecap:round] [stroke-linejoin:round] ${isCollapsedContainer ? "" : "rotate-180"}`}
                viewBox="0 0 18 18"
              >
                <path d="m5 7 4 4 4-4" />
              </svg>
            </span>
          </button>
        )}
        <span data-task-status-control className={`relative z-1 mt-0.5 size-[19px] shrink-0 ${isContainer(task) ? "pointer-events-none" : ""} ${isCountedStatus(task.status) ? isContainer(task) ? "opacity-[0.68]" : "opacity-[0.42]" : ""}`}>
          <input
            className={[
              "size-full appearance-none rounded border-2 bg-brai-field disabled:cursor-wait",
              checkboxToneClass,
              isBlocked && !isCountedStatus(task.status) ? "bg-[radial-gradient(circle,var(--do-danger)_0_2.5px,transparent_3px)] bg-[length:100%_100%]" : "",
              task.status === "not_completed" ? "!border-brai-danger !bg-brai-field checked:!border-brai-danger checked:!bg-brai-field" : "",
            ].filter(Boolean).join(" ")}
            type="checkbox"
            checked={isCountedStatus(task.status)}
            onChange={isContainer(task) || task.isDraft ? undefined : (event) => {
              const status = event.target.checked ? "completed" : "active";
              void updateTask(task.id, { status }, "Не удалось изменить задачу");
            }}
            disabled={isContainer(task) || task.isDraft || isTaskChanging(task.id) || isBlocked}
            aria-label={isBlocked
              ? `Элемент «${task.title}» ждёт выполнения блокера`
              : task.isMission
                ? `Статус миссии «${task.title}»`
                : task.isQuest
                  ? `Статус квеста «${task.title}»`
                  : task.isGoal
                    ? `Статус цели «${task.title}»`
                    : `${isCountedStatus(task.status) ? "Вернуть" : "Выполнить"} задачу «${task.title}»`}
          />
          {isCountedStatus(task.status) && (
            <span
              aria-hidden="true"
              className={`pointer-events-none absolute inset-0 grid place-items-center text-sm leading-none font-bold ${task.status === "not_completed" ? "text-brai-danger" : isContainer(task) ? "text-[#191b19]" : "text-primary-foreground"}`}
            >
              {task.status === "not_completed" ? "×" : "✓"}
            </span>
          )}
        </span>
        <TaskContent
          task={task}
          childTasks={childTasks}
          primaryBlockedTask={primaryBlockedTask}
          blockedTasks={blockedTasks}
          canChangeKind={canChangeKind}
          isBlocked={isBlocked}
          area={area}
        />
      </article>
      {blockerSearchTaskId === task.id && blockerSearchArea === area && (
        <TaskBlockerSearch task={task} />
      )}
    </Fragment>
  );
}
