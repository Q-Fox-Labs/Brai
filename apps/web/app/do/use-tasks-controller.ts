// ABOUTME: Подключает исходные компоненты September к синтетическим данным.
// ABOUTME: Команды и редакторы работают в памяти одного экрана, без API и БД.
import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type DragEvent, type FormEvent, type KeyboardEvent, type SetStateAction } from "react";
import { createDemoTasks, demoProjects } from "./demo";
import { collectTaskAndDescendantIds, computeRelativeNumbers, groupTasksByParent, isCountedStatus, isTaskSelfOrDescendant, orderTaskTree, sortTasksByOrder, syncTaskStatuses, taskTreeProjectId, taskTreeRoot, updateLocalTask, type Task, type TaskKind, type TaskUpdate } from "./model";
import { normalizedSearchText, startsAtWord } from "./task-ui";
import { useTaskDrag, type TaskDragArea } from "./use-task-drag";
import { useTaskEditor } from "./use-task-editor";
import type { TimeSession } from "./demo-timer";

export type DemoComment = { id: string; authorId: string; title: string | null; body: string; createdAt: number };
export type DemoHistoryEvent = { id: string; label: string; change: string; occurredAt: number; publicId: string };

/** Собирает исходные сценарии задачника; все данные принадлежат текущему аккаунту. */
export function useTasksController(active: boolean) {
  const [rawTasks, setRawTasks] = useState(createDemoTasks);
  const tasksRef = useRef(rawTasks);
  const setTasks: Dispatch<SetStateAction<Task[]>> = useCallback(action => {
    const next = typeof action === "function" ? action(tasksRef.current) : action;
    tasksRef.current = syncTaskStatuses(next);
    setRawTasks(tasksRef.current);
  }, []);
  const [projects, setProjects] = useState(() => [...demoProjects]);
  const [title, setTitle] = useState("");
  const [projectTitle, setProjectTitle] = useState("");
  const [selectedProjectFilter, setSelectedProjectFilter] = useState("all");
  const [collapsedContainerIds, setCollapsedContainerIds] = useState<Set<string>>(() => new Set());
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [rightOpenMenuId, setRightOpenMenuId] = useState<string | null>(null);
  const [deleteConfirmationId, setDeleteConfirmationId] = useState<string | null>(null);
  const [blockerSearchTaskId, setBlockerSearchTaskId] = useState<string | null>(null);
  const [blockerSearchArea, setBlockerSearchArea] = useState<TaskDragArea | null>(null);
  const [blockerQuery, setBlockerQuery] = useState("");
  const [draggedProjectId, setDraggedProjectId] = useState<string | null>(null);
  const [projectDropTarget, setProjectDropTarget] = useState<string | null>(null);
  const [activeSession, setActiveSession] = useState<TimeSession | null>(null);
  const [error, setError] = useState("");
  const [commentsByTask, setCommentsByTask] = useState<Record<string, DemoComment[]>>({});
  const [historyByTask, setHistoryByTask] = useState<Record<string, DemoHistoryEvent[]>>({});
  const taskJumpHighlightRef = useRef<Animation | null>(null);
  const taskJumpFrameRef = useRef<number | null>(null);
  const focusedMissionHashRef = useRef<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const projectInputRef = useRef<HTMLInputElement>(null);
  const blockerSearchInputRef = useRef<HTMLInputElement>(null);

  const tasks = useMemo(() => {
    const numbers = computeRelativeNumbers(rawTasks);
    const byId = new Map(rawTasks.map(task => [task.id, task]));
    return rawTasks.map(task => ({ ...task, relativeNumber: task.isDraft ? null : numbers.get(task.id) ?? null, blockers: task.blockerIds.map(id => byId.get(id)).filter((item): item is Task => Boolean(item)) }));
  }, [rawTasks]);
  const taskById = useMemo(() => new Map(tasks.map(task => [task.id, task])), [tasks]);
  const childTasksByParent = useMemo(() => groupTasksByParent(tasks), [tasks]);
  const visibleTasks = tasks.filter(task => selectedProjectFilter === "all" || (taskTreeProjectId(task, taskById) ?? "none") === selectedProjectFilter);
  const orderedTasks = orderTaskTree(visibleTasks, groupTasksByParent(visibleTasks), collapsedContainerIds);
  const selectedTask = taskById.get(selectedTaskId ?? "") ?? null;
  const blockedTaskIds = new Set<string>();
  for (const task of tasks) {
    if (task.blockers.some(blocker => !isCountedStatus(blocker.status))) {
      collectTaskAndDescendantIds(task.id, childTasksByParent).forEach(id => blockedTaskIds.add(id));
    }
  }
  const blockedTasksByBlocker = new Map<string, Task[]>();
  for (const task of tasks) for (const blocker of task.blockers) {
    blockedTasksByBlocker.set(blocker.id, [...blockedTasksByBlocker.get(blocker.id) ?? [], task]);
  }
  const updateTask = async (id: string, update: TaskUpdate, fallbackError = "Не удалось изменить задачу") => {
    if (update.status && blockedTaskIds.has(id)) { setError(fallbackError); return false; }
    setTasks(current => updateLocalTask(current, id, update));
    const labels: Record<string, string> = { title: "Изменено название", description: "Изменено описание", result: "Изменён результат", status: "Изменён статус", kind: "Изменён уровень", parentId: "Изменено расположение", projectId: "Изменён проект", siblingOrder: "Изменён порядок", blockerId: "Добавлен блокер", removeBlockerId: "Удалён блокер" };
    const field = Object.keys(update)[0];
    const history: DemoHistoryEvent = { id: crypto.randomUUID(), label: labels[field], change: typeof update[field as keyof TaskUpdate] === "string" ? String(update[field as keyof TaskUpdate]) : "", occurredAt: Date.now(), publicId: taskById.get(id)?.publicId ?? "" };
    setHistoryByTask(current => ({ ...current, [id]: [history, ...current[id] ?? []] }));
    return true;
  };
  const editor = useTaskEditor({ tasks, tasksRef, setTasks, setCollapsedContainerIds, updateTask });
  const drag = useTaskDrag({ tasks, childTasksByParent, active, editingId: editor.editingId, editingDetailTaskId: editor.editingDetail?.taskId ?? null, setOpenMenuId, setRightOpenMenuId, setCollapsedContainerIds, updateTask });

  const highlightTask = useCallback((taskId: string, area: "left" | "right" = "left") => {
    if (taskJumpFrameRef.current !== null) {
      window.cancelAnimationFrame(taskJumpFrameRef.current);
      taskJumpFrameRef.current = null;
    }
    taskJumpHighlightRef.current?.cancel();

    const scrollAndHighlight = (attempt = 0) => {
      const element = area === "left"
        ? document.getElementById(`task-${taskId}`)
        : Array.from(
          document.querySelectorAll<HTMLElement>(
            `[data-task-drag-area="${area}"] [data-task-row]`,
          ),
        ).find((row) => row.dataset.taskId === taskId) ?? null;
      if (!element) {
        if (attempt < 3) {
          taskJumpFrameRef.current = window.requestAnimationFrame(() => {
            scrollAndHighlight(attempt + 1);
          });
        }
        return;
      }
      taskJumpFrameRef.current = null;
      const taskScrollContainer = element.closest<HTMLElement>("[data-task-scroll-container]");
      const scrollContainer = taskScrollContainer
        && taskScrollContainer.scrollHeight > taskScrollContainer.clientHeight
        ? taskScrollContainer
        : element.closest<HTMLElement>("[data-primary-scroll-container]");
      if (scrollContainer) {
        const containerBounds = scrollContainer.getBoundingClientRect();
        const elementBounds = element.getBoundingClientRect();
        const top = scrollContainer.scrollTop + elementBounds.top - containerBounds.top - 16;
        scrollContainer.scrollTo({ top: Math.max(0, top) });
      } else {
        const navigationHeight = document.querySelector<HTMLElement>("[data-task-navigation]")
          ?.getBoundingClientRect().height ?? 0;
        const top = window.scrollY + element.getBoundingClientRect().top - navigationHeight - 16;
        window.scrollTo({ top: Math.max(0, top) });
      }

      const animation = element.animate([
        { boxShadow: "inset 0 0 0 999px rgba(57,127,211,0)" },
        { boxShadow: "inset 0 0 0 999px rgba(57,127,211,0.12)", offset: 0.45 },
        { boxShadow: "inset 0 0 0 999px rgba(57,127,211,0)" },
      ], {
        duration: 520,
        easing: "ease-in-out",
        iterations: 3,
      });
      taskJumpHighlightRef.current = animation;
      animation.onfinish = () => {
        if (taskJumpHighlightRef.current === animation) {
          taskJumpHighlightRef.current = null;
        }
      };
      animation.oncancel = animation.onfinish;
    };

    const elementIsRendered = area === "left"
      ? document.getElementById(`task-${taskId}`)
      : document.querySelector(`[data-task-drag-area="${area}"] [data-task-row]`);
    if (elementIsRendered) scrollAndHighlight();
    else taskJumpFrameRef.current = window.requestAnimationFrame(() => scrollAndHighlight(1));
  }, []);

  const openTaskInInspector = (id: string) => {
    if (!taskById.has(id)) return;
    setRightOpenMenuId(null);
    setSelectedTaskId(id);
    window.requestAnimationFrame(() => document.querySelector<HTMLElement>("[data-task-drag-area='right']")?.scrollTo({ top: 0 }));
  };
  const revealTask = useCallback((taskId: string) => {
    const task = taskById.get(taskId);
    if (!task) return;
    setSelectedTaskId(taskId);
    const ancestorIds = new Set<string>();
    let parentId = task.parentId;
    while (parentId) {
      ancestorIds.add(parentId);
      parentId = taskById.get(parentId)?.parentId ?? null;
    }
    if (ancestorIds.size > 0) {
      setCollapsedContainerIds((current) => {
        const next = new Set(current);
        ancestorIds.forEach((ancestorId) => next.delete(ancestorId));
        return next;
      });
    }
    highlightTask(taskId);
  }, [highlightTask, setCollapsedContainerIds, setSelectedTaskId, taskById]);

  useEffect(() => () => {
    if (taskJumpFrameRef.current !== null) {
      window.cancelAnimationFrame(taskJumpFrameRef.current);
    }
    taskJumpHighlightRef.current?.cancel();
  }, []);

  useEffect(() => {
    if (!active) return;
    const hash = window.location.hash;
    if (!hash.startsWith("#task-") || hash === focusedMissionHashRef.current) return;
    const taskId = hash.slice("#task-".length);
    if (!document.getElementById(`task-${taskId}`)) return;
    focusedMissionHashRef.current = hash;
    const frame = window.requestAnimationFrame(() => revealTask(taskId));
    return () => window.cancelAnimationFrame(frame);
  }, [active, revealTask]);

  const createTask = (nextTitle: string, kind: TaskKind = "task", parent: Task | null = null) => {
    const publicId = String(Math.max(100, ...tasksRef.current.map(item => Number(item.publicId) || 0)) + 1);
    const createdAt = Date.now();
    const siblings = sortTasksByOrder(tasksRef.current.filter(item => item.parentId === (parent?.id ?? null)));
    const task: Task = { id: crypto.randomUUID(), publicId, relativeNumber: null, title: nextTitle.trim().slice(0, 200), description: null, result: null, status: "active", isMission: kind === "mission", isQuest: kind === "quest", isGoal: kind === "goal", parentId: parent?.id ?? null, projectId: parent?.projectId ?? (selectedProjectFilter === "all" || selectedProjectFilter === "none" ? null : selectedProjectFilter), createdAt, sortOrder: parent ? (siblings[0]?.sortOrder ?? 1) - 1 : -createdAt, blockers: [], blockerIds: [] };
    setTasks(current => [...current, task]);
    return task;
  };
  const addTask = (event: FormEvent<HTMLFormElement> | KeyboardEvent<HTMLInputElement>, focusDescription = false) => {
    event.preventDefault();
    if (!title.trim()) return;
    const task = createTask(title);
    setTitle("");
    if (focusDescription) { setSelectedTaskId(task.id); editor.focusTaskDetail(task.id, "description"); }
    else window.requestAnimationFrame(() => inputRef.current?.focus());
  };
  const addChildTask = async (task: Task, value: string) => {
    const kind = task.isMission ? "quest" : task.isQuest ? "goal" : "task";
    setCollapsedContainerIds(current => {
      const next = new Set(current);
      next.delete(task.id);
      return next;
    });
    return createTask(value, kind, task);
  };
  const closeBlockerSearch = () => { setBlockerSearchTaskId(null); setBlockerSearchArea(null); setBlockerQuery(""); };
  const openBlockerSearch = (task: Task, area: TaskDragArea) => {
    setOpenMenuId(null); setDeleteConfirmationId(null); setBlockerSearchTaskId(task.id); setBlockerSearchArea(area); setBlockerQuery("");
    window.requestAnimationFrame(() => blockerSearchInputRef.current?.focus());
  };
  const query = normalizedSearchText(blockerQuery);
  const attached = new Set(taskById.get(blockerSearchTaskId ?? "")?.blockerIds);
  const blockerSearchResults = !blockerSearchTaskId || query.length < 3 ? [] : tasks.filter(task => !task.isDraft && !attached.has(task.id)).map(task => ({ task, matchIndex: task.publicId === query ? 0 : normalizedSearchText(task.title).indexOf(query), identifierMatch: task.publicId === query, isUnavailable: isTaskSelfOrDescendant(task, blockerSearchTaskId, taskById) })).filter(item => item.matchIndex >= 0).sort((a, b) => Number(a.isUnavailable) - Number(b.isUnavailable) || Number(isCountedStatus(a.task.status)) - Number(isCountedStatus(b.task.status)) || Number(b.identifierMatch) - Number(a.identifierMatch) || a.matchIndex - b.matchIndex || Number(!startsAtWord(a.task.title, a.matchIndex)) - Number(!startsAtWord(b.task.title, b.matchIndex)) || a.task.title.localeCompare(b.task.title, "ru") || b.task.createdAt - a.task.createdAt).slice(0, 10);
  const selectBlocker = async (id: string) => {
    const blocker = taskById.get(id);
    if (!blockerSearchTaskId || !blocker) return;
    if (isTaskSelfOrDescendant(blocker, blockerSearchTaskId, taskById)) { setError("Нельзя выбрать сам элемент или вложенный в него элемент в качестве блокера"); return; }
    await updateTask(blockerSearchTaskId, { blockerId: id });
    closeBlockerSearch();
  };
  const deleteTask = (task: Task) => {
    if (deleteConfirmationId !== task.id) { setDeleteConfirmationId(task.id); return; }
    const removed = collectTaskAndDescendantIds(task.id, childTasksByParent);
    setTasks(current => current.filter(item => !removed.has(item.id)).map(item => ({ ...item, blockerIds: item.blockerIds.filter(id => !removed.has(id)) })));
    if (selectedTaskId && removed.has(selectedTaskId)) setSelectedTaskId(null);
    setOpenMenuId(null); setRightOpenMenuId(null); setDeleteConfirmationId(null);
  };
  const addProject = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!projectTitle.trim()) return false;
    setProjects(current => [...current, { id: crypto.randomUUID(), title: projectTitle.trim(), color: "#b3a2ff" }]); setProjectTitle(""); return true;
  };
  const startDraggingProject = (event: DragEvent<HTMLElement>, id: string) => {
    drag.finishDragging(); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("application/x-brai-project", id); setDraggedProjectId(id); setProjectDropTarget(null);
  };
  const finishDraggingProject = () => { setDraggedProjectId(null); setProjectDropTarget(null); };
  const dropProject = (event: DragEvent<HTMLElement>, targetId: string) => {
    event.preventDefault(); event.stopPropagation();
    const id = draggedProjectId ?? event.dataTransfer.getData("application/x-brai-project");
    const bounds = event.currentTarget.getBoundingClientRect(), after = event.clientY >= bounds.top + bounds.height / 2;
    setProjects(current => { const moving = current.find(item => item.id === id), next = current.filter(item => item.id !== id), index = next.findIndex(item => item.id === targetId); if (!moving || index < 0) return current; next.splice(index + Number(after), 0, moving); return next; });
    finishDraggingProject();
  };
  const dropTaskOnProject = async (event: DragEvent<HTMLElement>, projectId: string | null) => {
    event.preventDefault(); event.stopPropagation();
    const id = drag.draggedId ?? event.dataTransfer.getData("text/plain"), task = taskById.get(id);
    drag.finishDragging(); setProjectDropTarget(null);
    if (task) await updateTask(taskTreeRoot(task, taskById).id, { projectId });
  };
  const addComment = (id: string, comment: Omit<DemoComment, "id" | "authorId" | "createdAt">) => {
    const row = { ...comment, id: crypto.randomUUID(), authorId: "demo", createdAt: Date.now() };
    setCommentsByTask(current => ({ ...current, [id]: [...current[id] ?? [], row] }));
  };
  return {
    commentsByTask,
    historyByTask,
    addComment,
    ...editor,
    ...drag,
    tasks,
    taskById,
    childTasksByParent,
    visibleTasks,
    orderedTasks,
    selectedTask,
    selectedTaskId,
    setSelectedTaskId,
    collapsedContainerIds,
    projects,
    projectTitle,
    setProjectTitle,
    selectedProjectFilter,
    setSelectedProjectFilter,
    title,
    setTitle,
    inputRef,
    projectInputRef,
    addTask,
    addChildTask,
    addProject,
    updateTask,
    openMenuId,
    setOpenMenuId,
    rightOpenMenuId,
    setRightOpenMenuId,
    deleteConfirmationId,
    setDeleteConfirmationId,
    deleteTask,
    changeTaskKind: (task: Task, kind: TaskKind, fallback: string) => {
      setOpenMenuId(null);
      setDeleteConfirmationId(null);
      return updateTask(task.id, { kind }, fallback);
    },
    blockedTaskIds,
    blockedTasksByBlocker,
    blockerQuery,
    setBlockerQuery,
    blockerSearchInputRef,
    blockerSearchResults,
    blockerSearchTaskId,
    blockerSearchArea,
    openBlockerSearch,
    closeBlockerSearch,
    selectBlocker,
    removeBlocker: (id: string, blockerId: string) => updateTask(id, { removeBlockerId: blockerId }),
    highlightTask,
    revealTask,
    openTaskInInspector,
    activeSession,
    startMissionTimer: (task: Task) => {
      setOpenMenuId(null);
      setActiveSession({ missionId: task.id, startedAt: Date.now() });
    },
    stopMissionTimer: () => setActiveSession(null),
    isTaskChanging: (id: string) => !taskById.has(id),
    isTimerMutating: false,
    isLoading: false,
    isAdding: false,
    isProjectsLoading: false,
    isAddingProject: false,
    draggedProjectId,
    projectDropTarget,
    setProjectDropTarget,
    startDraggingProject,
    finishDraggingProject,
    dropProject,
    dropTaskOnProject,
    error,
    setError,
  };
}

export type TasksController = ReturnType<typeof useTasksController>;
