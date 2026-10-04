// ABOUTME: Сохраняет исходную кнопку запуска агента в подробностях задачи.
// ABOUTME: В демо не выполняет серверные операции и не запускает модель.
import { useTasks } from "./TasksContext";

/** Отображает исходную кнопку; объясняет границу демо при попытке запуска. */
export default function TaskAgentButton({ taskId }: { taskId: string }) {
  const { setError } = useTasks();
  const isLoading = false, effectiveStatus = { isRunning: false };
  const taskAgentActionLabel = () => "Выполнить Агентом";
  const start = () => setError("Демонстрационные данные: запуск агента не подключён");
  return (
    <button data-task-id={taskId}
      className="rounded-lg border border-brai-accent/35 bg-brai-accent px-3 py-2 text-[13px] font-medium text-white hover:bg-brai-accent/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brai-accent/40 disabled:cursor-wait disabled:opacity-60"
      type="button"
      disabled={isLoading || effectiveStatus.isRunning}
      onClick={() => void start()}
    >
      {taskAgentActionLabel()}
    </button>
  );
}
