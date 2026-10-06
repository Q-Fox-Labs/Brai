// ABOUTME: Сохраняет исходную компоновку списка и подробностей September.
// ABOUTME: Поиск по ID и позиции прокрутки используют только локальные данные.
import { type FormEvent, useLayoutEffect, useRef, useState } from "react";
import ErrorToast from "./ErrorToast";
import { useTasks } from "./TasksContext";
import TaskInspector from "./TaskInspector";
import TaskRow from "./TaskRow";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";

type TasksViewProps = {
  isProjectsDrawerOpen: boolean;
  isProjectsExpanded: boolean;
  onExpandProjects: () => void;
  onOpenProjectsDrawer: () => void;
};

function ProjectsButton({
  className,
  isExpanded,
  onClick,
}: {
  className: string;
  isExpanded: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      className={`${className} size-10 shrink-0 rounded-lg border-brai-line bg-brai-surface-subtle p-0 text-brai-muted hover:bg-brai-surface-soft hover:text-brai-ink [&_svg]:size-5 [&_svg]:fill-none [&_svg]:stroke-current [&_svg]:stroke-[1.7] [&_svg]:[stroke-linecap:round] [&_svg]:[stroke-linejoin:round]`}
      variant="outline"
      size="icon-lg"
      type="button"
      aria-label="Открыть меню проектов"
      aria-controls="task-projects-panel"
      aria-expanded={isExpanded}
      onClick={onClick}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M9 4v16M5.5 8h1" />
      </svg>
    </Button>
  );
}

function DetachZone({ position }: { position: "top" | "bottom" }) {
  const { dragArea, dropOutsideGoal, dropTarget, isDraggingChild, setDropTarget } = useTasks();
  if (dragArea !== "left" || !isDraggingChild) return null;
  const targetId = `left-outside-${position}`;
  const isDropTarget = dropTarget === targetId;
  return (
    <div
      className={`grid min-h-9 place-items-center border-b border-dashed text-[11px] transition-[background,color,border-color,box-shadow] duration-150 ${isDropTarget ? "border-brai-accent/70 bg-brai-accent/20 text-brai-ink shadow-[inset_0_0_0_1px_var(--accent)]" : "border-brai-accent/30 bg-brai-accent/10 text-brai-muted"}`}
      onDragEnter={() => setDropTarget(targetId)}
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
      }}
      onDragLeave={() => {
        setDropTarget((current) => current === targetId ? null : current);
      }}
      onDrop={(event) => void dropOutsideGoal(event)}
    >
      {position === "top" ? "Вынести из родителя выше" : "Вынести из родителя ниже"}
    </div>
  );
}

