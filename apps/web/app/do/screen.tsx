"use client";
// ABOUTME: Собирает локальный задачник в общей рабочей оболочке.
// ABOUTME: Данные задач остаются в существующем контроллере без обращения к БД.
import "./styles.css";
import { TasksContext } from "./TasksContext";
import TasksView from "./TasksView";
import { useTasksController } from "./use-tasks-controller";
type Props = { active: boolean; userId: string; email: string; onLogout: () => void; accountMessage: string };
/** Показывает задачи и сохраняет их локальное состояние при переходах. */
export default function DoScreen({ active, userId }: Props) {
 const controller = useTasksController(active);
 return <TasksContext.Provider value={controller}><div className="do-shell h-full min-h-0 min-w-0"><TasksView userId={userId} /></div></TasksContext.Provider>;
}
