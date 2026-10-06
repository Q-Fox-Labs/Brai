// ABOUTME: Сохраняет исходную кнопку запуска агента в подробностях задачи.
// ABOUTME: В демо не выполняет серверные операции и не запускает модель.
import { useTasks } from "./TasksContext";
import { Button } from "@/components/ui/button";

/** Отображает исходную кнопку; объясняет границу демо при попытке запуска. */
export default function TaskAgentButton({ taskId }: { taskId: string }) {
  const { setError } = useTasks();
  const isLoading = false, effectiveStatus = { isRunning: false };
  const taskAgentActionLabel = () => "Выполнить Агентом";
  const start = () => setError("Демонстрационные данные: запуск агента не подключён");
  return (
    <Button data-task-id={taskId}
      className="rounded-md border-brai-accent/35 bg-brai-accent px-3 text-sm font-medium text-primary-foreground hover:bg-brai-accent/90"
      size="sm"
      type="button"
      disabled={isLoading || effectiveStatus.isRunning}
      onClick={() => void start()}
    >
      {taskAgentActionLabel()}
    </Button>
  );
}