/** Воспроизводит исходные две панели, формы и мобильную панель September. */
export default function TasksView({
  isProjectsDrawerOpen,
  isProjectsExpanded,
  onExpandProjects,
  onOpenProjectsDrawer,
}: TasksViewProps) {
  const {
    addTask,
    tasks,
    dragArea,
    error,
    inputRef,
    isAdding,
    isLoading,
    orderedTasks,
    revealTask,
    selectedProjectFilter,
    selectedTask,
    setError,
    setSelectedTaskId,
    setTitle,
    stopDragScrolling,
    visibleTasks,
    title,
    updateDragScrolling,
  } = useTasks();
  const leftScrollRef = useRef<HTMLDivElement>(null);
  const [identifierQuery, setIdentifierQuery] = useState("");
  const isSearchingIdentifier = false;
  const scrollPositions = useRef(new Map<string, number>());

  async function findTaskByIdentifier(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const publicId = identifierQuery.trim();
    if (!/^[0-9]{3,6}$/.test(publicId) || isSearchingIdentifier) {
      if (!/^[0-9]{3,6}$/.test(publicId)) {
        setError("ID должен содержать от 3 до 6 цифр");
      }
      return;
    }

    const task = tasks.find(item => item.publicId === publicId);
    if (task) revealTask(task.id);
    else setError("Элемент с таким ID не найден");
  }

  useLayoutEffect(() => {
    if (isLoading || !leftScrollRef.current) return;
    leftScrollRef.current.scrollTop = scrollPositions.current.get(selectedProjectFilter) ?? 0;
  }, [isLoading, selectedProjectFilter]);

  return (
    <>
      <div className="relative grid h-full min-h-0 min-w-0 grid-cols-2 items-stretch gap-3 overflow-hidden max-[861px]:grid-cols-1">
        <Card
          render={<section aria-labelledby="tasks-heading" />}
          className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border-brai-line bg-brai-card shadow-sm"
        >
        <h1 className="sr-only" id="tasks-heading">Дела</h1>
        <div className="flex min-w-0 gap-2 border-b border-brai-line p-3 max-[480px]:flex-wrap">
        <form className="min-w-0 flex-1" onSubmit={(event) => void addTask(event)}>
          <div className="flex min-w-0 items-center gap-2.5">
            {!isProjectsExpanded && (
              <ProjectsButton
                className="grid max-[861px]:hidden"
                isExpanded={isProjectsExpanded}
                onClick={onExpandProjects}
              />
            )}
            <ProjectsButton
              className="hidden max-[861px]:grid"
              isExpanded={isProjectsDrawerOpen}
              onClick={onOpenProjectsDrawer}
            />
            <input
              ref={inputRef}
              className="h-10 min-w-0 flex-1 rounded-lg border border-brai-line bg-brai-surface-subtle px-3 text-sm text-brai-ink placeholder:text-brai-muted focus-visible:border-brai-accent/65 focus-visible:ring-2 focus-visible:ring-brai-accent/20"
              type="text"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Новая задача"
              aria-label="Название новой задачи"
              aria-busy={isAdding || undefined}
              maxLength={200}
              onKeyDown={(event) => {
                if (event.key === "Enter" && event.shiftKey) void addTask(event, true);
              }}
            />
          </div>
        </form>
        <form className="flex shrink-0 items-center gap-1.5 max-[480px]:w-full" onSubmit={findTaskByIdentifier}>
          <label className="sr-only" htmlFor="task-identifier-search">Найти элемент по ID</label>
          <Input
            className="h-10 w-[88px] rounded-lg border-brai-line bg-brai-surface-subtle px-3 font-mono text-sm tabular-nums text-brai-ink placeholder:font-sans placeholder:text-brai-muted max-[480px]:min-w-0 max-[480px]:flex-1"
            id="task-identifier-search"
            inputMode="numeric"
            autoComplete="off"
            maxLength={6}
            placeholder="ID"
            value={identifierQuery}
            onChange={(event) => setIdentifierQuery(event.target.value.replace(/\D/g, ""))}
            disabled={isSearchingIdentifier}
          />
          <Button
            className="size-10 rounded-lg border-brai-line bg-brai-surface-subtle p-0 text-brai-muted hover:bg-brai-surface-soft hover:text-brai-ink"
            variant="outline"
            size="icon-lg"
            type="submit"
            aria-label="Найти элемент по ID"
            disabled={isSearchingIdentifier}
          >
            <svg className="size-5 fill-none stroke-current stroke-[1.8] [stroke-linecap:round]" viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="11" cy="11" r="6" />
              <path d="m16 16 4 4" />
            </svg>
          </Button>
        </form>
        </div>
        <div
          ref={leftScrollRef}
          className="min-h-0 flex-1 overscroll-contain overflow-y-auto"
          data-task-scroll-container
          data-task-drag-area="left"
          aria-live="polite"
          onScroll={(event) => {
            scrollPositions.current.set(selectedProjectFilter, event.currentTarget.scrollTop);
          }}
          onDragOver={(event) => {
            if (dragArea !== "left") return;
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
          {isLoading ? (
            <p className="m-0 px-5 py-[22px] text-center text-[13px] text-brai-muted">Загружаем задачи…</p>
          ) : visibleTasks.length === 0 ? (
            <p className="m-0 px-5 py-[22px] text-center text-[13px] text-brai-muted">Пока нет задач</p>
          ) : (
            <>
              <DetachZone position="top" />
              {orderedTasks.map((task) => <TaskRow key={task.id} task={task} />)}
              <DetachZone position="bottom" />
            </>
          )}
        </div>
        </Card>
        <button
          className={`absolute inset-0 z-20 hidden border-0 bg-foreground/20 p-0 transition-opacity duration-200 max-[861px]:block ${selectedTask ? "visible opacity-100 pointer-events-auto" : "invisible opacity-0 pointer-events-none"}`}
          type="button"
          aria-label="Закрыть подробности"
          tabIndex={selectedTask ? 0 : -1}
          onClick={() => setSelectedTaskId(null)}
        />
        <aside
          id="task-inspector-sheet"
          data-task-inspector-sheet
          className={`h-full min-h-0 min-w-0 transition-[transform,visibility] duration-200 ease-out max-[861px]:absolute max-[861px]:inset-x-0 max-[861px]:bottom-0 max-[861px]:z-30 max-[861px]:h-[82%] max-[861px]:max-h-[680px] max-[861px]:overflow-hidden max-[861px]:rounded-t-2xl max-[861px]:shadow-xl ${selectedTask ? "max-[861px]:visible max-[861px]:translate-y-0" : "max-[861px]:invisible max-[861px]:translate-y-[calc(100%+16px)]"}`}
          aria-label="Подробности выбранного элемента"
        >
          <TaskInspector />
        </aside>
      </div>
      <ErrorToast message={error} onClose={() => setError("")} />
    </>
  );
}
