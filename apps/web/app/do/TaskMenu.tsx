// ABOUTME: Восстанавливает исходный компонент TaskMenu.tsx из Brai September.
// ABOUTME: Использует локальный TasksContext; серверные операции задач отсутствуют.
import { isContainer, taskKind, type OrderedTask } from "./model";
import { useTasks } from "./TasksContext";
import { TASK_KIND_ACTIONS } from "./task-ui";
import type { TaskDragArea } from "./use-task-drag";

/** Сохраняет разметку и взаимодействия исходного компонента September на локальных данных. */
export default function TaskMenu({
  task,
  canChangeKind,
  isBlocked,
  area = "left",
}: {
  task: OrderedTask;
  canChangeKind: boolean;
  isBlocked: boolean;
  area?: TaskDragArea;
}) {
  const {
    activeSession,
    changeTaskKind,
    deleteConfirmationId,
    deleteTask,
    focusTaskDetail,
    isTaskChanging,
    isTimerMutating,
    openBlockerSearch,
    openMenuId,
    rightOpenMenuId,
    setDeleteConfirmationId,
    setOpenMenuId,
    setRightOpenMenuId,
    startMissionTimer,
    updateTask,
  } = useTasks();
  const currentKind = taskKind(task).kind;
  const scopedOpenMenuId = area === "right" ? rightOpenMenuId : openMenuId;
  const setScopedOpenMenuId = area === "right" ? setRightOpenMenuId : setOpenMenuId;
  const setOtherOpenMenuId = area === "right" ? setOpenMenuId : setRightOpenMenuId;

  if (task.isDraft) return null;
  return (
    <div
      className={`relative z-0 mt-[-5px] mr-[-7px] shrink-0 ${scopedOpenMenuId === task.id ? "z-5" : ""}`}
      data-task-editor-control
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setScopedOpenMenuId(null);
          setDeleteConfirmationId(null);
        }
      }}
    >
      <button
        className="h-8 w-[34px] rounded-lg border-0 bg-transparent text-[13px] tracking-[1px] text-brai-muted hover:bg-brai-surface-hover hover:text-brai-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brai-accent/35 aria-expanded:bg-brai-surface-hover aria-expanded:text-brai-ink"
        type="button"
        aria-label={`Действия с задачей «${task.title}»`}
        aria-expanded={scopedOpenMenuId === task.id}
        onClick={(event) => {
          event.stopPropagation();
          const nextMenuId = scopedOpenMenuId === task.id ? null : task.id;
          setOtherOpenMenuId(null);
          setScopedOpenMenuId(nextMenuId);
          setDeleteConfirmationId(null);
        }}
      >
        <span aria-hidden="true">•••</span>
      </button>
      {scopedOpenMenuId === task.id && (
        <div className="absolute top-[34px] right-0 z-1 w-[180px] rounded-[10px] border border-brai-line bg-brai-card p-[5px] shadow-[0_10px_28px_rgba(25,27,25,0.12)] [&>button]:w-full [&>button]:rounded-[7px] [&>button]:border-0 [&>button]:bg-transparent [&>button]:px-2.5 [&>button]:py-1.5 [&>button]:text-left [&>button]:text-[13px] [&>button]:text-brai-ink [&>button]:hover:bg-brai-surface-soft [&>button]:focus-visible:outline-2 [&>button]:focus-visible:outline-offset-1 [&>button]:focus-visible:outline-brai-accent/35 [&>button]:disabled:cursor-wait [&>button]:disabled:opacity-65">
          {canChangeKind && TASK_KIND_ACTIONS
            .filter((action) => action.kind !== currentKind)
            .map((action) => (
              <button
                key={action.kind}
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  setScopedOpenMenuId(null);
                  void changeTaskKind(task, action.kind, action.error);
                }}
              >
                {action.label}
              </button>
            ))}
          {task.isMission && task.status === "active" && activeSession?.missionId !== task.id && (
            <button
              type="button"
              disabled={isTimerMutating}
              onClick={(event) => {
                event.stopPropagation();
                setScopedOpenMenuId(null);
                void startMissionTimer(task);
              }}
            >
              Запустить таймер
            </button>
          )}
          <button type="button" onClick={(event) => {
            event.stopPropagation();
            setScopedOpenMenuId(null);
            openBlockerSearch(task, area);
          }}>
            Выбрать блокер
          </button>
          <button type="button" onClick={(event) => {
            event.stopPropagation();
            setScopedOpenMenuId(null);
            setDeleteConfirmationId(null);
            focusTaskDetail(task.id, "result", 0, area);
          }}>
            Добавить результат
          </button>
          {!isContainer(task) && (
            <button
              type="button"
              disabled={isTaskChanging(task.id) || isBlocked}
              onClick={(event) => {
                event.stopPropagation();
                setScopedOpenMenuId(null);
                void updateTask(
                  task.id,
                  { status: task.status === "not_completed" ? "active" : "not_completed" },
                  task.status === "not_completed"
                    ? "Не удалось вернуть задачу в работу"
                    : "Не удалось отметить задачу невыполненной",
                );
              }}
            >
              {task.status === "not_completed" ? "Вернуть в работу" : "Не выполнено"}
            </button>
          )}
          <button
            className={deleteConfirmationId === task.id ? "!bg-brai-danger !font-bold !text-destructive-foreground hover:!bg-brai-danger/85" : ""}
            type="button"
            disabled={isTaskChanging(task.id)}
            onClick={(event) => {
              event.stopPropagation();
              if (deleteConfirmationId === task.id) setScopedOpenMenuId(null);
              void deleteTask(task);
            }}
          >
            {deleteConfirmationId === task.id ? "Точно удалить?" : "Удалить"}
          </button>
        </div>
      )}
    </div>
  );
}
