// ABOUTME: Восстанавливает исходный компонент TaskStructure.tsx из Brai September.
// ABOUTME: Использует локальный TasksContext; серверные операции задач отсутствуют.
import { useState } from "react";
import { isContainer, sortTasksByOrder, type OrderedTask } from "./model";
import TaskChildForm from "./TaskChildForm";
import TaskRow from "./TaskRow";
import { useTasks } from "./TasksContext";
import type { Task } from "./types";

/** Сохраняет разметку и взаимодействия исходного компонента September на локальных данных. */
export default function TaskStructure({ task }: { task: Task }) {
  const { childTasksByParent } = useTasks();
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() => new Set());
  const branch: OrderedTask[] = [];
  const visitedIds = new Set<string>();

  const appendChildren = (parentId: string, nestingDepth: number) => {
    for (const child of sortTasksByOrder(childTasksByParent.get(parentId) ?? [])) {
      if (visitedIds.has(child.id)) continue;
      visitedIds.add(child.id);
      branch.push({ ...child, nestingDepth });
      if (isContainer(child) && !collapsedIds.has(child.id)) {
        appendChildren(child.id, nestingDepth + 1);
      }
    }
  };
  appendChildren(task.id, 0);

  const toggleContainer = (taskId: string) => {
    setCollapsedIds((current) => {
      const next = new Set(current);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  };

  return (
    <section>
      <h3 className="mb-2 text-[11px] font-bold tracking-[0.04em] text-brai-muted uppercase">Структура</h3>
      <div className="relative rounded-xl border border-brai-line">
        <TaskChildForm task={task} />
        {branch.map((branchTask) => (
          <TaskRow
            key={branchTask.id}
            task={branchTask}
            area="right"
            isCollapsed={collapsedIds.has(branchTask.id)}
            onToggleContainer={toggleContainer}
          />
        ))}
      </div>
    </section>
  );
}
