// ABOUTME: Передаёт исходным компонентам локальные команды и состояние задачника.
// ABOUTME: Контекст принадлежит одному экрану аккаунта, без общей изменяемой памяти.
import { createContext, useContext } from "react";
import type { TasksController } from "./use-tasks-controller";

export const TasksContext = createContext<TasksController | null>(null);

/** Возвращает локальный контроллер; требует TasksContext.Provider над компонентом. */
export function useTasks() {
  const controller = useContext(TasksContext);
  if (!controller) throw new Error("TasksContext is unavailable");
  return controller;
}
