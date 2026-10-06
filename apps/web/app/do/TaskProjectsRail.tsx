"use client";
// ABOUTME: Восстанавливает исходный компонент TaskProjectsRail.tsx из Brai September.
// ABOUTME: Использует локальный TasksContext; серверные операции задач отсутствуют.


import { useMemo, useState } from "react";
import { isContainer, isCountedStatus, taskTreeProjectId } from "./model";
import { useTasks } from "./TasksContext";
import { Button } from "@/components/ui/button";

const itemClassName = "flex min-h-9 w-full items-center rounded-md border-0 bg-transparent px-2.5 text-left text-sm font-medium text-brai-ink hover:bg-brai-surface-soft aria-pressed:bg-brai-surface-soft aria-pressed:shadow-[inset_3px_0_0_var(--do-accent)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brai-accent/40";

/** Сохраняет разметку и взаимодействия исходного компонента September на локальных данных. */
export default function TaskProjectsRail({
  onClose,
  onSelectProject,
}: {
  onClose: () => void;
  onSelectProject: () => void;
}) {
  const {
    addProject,
    dragArea,
    draggedProjectId,
    dropProject,
    dropTaskOnProject,
    finishDraggingProject,
    isAddingProject,
    isProjectsLoading,
    projectDropTarget,
    projectInputRef,
    projects,
    projectTitle,
    selectedProjectFilter,
    setProjectDropTarget,
    setProjectTitle,
    setSelectedProjectFilter,
    startDraggingProject,
    taskById,
    tasks,
  } = useTasks();
  const [isCreating, setIsCreating] = useState(false);
  const isTaskDrag = dragArea !== null;
  const noProjectTarget = projectDropTarget === "task-none";
  const projectCounts = useMemo(() => {
    const counts = new Map<string, number>();
    let all = 0;
    let withoutProject = 0;
    for (const task of tasks) {
      if (isContainer(task) || isCountedStatus(task.status)) continue;
      all += 1;
      const projectId = taskTreeProjectId(task, taskById);
      if (!projectId) withoutProject += 1;
      else counts.set(projectId, (counts.get(projectId) ?? 0) + 1);
    }
    return { all, counts, withoutProject };
  }, [taskById, tasks]);
  const countClassName = "ml-auto shrink-0 pl-2 text-[11px] font-semibold tabular-nums text-brai-muted";

  return (
    <div className="grid gap-0.5">
      <div className="flex min-h-9 items-center px-2.5">
        <Button
          className="mr-1 size-8 shrink-0 p-0 text-brai-muted hover:bg-brai-surface-soft hover:text-brai-ink [&_svg]:size-[18px] [&_svg]:fill-none [&_svg]:stroke-current [&_svg]:stroke-[1.7] [&_svg]:[stroke-linecap:round] [&_svg]:[stroke-linejoin:round]"
          variant="ghost"
          size="icon-sm"
          type="button"
          aria-label="Скрыть меню проектов"
          aria-controls="task-projects-panel"
          onClick={onClose}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <path d="M9 4v16m-2.5-5L5 12l1.5-3" />
          </svg>
        </Button>
        <h2 className="m-0 text-[13px] font-bold text-brai-ink">Проекты</h2>
        <Button
          className="ml-auto size-8 p-0 text-base font-normal text-brai-muted hover:bg-brai-surface-soft hover:text-brai-ink"
          variant="ghost"
          size="icon-sm"
          type="button"
          aria-label="Добавить проект"
          aria-expanded={isCreating}
          onClick={() => {
            setIsCreating(true);
            window.requestAnimationFrame(() => projectInputRef.current?.focus());
          }}
        >
          +
        </Button>
      </div>

      {isCreating && (
        <form
          className="px-1 pb-1"
          onSubmit={async (event) => {
            if (await addProject(event)) setIsCreating(false);
          }}
        >
          <input
            ref={projectInputRef}
            className="h-9 w-full rounded-md border border-brai-line bg-brai-surface-subtle px-2.5 text-sm text-brai-ink placeholder:text-brai-muted focus-visible:border-brai-accent/65 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brai-accent/20"
            type="text"
            value={projectTitle}
            onChange={(event) => setProjectTitle(event.target.value)}
            onBlur={() => {
              if (!projectTitle.trim()) setIsCreating(false);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setProjectTitle("");
                setIsCreating(false);
              }
            }}
            placeholder="Название проекта"
            aria-label="Название нового проекта"
            maxLength={100}
            disabled={isAddingProject}
          />
        </form>
      )}

      <button
        className={itemClassName}
        type="button"
        aria-current={selectedProjectFilter === "all" ? "page" : undefined}
        aria-pressed={selectedProjectFilter === "all"}
        onClick={() => {
          setSelectedProjectFilter("all");
          onSelectProject();
        }}
      >
        Все
        <span className={countClassName}>{projectCounts.all}</span>
      </button>
      <button
        className={`${itemClassName} ${noProjectTarget ? "bg-brai-accent/15 shadow-[inset_0_0_0_2px_var(--do-accent)]" : ""}`}
        type="button"
        aria-current={selectedProjectFilter === "none" ? "page" : undefined}
        aria-pressed={selectedProjectFilter === "none"}
        onClick={() => {
          setSelectedProjectFilter("none");
          onSelectProject();
        }}
        onDragEnter={() => {
          if (isTaskDrag) setProjectDropTarget("task-none");
        }}
        onDragOver={(event) => {
          if (!isTaskDrag) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          setProjectDropTarget("task-none");
        }}
        onDragLeave={() => {
          setProjectDropTarget((current) => current === "task-none" ? null : current);
        }}
        onDrop={(event) => void dropTaskOnProject(event, null)}
      >
        Без проекта
        <span className={countClassName}>{projectCounts.withoutProject}</span>
      </button>

      {isProjectsLoading ? (
        <p className="m-0 px-2.5 py-2 text-[12px] text-brai-muted">Загружаем…</p>
      ) : projects.map((project) => {
        const taskTarget = `task-${project.id}`;
        const beforeTarget = `project-before-${project.id}`;
        const afterTarget = `project-after-${project.id}`;
        const isTaskTarget = projectDropTarget === taskTarget;
        const isBefore = projectDropTarget === beforeTarget;
        const isAfter = projectDropTarget === afterTarget;
        return (
          <div
            className={`relative ${draggedProjectId === project.id ? "opacity-35" : ""} ${isBefore ? "before:absolute before:top-[-1px] before:right-1 before:left-1 before:z-1 before:h-0.5 before:rounded before:bg-brai-accent before:content-['']" : ""} ${isAfter ? "after:absolute after:right-1 after:bottom-[-1px] after:left-1 after:z-1 after:h-0.5 after:rounded after:bg-brai-accent after:content-['']" : ""}`}
            key={project.id}
            draggable
            onDragStart={(event) => startDraggingProject(event, project.id)}
            onDragEnd={finishDraggingProject}
            onDragOver={(event) => {
              if (isTaskDrag) {
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                setProjectDropTarget(taskTarget);
                return;
              }
              if (!draggedProjectId || draggedProjectId === project.id) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              const bounds = event.currentTarget.getBoundingClientRect();
              setProjectDropTarget(
                event.clientY < bounds.top + bounds.height / 2 ? beforeTarget : afterTarget,
              );
            }}
            onDragLeave={(event) => {
              const nextTarget = event.relatedTarget as Node | null;
              if (nextTarget && event.currentTarget.contains(nextTarget)) return;
              setProjectDropTarget((current) =>
                current === taskTarget || current === beforeTarget || current === afterTarget
                  ? null
                  : current);
            }}
            onDrop={(event) => {
              if (isTaskDrag) void dropTaskOnProject(event, project.id);
              else void dropProject(event, project.id);
            }}
          >
            <button
              className={`${itemClassName} cursor-grab ${isTaskTarget ? "bg-brai-accent/15 shadow-[inset_0_0_0_2px_var(--accent)]" : ""}`}
              type="button"
              aria-current={selectedProjectFilter === project.id ? "page" : undefined}
              aria-pressed={selectedProjectFilter === project.id}
              onClick={() => {
                setSelectedProjectFilter(project.id);
                onSelectProject();
              }}
            >
              <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
                {project.title}
              </span>
              <span className={countClassName}>{projectCounts.counts.get(project.id) ?? 0}</span>
            </button>
          </div>
        );
      })}
    </div>
  );
}
