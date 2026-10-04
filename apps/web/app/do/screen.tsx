"use client";
// ABOUTME: Собирает раздел «Дела» из локального дерева, проектов и панели подробностей.
// ABOUTME: Все изменения живут в памяти аккаунта; сетевые операции задач отсутствуют.
import { useRef, useState, type DragEvent, type FormEvent } from "react";
import { createDemoTasks, demoProjects } from "./demo";
import { collectTaskAndDescendantIds, computeRelativeNumbers, groupTasksByParent, isContainer, isCountedStatus, orderTaskTree, sortTasksByOrder, syncTaskStatuses, taskKind, taskTreeProjectId, updateLocalTask, type Project, type Task, type TaskKind, type TaskUpdate } from "./model";
import TaskRow from "./task-row";
import { useTaskDrag, type TaskDragArea } from "./use-task-drag";
import "./styles.css";

const kinds: { kind: TaskKind; label: string }[] = [{ kind: "task", label: "Задача" }, { kind: "goal", label: "Цель" }, { kind: "quest", label: "Квест" }, { kind: "mission", label: "Миссия" }];
const childKinds: Partial<Record<TaskKind, TaskKind>> = { mission: "quest", quest: "goal", goal: "task" };
type Props = { active: boolean; email: string; onLogout: () => void; accountMessage: string };

