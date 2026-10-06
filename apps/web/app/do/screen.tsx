"use client";
// ABOUTME: Восстанавливает исходную страницу задачника September в разделе Дела.
// ABOUTME: Использует исходные UI-компоненты и синтетический контроллер без БД.

import "./styles.css";
import { useEffect, useState } from "react";
import { TasksContext } from "./TasksContext";
import TasksView from "./TasksView";
import TaskProjectsRail from "./TaskProjectsRail";
import { useTasksController } from "./use-tasks-controller";
import { Card } from "@/components/ui/card";

type Props = { active: boolean; email: string; onLogout: () => void; accountMessage: string };

/** Собирает исходный задачник в общей тёмной оболочке /do. */
export default function DoScreen({ active }: Props) {
  const controller = useTasksController(active);
  const { setSelectedTaskId } = controller;
  const [isProjectsExpanded, setIsProjectsExpanded] = useState(true);
  const [isProjectsDrawerOpen, setIsProjectsDrawerOpen] = useState(false);

  useEffect(() => {
    const closeTemporaryPanels = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (isProjectsDrawerOpen) {
        setIsProjectsDrawerOpen(false);
        return;
      }
      if (window.matchMedia("(max-width: 860px)").matches) {
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
      <main className="do-shell flex h-full min-h-0 min-w-0 flex-col" aria-label="Дела">
        <div
          className={`relative grid min-h-0 min-w-0 flex-1 grid-cols-1 items-stretch gap-3 overflow-hidden ${isProjectsExpanded ? "min-[861px]:grid-cols-[220px_minmax(0,1fr)]" : "min-[861px]:grid-cols-[minmax(0,1fr)]"}`}
        >
          <button
            className={`absolute inset-0 z-40 hidden border-0 bg-foreground/20 p-0 transition-opacity duration-200 max-[861px]:block ${isProjectsDrawerOpen ? "visible opacity-100 pointer-events-auto" : "invisible opacity-0 pointer-events-none"}`}
            type="button"
            aria-label="Закрыть меню проектов"
            tabIndex={isProjectsDrawerOpen ? 0 : -1}
            onClick={() => setIsProjectsDrawerOpen(false)}
          />
          <Card
            render={<aside id="task-projects-panel" data-projects-drawer aria-label="Проекты" />}
            className={`min-h-0 overflow-y-auto rounded-xl border-brai-line bg-brai-card p-1 transition-[transform,visibility] duration-200 ease-out max-[861px]:absolute max-[861px]:inset-y-0 max-[861px]:left-0 max-[861px]:z-50 max-[861px]:w-[min(280px,calc(100%-48px))] max-[861px]:overscroll-contain max-[861px]:shadow-xl ${isProjectsExpanded ? "min-[861px]:block" : "min-[861px]:hidden"} ${isProjectsDrawerOpen ? "max-[861px]:visible max-[861px]:translate-x-0" : "max-[861px]:invisible max-[861px]:-translate-x-[calc(100%+16px)]"}`}
          >
            <TaskProjectsRail
              onClose={closeProjects}
              onSelectProject={() => {
                if (window.matchMedia("(max-width: 860px)").matches) {
                  setIsProjectsDrawerOpen(false);
                }
              }}
            />
          </Card>
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
