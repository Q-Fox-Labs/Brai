// ABOUTME: Восстанавливает исходный компонент TaskDetail.tsx из Brai September.
// ABOUTME: Использует локальный TasksContext; серверные операции задач отсутствуют.
import type { Task } from "./types";
import { useTasks } from "./TasksContext";
import type { DetailField } from "./task-ui";
import { Textarea } from "@/components/ui/textarea";

const MIN_DETAIL_HEIGHT = 42;
const MAX_DETAIL_HEIGHT = 240;

function resizeDetail(element: HTMLTextAreaElement) {
  element.style.height = "auto";
  const height = Math.min(Math.max(element.scrollHeight, MIN_DETAIL_HEIGHT), MAX_DETAIL_HEIGHT);
  element.style.height = `${height}px`;
  element.style.overflowY = element.scrollHeight > MAX_DETAIL_HEIGHT ? "auto" : "hidden";
}

/** Сохраняет разметку и взаимодействия исходного компонента September на локальных данных. */
export default function TaskDetail({ task, field }: { task: Task; field: DetailField }) {
  const {
    detailElementKey,
    detailElementsRef,
    isTaskChanging,
    previewTaskDetail,
    saveTaskDetail,
    setEditingDetail,
  } = useTasks();
  const isResult = field === "result";
  const value = task[field] ?? "";
  const title = isResult ? "Результат" : "Описание";
  const kind = task.isMission ? "миссии" : task.isQuest ? "квеста" : task.isGoal ? "цели" : "задачи";

  return (
    <section>
      <Textarea
        id={`${field}-${task.id}`}
        ref={(element) => {
          const key = detailElementKey(task.id, field, "right");
          if (element) {
            detailElementsRef.current.set(key, element);
            resizeDetail(element);
          } else {
            detailElementsRef.current.delete(key);
          }
        }}
        data-task-detail
        bare
        className={`do-detail-field block min-h-[42px] max-h-60 w-full resize-none overflow-y-hidden rounded-md border px-3 py-2.5 text-sm leading-6 outline-none transition-[border-color,box-shadow,background] disabled:cursor-wait disabled:opacity-65 ${isResult ? "do-result-field" : "border-brai-line bg-brai-surface-subtle text-brai-ink placeholder:text-brai-muted/75 focus:border-brai-accent/45 focus:bg-brai-field focus:shadow-[0_0_0_3px_var(--do-surface-focus)]"}`}
        defaultValue={value}
        rows={1}
        placeholder={isResult ? "Введите результат" : "Введите описание"}
        aria-label={`${title} ${kind} «${task.title}»`}
        spellCheck
        maxLength={4000}
        disabled={isTaskChanging(task.id)}
        onFocus={(event) => {
          setEditingDetail({ taskId: task.id, field, area: "right" });
          resizeDetail(event.currentTarget);
        }}
        onBlur={(event) => void saveTaskDetail(task, field, event.currentTarget, "right")}
        onInput={(event) => {
          previewTaskDetail(task.id, field, event.currentTarget.value);
          resizeDetail(event.currentTarget);
        }}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Escape") {
            event.preventDefault();
            event.currentTarget.value = value;
            event.currentTarget.blur();
          }
        }}
      />
    </section>
  );
}
