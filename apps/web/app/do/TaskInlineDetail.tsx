// ABOUTME: Восстанавливает исходный компонент TaskInlineDetail.tsx из Brai September.
// ABOUTME: Использует локальный TasksContext; серверные операции задач отсутствуют.
import type { MouseEvent } from "react";
import {
  detailOffsetAtPoint,
  resizeTaskDetail,
  type DetailField,
  updateTaskDetailScrollbar,
} from "./task-ui";
import type { Task } from "./types";
import { useTasks } from "./TasksContext";
import type { TaskDragArea } from "./use-task-drag";
import { Textarea } from "@/components/ui/textarea";

/** Сохраняет разметку и взаимодействия исходного компонента September на локальных данных. */
export default function TaskInlineDetail({
  task,
  field,
  area = "left",
}: {
  task: Task;
  field: DetailField;
  area?: TaskDragArea;
}) {
  const {
    createTaskFromDetail,
    detailElementKey,
    detailElementsRef,
    detailKey,
    editingDetail,
    focusTaskDetail,
    previewTaskDetail,
    saveTaskDetail,
    setEditingDetail,
    taskDetailDrafts,
  } = useTasks();
  const isResult = field === "result";
  const value = taskDetailDrafts.get(detailKey(task.id, field)) ?? task[field] ?? "";
  const isEditing = editingDetail?.taskId === task.id
    && editingDetail.field === field
    && editingDetail.area === area;
  const kind = task.isMission ? "миссии" : task.isQuest ? "квеста" : task.isGoal ? "цели" : "задачи";
  const label = `${isResult ? "Результат" : "Описание"} ${kind} «${task.title}»`;
  const toneClassName = isResult
    ? "do-result-inline rounded"
    : "text-brai-text-secondary";

  if (isEditing) {
    return (
      <div
        className="group relative mt-[3px]"
        data-task-detail-editor
        data-task-editor-control
      >
        <Textarea
          ref={(element) => {
            const key = detailElementKey(task.id, field, area);
            if (element) {
              detailElementsRef.current.set(key, element);
              resizeTaskDetail(element);
            } else {
              detailElementsRef.current.delete(key);
            }
          }}
          bare
          className={`block max-h-[2.7em] min-h-[1.35em] w-full resize-none overflow-y-auto border-0 bg-transparent p-0 text-[12px] leading-[1.35] whitespace-pre-wrap outline-none focus:bg-brai-surface-focus focus:shadow-[0_0_0_3px_var(--do-surface-focus)] ${toneClassName}`}
          defaultValue={value}
          aria-label={label}
          spellCheck
          rows={1}
          maxLength={4000}
          draggable={false}
          onClick={(event) => event.stopPropagation()}
          onDragStart={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onFocus={(event) => {
            setEditingDetail({ taskId: task.id, field, area });
            resizeTaskDetail(event.currentTarget);
          }}
          onBlur={(event) => void saveTaskDetail(task, field, event.currentTarget, area)}
          onInput={(event) => {
            previewTaskDetail(task.id, field, event.currentTarget.value);
            resizeTaskDetail(event.currentTarget);
          }}
          onScroll={(event) => updateTaskDetailScrollbar(event.currentTarget)}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Enter" && event.shiftKey) {
              event.preventDefault();
              void createTaskFromDetail(task, field, event.currentTarget, event.metaKey, area);
            }
            if (event.key === "Escape") {
              event.preventDefault();
              event.currentTarget.value = task[field] ?? "";
              event.currentTarget.blur();
            }
          }}
        />
        <span
          className="pointer-events-none absolute top-0 right-0 h-full w-1 opacity-0 group-data-[overflowing=true]:opacity-100"
          aria-hidden="true"
          data-task-detail-scrollbar
        >
          <span
            className="block min-h-2 w-1 rounded-full bg-brai-muted/45"
            data-task-detail-scrollbar-thumb
          />
        </span>
      </div>
    );
  }

  if (!value) return null;

  return (
    <button
      className={`mt-[3px] line-clamp-2 block max-h-[2.7em] w-full overflow-hidden border-0 bg-transparent p-0 text-left text-[12px] leading-[1.35] whitespace-pre-wrap text-ellipsis ${toneClassName}`}
      type="button"
      aria-label={label}
      draggable={false}
      data-task-editor-control
      onClick={(event: MouseEvent<HTMLElement>) => {
        event.stopPropagation();
        const selectionStart = event.detail === 0
          ? 0
          : detailOffsetAtPoint(event.currentTarget, event.clientX, event.clientY);
        focusTaskDetail(task.id, field, selectionStart, area);
      }}
      onDragStart={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      {value}
    </button>
  );
}
