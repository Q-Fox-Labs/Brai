// ABOUTME: Показывает строку дерева, цветной статус, прогресс и места переноса.
// ABOUTME: Адаптирует TaskRow и TaskContent из Brai_september к локальным командам и тёмной теме.
import { useState, type DragEvent, type MouseEvent, type KeyboardEvent } from "react";
import { flushSync } from "react-dom";
import { canMoveTask, isContainer, isCountedStatus, taskKind, type OrderedTask, type Task, type TaskUpdate } from "./model";
import { type TaskDragArea, type useTaskDrag } from "./use-task-drag";

type Props = {
  task: OrderedTask;
  tasks: Task[];
  children: Task[];
  number: string;
  projectTitle?: string;
  selected: boolean;
  collapsed: boolean;
  area?: TaskDragArea;
  drag: ReturnType<typeof useTaskDrag>;
  onToggle: (id: string) => void;
  onSelect: (id: string) => void;
  onUpdate: (id: string, update: TaskUpdate) => void;
};

function animateContainerToggle(area: TaskDragArea, toggle: () => void) {
  const scope = document.querySelector<HTMLElement>(`[data-task-drag-area="${area}"]`);
  if (!scope || window.matchMedia("(prefers-reduced-motion: reduce)").matches) { toggle(); return; }
  // AIDEV-NOTE: Анимация перемещает строки от прежних координат; высота списка меняется сразу.
  const before = new Map(Array.from(scope.querySelectorAll<HTMLElement>("[data-task-row]")).map(row => [row.dataset.taskId, row.getBoundingClientRect().top]));
  flushSync(toggle);
  for (const row of scope.querySelectorAll<HTMLElement>("[data-task-row]")) {
    const top = before.get(row.dataset.taskId);
    row.animate(top === undefined
      ? [{ opacity: 0, transform: "translateY(-8px)" }, { opacity: 1, transform: "translateY(0)" }]
      : [{ transform: `translateY(${top - row.getBoundingClientRect().top}px)` }, { transform: "translateY(0)" }],
    { duration: 170, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" });
  }
}

/** Отображает запись; команды редактирования и переноса передаёт владельцу локального дерева. */
export default function TaskRow({ task, tasks, children, number, projectTitle, selected, collapsed, area = "left", drag, onToggle, onSelect, onUpdate }: Props) {
  const [editing, setEditing] = useState(false), [draft, setDraft] = useState(task.title);
  const kind = taskKind(task), container = isContainer(task), counted = isCountedStatus(task.status);
  const collapseLabel = task.isMission ? "миссию" : task.isQuest ? "квест" : "цель";
  const blockers = task.blockerIds.map(id => tasks.find(item => item.id === id)).filter((item): item is Task => Boolean(item));
  const blocked = blockers.some(item => !isCountedStatus(item.status));
  const completed = children.filter(item => isCountedStatus(item.status)).length;
  const moving = tasks.find(item => item.id === drag.draggedId);
  const local = drag.dragArea === area && moving && moving.id !== task.id;
  const beside = local && (moving.parentId === task.parentId || Boolean(task.parentId && canMoveTask(tasks, moving.id, task.parentId)));
  const into = local && !beside && canMoveTask(tasks, moving.id, task.id);
  const mode = into ? "into" : beside ? "beside" : null;
  const target = `${area}-${task.id}`;
  const drop = drag.dropTarget?.startsWith(`${target}-`) ? drag.dropTarget.slice(target.length + 1) : null;
  const select = (event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>) => {
    if (event.target instanceof Element && event.target.closest("button, input, textarea, select, a, summary")) return;
    onSelect(task.id);
  };
  const dragOver = (event: DragEvent<HTMLElement>) => {
    if (!mode) return;
    event.preventDefault(); event.dataTransfer.dropEffect = "move";
    drag.setDropTarget(`${target}-${mode === "into" ? "into" : drag.insertionEdge(event)}`);
  };
  return <article
    id={area === "left" ? `do-task-${task.id}` : undefined}
    className={`do-row ${kind.className} ${selected ? "is-selected" : ""} ${counted ? "is-counted" : ""} ${drag.dragArea === area && drag.draggedId === task.id ? "is-dragged" : ""} ${drop ? `drop-${drop}` : ""}`}
    style={{ marginLeft: task.nestingDepth * 24 }}
    data-task-row data-task-id={task.id} data-selected={selected}
    tabIndex={0} aria-label={`${kind.label} ${number}: ${task.title}`}
    draggable={!editing}
    onClick={select}
    onKeyDown={event => { if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); onSelect(task.id); } }}
    onDragStart={event => drag.startDragging(event, task, area)} onDragEnd={drag.finishDragging}
    onDragOver={dragOver}
    onDragLeave={event => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) drag.setDropTarget(current => current?.startsWith(`${target}-`) ? null : current); }}
    onDrop={event => {
      if (mode === "into") void drag.dropIntoContainer(event, task);
      else if (mode === "beside") {
        if (task.parentId) void drag.dropBesideNestedTask(event, task);
        else drag.dropBesideRootTask(event, task);
      }
    }}
  >
    <div className="do-status-column">
      {container ? <button type="button" className={`do-status ${counted ? "is-closed" : ""}`} aria-expanded={!collapsed} aria-label={`${collapsed ? "Развернуть" : "Свернуть"} ${collapseLabel} «${task.title}»`} onClick={() => animateContainerToggle(area, () => onToggle(task.id))}>
        {counted && "✓"}<span className={`do-chevron ${collapsed ? "" : "is-open"}`} aria-hidden="true">›</span>
      </button> : <label className="do-check-label">
        <input type="checkbox" checked={counted} disabled={blocked} aria-label={blocked ? `Задача «${task.title}» ждёт выполнения блокера` : `${counted ? "Вернуть" : "Выполнить"} задачу «${task.title}»`} onChange={event => onUpdate(task.id, { status: event.target.checked ? "completed" : "active" })} />
        <span className={`do-status ${counted ? "is-closed" : ""} ${blocked ? "is-blocked" : ""} ${task.status === "not_completed" ? "is-cancelled" : ""}`} aria-hidden="true">{counted ? task.status === "not_completed" ? "×" : "✓" : ""}</span>
      </label>}
    </div>
    <div className="min-w-0 flex-1">
      <div className="flex min-w-0 items-start gap-2">
        <span className="do-number" title={`Постоянный ID: ${task.publicId}`}>{number}</span>
        {editing ? <textarea className="do-title-editor" value={draft} autoFocus rows={2} maxLength={200} aria-label="Название дела" onChange={event => setDraft(event.target.value)} onBlur={() => { onUpdate(task.id, { title: draft }); setEditing(false); }} onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); setDraft(task.title); setEditing(false); } else if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.blur(); } }} />
          : <button type="button" className="do-title" onClick={() => { setDraft(task.title); setEditing(true); }} title="Изменить название">{task.title}</button>}
        <button type="button" className="do-icon do-open-detail" aria-label={`Открыть подробности «${task.title}»`} onClick={() => onSelect(task.id)}>↗</button>
      </div>
      {task.description && <p className="do-inline-description">{task.description}</p>}
      {task.result && <p className="do-inline-result">↳ {task.result}</p>}
      <div className="do-meta">
        {task.nestingDepth === 0 && <span className="do-kind-badge">{kind.label}</span>}
        {projectTitle && task.nestingDepth === 0 && <span className="do-project-badge">{projectTitle}</span>}
        <time dateTime={new Date(task.createdAt).toISOString()}>{new Date(task.createdAt).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", timeZone: "UTC" })}</time>
        <span className="do-public-id">ID {task.publicId}</span>
      </div>
      {blockers.map(blocker => <button type="button" key={blocker.id} className={`do-blocker ${isCountedStatus(blocker.status) ? "is-resolved" : ""}`} onClick={() => onSelect(blocker.id)}>{isCountedStatus(blocker.status) ? "✓" : "⊖"} {blocker.publicId} · {blocker.title}</button>)}
      {container && <div className="do-progress" role="img" aria-label={`Выполнено: ${completed} из ${children.length}`}>
        {children.length === 0 ? <span className="do-progress-dot is-empty" /> : children.map(child => <span key={child.id} className={`do-progress-dot ${isCountedStatus(child.status) ? "is-filled" : ""} ${child.blockerIds.some(id => tasks.some(item => item.id === id && !isCountedStatus(item.status))) ? "is-blocked" : ""}`} />)}
        <span className="do-progress-count">{completed}/{children.length}</span>
      </div>}
    </div>
  </article>;
}