/** Показывает синтетический задачник в общей оболочке; выход удаляет его локальные изменения. */
export default function DoScreen({ active, email, onLogout, accountMessage }: Props) {
  const [tasks, setTasks] = useState(createDemoTasks), [projects, setProjects] = useState<Project[]>(demoProjects);
  const [filter, setFilter] = useState("all"), [selectedId, setSelectedId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(new Set(["q-feedback", "m-personal"])), [rightCollapsed, setRightCollapsed] = useState(new Set<string>());
  const [title, setTitle] = useState(""), [newKind, setNewKind] = useState<TaskKind>("task"), [idQuery, setIdQuery] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false), [projectTitle, setProjectTitle] = useState(""), [addingProject, setAddingProject] = useState(false);
  const [tab, setTab] = useState<"details" | "structure" | "connections">("details"), [message, setMessage] = useState("");
  const [childTitle, setChildTitle] = useState(""), [projectTarget, setProjectTarget] = useState<string | null>(null);
  const nextId = useRef(200), detailCloseRef = useRef<HTMLButtonElement>(null);
  const byId = new Map(tasks.map(task => [task.id, task])), children = groupTasksByParent(tasks), numbers = computeRelativeNumbers(tasks);
  const selected = tasks.find(task => task.id === selectedId) ?? null;
  const visible = tasks.filter(task => filter === "all" || (taskTreeProjectId(task, byId) ?? "none") === filter);
  const ordered = orderTaskTree(visible, children, collapsed);
  const selectedChildren = selected ? sortTasksByOrder(children.get(selected.id) ?? []) : [];
  const selectedTreeIds = selected ? collectTaskAndDescendantIds(selected.id, children) : new Set<string>();
  const selectedTree = orderTaskTree(tasks.filter(task => selectedTreeIds.has(task.id)), children, rightCollapsed);
  const completed = tasks.filter(task => !isContainer(task) && isCountedStatus(task.status)).length;
  const total = tasks.filter(task => !isContainer(task)).length;
  const updateTask = (id: string, update: TaskUpdate) => {
    setTasks(previous => updateLocalTask(previous, id, update));
    if (update.parentId) setCollapsed(previous => { const next = new Set(previous); next.delete(update.parentId!); return next; });
    setMessage("");
  };
  const drag = useTaskDrag({ tasks, childTasksByParent: children, active, setCollapsedContainerIds: setCollapsed, updateTask });
  const toggleRight = (id: string) => setRightCollapsed(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const reveal = (id: string) => {
    const task = byId.get(id);
    if (!task) return;
    const projectId = taskTreeProjectId(task, byId) ?? "none";
    if (filter !== "all" && filter !== projectId) setFilter(projectId);
    setCollapsed(previous => {
      const next = new Set(previous);
      let current: Task | undefined = task;
      while (current?.parentId) { next.delete(current.parentId); current = byId.get(current.parentId); }
      return next;
    });
    setSelectedId(id); setChildTitle("");
    window.requestAnimationFrame(() => {
      const row = document.getElementById(`do-task-${id}`);
      row?.scrollIntoView({ block: "nearest", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
      if (window.matchMedia("(max-width: 800px)").matches) detailCloseRef.current?.focus();
    });
  };
  const closeDetails = () => { const id = selectedId; setSelectedId(null); window.requestAnimationFrame(() => document.getElementById(`do-task-${id}`)?.focus()); };
  const createTask = (value: string, kind: TaskKind, parentId: string | null = null) => {
    if (!value.trim()) return;
    const id = `local-${nextId.current++}`;
    const projectId = parentId ? taskTreeProjectId(byId.get(parentId)!, byId) : filter !== "all" && filter !== "none" ? filter : null;
    const task: Task = { id, publicId: String(nextId.current), title: value.trim().slice(0, 200), description: null, result: null, parentId, projectId, status: "active", isGoal: kind === "goal", isQuest: kind === "quest", isMission: kind === "mission", blockerIds: [], sortOrder: tasks.filter(item => item.parentId === parentId).length, createdAt: Date.now() };
    setTasks(previous => syncTaskStatuses([...previous, task]));
    if (parentId) { setCollapsed(previous => { const next = new Set(previous); next.delete(parentId); return next; }); setRightCollapsed(previous => { const next = new Set(previous); next.delete(parentId); return next; }); }
    setMessage(`Добавлено: ${task.title}`);
  };
  const addTask = (event: FormEvent) => { event.preventDefault(); createTask(title, newKind); setTitle(""); };
  const removeSelected = () => {
    if (!selected) return;
    const ids = collectTaskAndDescendantIds(selected.id, children);
    setTasks(previous => syncTaskStatuses(previous.filter(task => !ids.has(task.id)).map(task => ({ ...task, blockerIds: task.blockerIds.filter(id => !ids.has(id)) }))));
    setSelectedId(null); setMessage(`Удалено: ${selected.title}`);
  };
  const moveSelected = (direction: -1 | 1) => {
    if (!selected) return;
    const siblings = sortTasksByOrder(tasks.filter(task => task.parentId === selected.parentId));
    const index = siblings.findIndex(task => task.id === selected.id), target = index + direction;
    if (target < 0 || target >= siblings.length) return;
    [siblings[index], siblings[target]] = [siblings[target], siblings[index]];
    void updateTask(selected.id, { siblingOrder: siblings.map(task => task.id) });
  };
  const scrollDrag = (event: DragEvent<HTMLDivElement>, area: TaskDragArea) => {
    if (drag.dragArea !== area) return;
    event.preventDefault();
    const bounds = event.currentTarget.getBoundingClientRect();
    if (event.clientY < bounds.top + 64) drag.updateDragScrolling(event, "top");
    else if (event.clientY > bounds.bottom - 64) drag.updateDragScrolling(event, "bottom");
    else drag.stopDragScrolling();
  };
  const leaveScroll = (event: DragEvent<HTMLDivElement>) => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) drag.stopDragScrolling(); };
  const row = (task: (typeof ordered)[number], area: TaskDragArea) => <TaskRow key={task.id} task={task} tasks={tasks} children={sortTasksByOrder(children.get(task.id) ?? [])} number={numbers.get(task.id) ?? task.publicId} projectTitle={projects.find(project => project.id === taskTreeProjectId(task, byId))?.title} selected={area === "left" && task.id === selectedId} collapsed={(area === "left" ? collapsed : rightCollapsed).has(task.id)} area={area} drag={drag} onToggle={area === "left" ? drag.toggleContainer : toggleRight} onSelect={reveal} onUpdate={(id, update) => { void updateTask(id, update); }} />;
  const detachZone = (position: "top" | "bottom") => drag.dragArea === "left" && drag.isDraggingChild && <div className={`do-detach ${drag.dropTarget === `outside-${position}` ? "is-target" : ""}`} onDragOver={event => { event.preventDefault(); drag.setDropTarget(`outside-${position}`); }} onDrop={event => drag.dropOutsideParent(event)}>Вынести из родителя</div>;
  const projectButton = (id: string, label: string, color?: string) => <button key={id} type="button" className={`do-project ${projectTarget === id ? "is-target" : ""}`} aria-pressed={filter === id} onClick={() => { setFilter(id); setSidebarOpen(false); }}
    onDragOver={event => { if (!drag.draggedId || id === "all") return; event.preventDefault(); event.dataTransfer.dropEffect = "move"; drag.stopDragScrolling(); setProjectTarget(id); }}
    onDragLeave={() => setProjectTarget(null)}
    onDrop={event => { event.preventDefault(); if (!drag.draggedId || id === "all") return; const moving = byId.get(drag.draggedId)!; let root = moving; while (root.parentId) root = byId.get(root.parentId)!; void updateTask(root.id, { projectId: id === "none" ? null : id }); drag.finishDragging(); setProjectTarget(null); }}>
    <span className="do-project-dot" style={{ background: color ?? "#a0a3aa" }} /><span className="min-w-0 flex-1 truncate">{label}</span>
    <span className="do-project-count">{tasks.filter(task => !isContainer(task) && !isCountedStatus(task.status) && (id === "all" || (taskTreeProjectId(task, byId) ?? "none") === id)).length}</span>
  </button>;
  const ancestors: Task[] = [];
  let parent = selected?.parentId ? byId.get(selected.parentId) : undefined;
  while (parent) { ancestors.unshift(parent); parent = parent.parentId ? byId.get(parent.parentId) : undefined; }

  return <main className="do-shell" onDragEnd={() => setProjectTarget(null)}>
    <aside className={`do-sidebar ${sidebarOpen ? "is-open" : ""}`} aria-label="Проекты дел" id="do-projects">
      <div className="do-sidebar-heading"><h2>Проекты</h2><button className="do-icon" type="button" aria-label="Добавить проект" aria-expanded={addingProject} onClick={() => setAddingProject(!addingProject)}>+</button><button className="do-sidebar-close do-icon" type="button" aria-label="Закрыть проекты" onClick={() => setSidebarOpen(false)}>×</button></div>
      {addingProject && <form className="px-3 pb-2" onSubmit={event => { event.preventDefault(); if (!projectTitle.trim()) return; const id = `project-${nextId.current++}`; setProjects(previous => [...previous, { id, title: projectTitle.trim(), color: "#bb8aff" }]); setProjectTitle(""); setAddingProject(false); setFilter(id); }}><input className="do-field w-full" autoFocus value={projectTitle} onChange={event => setProjectTitle(event.target.value)} maxLength={100} aria-label="Название нового проекта" placeholder="Название проекта" onKeyDown={event => { if (event.key === "Escape") setAddingProject(false); }} /></form>}
      <div className="do-project-list">{projectButton("all", "Все дела")}{projectButton("none", "Без проекта")}<div className="do-separator" />{projects.map(project => projectButton(project.id, project.title, project.color))}</div>
      <div className="do-legend"><p>Уровни дел</p>{kinds.slice().reverse().map(item => <span className={`do-legend-item is-${item.kind}`} key={item.kind}><i />{item.label}</span>)}</div>
      <footer className="do-sidebar-footer"><span className="truncate">{email}</span><button type="button" onClick={onLogout}>Выйти</button></footer>
    </aside>
    <div className="do-workspace">
      <header className="do-toolbar"><button type="button" className="do-mobile-projects do-icon" aria-label="Открыть проекты" aria-expanded={sidebarOpen} aria-controls="do-projects" onClick={() => setSidebarOpen(!sidebarOpen)}>☰</button><div className="min-w-0 flex-1"><h1>Дела</h1><p>{filter === "all" ? "Все проекты" : filter === "none" ? "Без проекта" : projects.find(project => project.id === filter)?.title}</p></div><span className="do-demo-badge">Демо</span><span className="do-summary">{completed} / {total} выполнено</span></header>
      <div className="do-panels">
        <section className="do-list-panel" aria-label="Список дел">
          <div className="do-list-toolbar">
            <form className="flex min-w-0 flex-1 items-center gap-2" onSubmit={addTask}>
              <select className="do-field do-kind-select" aria-label="Вид нового дела" value={newKind} onChange={event => setNewKind(event.target.value as TaskKind)}>{kinds.map(item => <option key={item.kind} value={item.kind}>{item.label}</option>)}</select>
              <input className="do-field min-w-0 flex-1" value={title} onChange={event => setTitle(event.target.value)} maxLength={200} placeholder="Новое дело" aria-label="Название нового дела" />
              <button className="do-add-button" type="submit" disabled={!title.trim()} aria-label="Добавить дело">+</button>
            </form>
            <form className="do-id-search" onSubmit={event => { event.preventDefault(); const task = tasks.find(item => item.publicId === idQuery.trim()); if (task) { reveal(task.id); setMessage(""); } else setMessage("Дело с таким ID не найдено."); }}><input className="do-field" inputMode="numeric" maxLength={6} value={idQuery} onChange={event => setIdQuery(event.target.value.replace(/\D/g, ""))} placeholder="ID" aria-label="Найти дело по ID" /><button type="submit" className="do-icon" aria-label="Найти дело">⌕</button></form>
          </div>
          <div className="do-list-options"><span>{visible.filter(task => !isContainer(task)).length} задач</span><button type="button" onClick={() => setCollapsed(previous => new Set([...previous, ...visible.filter(isContainer).map(task => task.id)]))}>Свернуть всё</button><button type="button" onClick={() => setCollapsed(previous => { const next = new Set(previous); visible.forEach(task => next.delete(task.id)); return next; })}>Развернуть всё</button></div>
          <div className="do-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain" data-task-scroll-container data-task-drag-area="left" onDragOver={event => scrollDrag(event, "left")} onDragLeave={leaveScroll}>
            {detachZone("top")}{ordered.map(task => row(task, "left"))}{detachZone("bottom")}
            {ordered.length === 0 && <p className="do-empty">Пока нет дел. Добавьте первое выше.</p>}
          </div>
          <p className="do-list-hint">Перетаскивайте строки · У края списка включается прокрутка</p>
        </section>
        <button className={`do-detail-backdrop ${selected ? "is-open" : ""}`} type="button" aria-label="Закрыть подробности" onClick={closeDetails} tabIndex={selected ? 0 : -1} />
        <aside className={`do-inspector ${selected ? "is-open" : ""}`} aria-label="Подробности дела" onKeyDown={event => { if (event.key === "Escape" && !(event.target instanceof Element && event.target.closest("input, textarea, select"))) closeDetails(); }}>
          {!selected ? <div className="do-empty-inspector"><span aria-hidden="true">☷</span><p>Выберите дело слева</p></div> : <>
            <header className="do-inspector-header"><div className="flex min-w-0 flex-1 items-center gap-2"><span className={`do-kind-badge is-${taskKind(selected).kind}`}>{taskKind(selected).label}</span><span className="do-number">{numbers.get(selected.id)}</span><span className="do-public-id">ID {selected.publicId}</span></div><button ref={detailCloseRef} className="do-icon" type="button" aria-label="Закрыть подробности" onClick={closeDetails}>×</button></header>
            <nav className="do-inspector-tabs" aria-label="Подробности выбранного дела">{([{ id: "details", label: "Подробности" }, { id: "structure", label: "Структура" }, { id: "connections", label: "Связи" }] as const).map(item => <button key={item.id} type="button" aria-pressed={tab === item.id} onClick={() => setTab(item.id)}>{item.label}</button>)}</nav>
            <div className="do-scroll min-h-0 flex-1 overflow-y-auto" data-task-scroll-container data-task-drag-area="right" onDragOver={event => scrollDrag(event, "right")} onDragLeave={leaveScroll}>
              {tab === "structure" ? selectedTree.map(task => row(task, "right")) : tab === "connections" ? <div className="do-detail-body"><h2>Зависимости</h2>{selected.blockerIds.length === 0 && !tasks.some(task => task.blockerIds.includes(selected.id)) && <p className="do-muted">Связей пока нет</p>}{selected.blockerIds.map(id => <button type="button" className="do-connection" key={id} onClick={() => reveal(id)}>Блокер: {byId.get(id)?.title}</button>)}{tasks.filter(task => task.blockerIds.includes(selected.id)).map(task => <button type="button" className="do-connection" key={task.id} onClick={() => reveal(task.id)}>Зависит от этого дела: {task.title}</button>)}</div> : <div className="do-detail-body" key={selected.id}>
                {ancestors.length > 0 && <nav className="do-breadcrumbs" aria-label="Родители дела">{ancestors.map(task => <button key={task.id} type="button" onClick={() => reveal(task.id)}>{task.title}<span aria-hidden="true"> ›</span></button>)}</nav>}
                <textarea className="do-inspector-title" defaultValue={selected.title} maxLength={200} rows={2} aria-label="Название выбранного дела" onBlur={event => { void updateTask(selected.id, { title: event.target.value }); event.target.value = event.target.value.trim() || selected.title; }} />
                <div className="do-detail-properties"><label>Вид<select className="do-field" value={taskKind(selected).kind} disabled={selectedChildren.length > 0} onChange={event => { void updateTask(selected.id, { kind: event.target.value as TaskKind }); }}>{kinds.map(item => <option key={item.kind} value={item.kind}>{item.label}</option>)}</select></label><label>Статус<select className="do-field" value={selected.status} disabled={isContainer(selected) || selected.blockerIds.some(id => byId.get(id)?.status === "active")} onChange={event => { void updateTask(selected.id, { status: event.target.value as Task["status"] }); }}><option value="active">В работе</option><option value="completed">Выполнено</option><option value="not_completed">Отменено</option></select></label></div>
                <label className="do-detail-field">Описание<textarea className="do-field" rows={5} value={selected.description ?? ""} placeholder="Что нужно сделать?" onChange={event => { void updateTask(selected.id, { description: event.target.value }); }} /></label>
                <label className="do-detail-field">Результат<textarea className="do-field" rows={3} value={selected.result ?? ""} placeholder="Какой результат получен?" onChange={event => { void updateTask(selected.id, { result: event.target.value }); }} /></label>
                {isContainer(selected) && <section className="do-child-section"><div className="flex items-center justify-between gap-2"><h2>{selected.isMission ? "Квесты" : selected.isQuest ? "Цели" : "Задачи"}</h2><span className="do-muted">{selectedChildren.filter(task => isCountedStatus(task.status)).length} / {selectedChildren.length}</span></div><div className="do-child-list">{selectedChildren.map(task => <button className={`do-child is-${taskKind(task).kind}`} type="button" key={task.id} onClick={() => reveal(task.id)}><span className={`do-status ${isCountedStatus(task.status) ? "is-closed" : ""}`} aria-hidden="true">{isCountedStatus(task.status) ? "✓" : ""}</span><span className="do-number">{numbers.get(task.id)}</span><span className="min-w-0 flex-1">{task.title}</span><span aria-hidden="true">›</span></button>)}</div><form className="flex gap-2" onSubmit={event => { event.preventDefault(); createTask(childTitle, childKinds[taskKind(selected).kind]!, selected.id); setChildTitle(""); }}><input className="do-field min-w-0 flex-1" value={childTitle} onChange={event => setChildTitle(event.target.value)} maxLength={200} aria-label="Название вложенного дела" placeholder="Добавить вложенное дело" /><button type="submit" className="do-add-button" disabled={!childTitle.trim()} aria-label="Добавить вложенное дело">+</button></form></section>}
                <div className="do-detail-actions"><button type="button" className="do-secondary" onClick={() => moveSelected(-1)}>↑ Выше</button><button type="button" className="do-secondary" onClick={() => moveSelected(1)}>↓ Ниже</button>{selected.parentId && <button type="button" className="do-secondary" onClick={() => { void updateTask(selected.id, { parentId: null, siblingOrder: [...sortTasksByOrder(tasks.filter(task => !task.parentId)).map(task => task.id), selected.id] }); }}>Вынести из родителя</button>}<button type="button" className="do-delete" onClick={removeSelected}>Удалить</button></div>
              </div>}
            </div>
          </>}
        </aside>
      </div>
      <p className="do-status-message" role="status" aria-live="polite">{accountMessage || message || "Демонстрационные данные · Изменения сохраняются до перезагрузки страницы"}</p>
    </div>
  </main>;
}
