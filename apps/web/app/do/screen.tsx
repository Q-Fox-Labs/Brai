"use client";
// ABOUTME: Восстанавливает исходную страницу задачника September в разделе Дела.
// ABOUTME: Использует исходные UI-компоненты и синтетический контроллер без БД.

import "./styles.css";
import { useEffect, useState } from "react";
import { TasksContext } from "./TasksContext";
import TasksView from "./TasksView";
import TaskProjectsRail from "./TaskProjectsRail";
import { useTasksController } from "./use-tasks-controller";

type Props = { active: boolean; email: string; onLogout: () => void; accountMessage: string };

/** Собирает исходный задачник в общей тёмной оболочке /do. */
export default function DoScreen({ active }: Props) {
  const controller = useTasksController(active);
  const { setSelectedTaskId } = controller;
  const [isProjectsExpanded, setIsProjectsExpanded] = useState(true);
  const [isProjectsDrawerOpen, setIsProjectsDrawerOpen] = useState(false);

  useEffect(() => {
    const closeTemporaryPanels = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (isProjectsDrawerOpen) {
        setIsProjectsDrawerOpen(false);
        return;
      }
      if (window.matchMedia("(max-width: 800px)").matches) {
        setSelectedTaskId(null);
      }
    };

    document.addEventListener("keydown", closeTemporaryPanels);
    return () => document.removeEventListener("keydown", closeTemporaryPanels);
  }, [isProjectsDrawerOpen, setSelectedTaskId]);

  const closeProjects = () => {
    setIsProjectsExpanded(false);
    setIsProjectsDrawerOpen(false);
  };

  return (
    <TasksContext.Provider value={controller}>
      <main className="do-shell flex h-full min-h-0 flex-col" data-do-theme="dark" aria-label="Дела">
        <div
          className={`relative grid min-h-0 flex-1 grid-cols-1 items-stretch gap-4 overflow-hidden ${isProjectsExpanded ? "min-[801px]:grid-cols-[220px_minmax(0,1fr)]" : "min-[801px]:grid-cols-[minmax(0,1fr)]"}`}
        >
          <button
            className={`absolute inset-0 z-40 hidden border-0 bg-black/30 p-0 transition-opacity duration-200 max-[800px]:block ${isProjectsDrawerOpen ? "visible opacity-100 pointer-events-auto" : "invisible opacity-0 pointer-events-none"}`}
            type="button"
            aria-label="Закрыть меню проектов"
            tabIndex={isProjectsDrawerOpen ? 0 : -1}
            onClick={() => setIsProjectsDrawerOpen(false)}
          />
          <aside
            id="task-projects-panel"
            data-projects-drawer
            className={`min-h-0 overflow-y-auto rounded-2xl border border-brai-line bg-brai-card p-[5px] transition-[transform,visibility] duration-200 ease-out max-[800px]:absolute max-[800px]:inset-y-0 max-[800px]:left-0 max-[800px]:z-50 max-[800px]:w-[min(280px,calc(100%-48px))] max-[800px]:overscroll-contain max-[800px]:shadow-[12px_0_32px_rgba(25,27,25,0.18)] max-[480px]:rounded-[14px] ${isProjectsExpanded ? "min-[801px]:block" : "min-[801px]:hidden"} ${isProjectsDrawerOpen ? "max-[800px]:visible max-[800px]:translate-x-0" : "max-[800px]:invisible max-[800px]:-translate-x-[calc(100%+16px)]"}`}
            aria-label="Проекты"
          >
            <TaskProjectsRail
              onClose={closeProjects}
              onSelectProject={() => {
                if (window.matchMedia("(max-width: 800px)").matches) {
                  setIsProjectsDrawerOpen(false);
                }
              }}
            />
          </aside>
          <div className="min-h-0 min-w-0">
            <TasksView
              isProjectsExpanded={isProjectsExpanded}
              isProjectsDrawerOpen={isProjectsDrawerOpen}
              onExpandProjects={() => setIsProjectsExpanded(true)}
              onOpenProjectsDrawer={() => setIsProjectsDrawerOpen(true)}
            />
          </div>
        </div>
      </main>
    </TasksContext.Provider>
  );
}
