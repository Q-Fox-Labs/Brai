// ABOUTME: Восстанавливает редактор названия и деталей из September.
// ABOUTME: Черновики и изменения сохраняются только в локальном состоянии.
import {
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
  useEffect,
  useRef,
  useState,
} from "react";
import { isContainer, sortTasksByOrder, type TaskUpdate } from "./model";
import type { Task } from "./types";
import type { TaskDragArea } from "./use-task-drag";
import {
  type DetailField,
  updateTaskDetailScrollbar,
} from "./task-ui";

type SetTasks = Dispatch<SetStateAction<Task[]>>;
type UpdateTask = (id: string, update: TaskUpdate, fallbackError: string) => Promise<boolean>;

type EditorOptions = {
  tasks: Task[];
  tasksRef: MutableRefObject<Task[]>;
  setTasks: SetTasks;
  setCollapsedContainerIds: Dispatch<SetStateAction<Set<string>>>;
  updateTask: UpdateTask;
};

/** Сохраняет исходные blur, Escape, Enter, Shift+Enter и Cmd+Enter в памяти экрана. */
export function useTaskEditor({
  tasks,
  tasksRef,
  setTasks,
  setCollapsedContainerIds,
  updateTask,
}: EditorOptions) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitleArea, setEditingTitleArea] = useState<TaskDragArea>("left");
  const [editingDetail, setEditingDetail] = useState<{
    taskId: string;
    field: DetailField;
    area: TaskDragArea;
  } | null>(null);
  const [taskTitleDrafts, setTaskTitleDrafts] = useState<Map<string, string>>(
    () => new Map(),
  );
  const [taskDetailDrafts, setTaskDetailDrafts] = useState<Map<string, string>>(
    () => new Map(),
  );
  const titleElementsRef = useRef(new Map<string, HTMLTextAreaElement>());
  const pendingTitleFocusRef = useRef<{ taskId: string; area: TaskDragArea } | null>(null);
  const detailElementsRef = useRef(new Map<string, HTMLTextAreaElement>());
  const skipBlurSaveIdsRef = useRef(new Set<string>());
  const skipDetailBlurKeysRef = useRef(new Set<string>());

  async function persistDraft(task: Task, title: string) {
    if (!task.isDraft) return null;
    const publicId = String(Math.max(100, ...tasksRef.current.map(item => Number(item.publicId) || 0)) + 1);
    const savedTask = { ...task, title, publicId, isDraft: false };
    setTasks(current => current.map(item => item.id === task.id ? savedTask : item));
    return savedTask;
  }

  useEffect(() => {
    const pendingFocus = pendingTitleFocusRef.current;
    if (!pendingFocus) return;
    const element = titleElementsRef.current.get(
      titleElementKey(pendingFocus.taskId, pendingFocus.area),
    );
    if (!element) return;
    pendingTitleFocusRef.current = null;
    element.focus();
    element.setSelectionRange(element.value.length, element.value.length);
  }, [editingId, tasks]);

  function titleElementKey(taskId: string, area: TaskDragArea) {
    return `${area}:${taskId}`;
  }

  function startEditingTitle(taskId: string, area: TaskDragArea) {
    setEditingTitleArea(area);
    setEditingId(taskId);
  }

  function focusTaskTitle(taskId: string, area: TaskDragArea) {
    pendingTitleFocusRef.current = { taskId, area };
    startEditingTitle(taskId, area);
  }

  function detailKey(taskId: string, field: DetailField) {
    return `${field}:${taskId}`;
  }

  function detailElementKey(taskId: string, field: DetailField, area: TaskDragArea) {
    return `${area}:${detailKey(taskId, field)}`;
  }

  function previewTaskTitle(taskId: string, value: string) {
    setTaskTitleDrafts((current) => {
      const next = new Map(current);
      next.set(taskId, value);
      return next;
    });
  }

  function clearTaskTitleDraft(taskId: string) {
    setTaskTitleDrafts((current) => {
      if (!current.has(taskId)) return current;
      const next = new Map(current);
      next.delete(taskId);
      return next;
    });
  }

  function previewTaskDetail(taskId: string, field: DetailField, value: string) {
    const key = detailKey(taskId, field);
    setTaskDetailDrafts((current) => {
      const next = new Map(current);
      next.set(key, value);
      return next;
    });
  }

  function clearTaskDetailDraft(taskId: string, field: DetailField) {
    const key = detailKey(taskId, field);
    setTaskDetailDrafts((current) => {
      if (!current.has(key)) return current;
      const next = new Map(current);
      next.delete(key);
      return next;
    });
  }

  function focusTaskDetail(
    taskId: string,
    field: DetailField,
    selectionStart = 0,
    area: TaskDragArea = "left",
  ) {
    setEditingDetail({ taskId, field, area });
    window.requestAnimationFrame(() => {
      const element = detailElementsRef.current.get(detailElementKey(taskId, field, area));
      if (!element) return;
      element.focus();
      const caretPosition = Math.min(selectionStart, element.value.length);
      element.setSelectionRange(caretPosition, caretPosition);
      updateTaskDetailScrollbar(element);
    });
  }

  function createDraft(
    source: Task,
    title: string,
    createChild = false,
    area: TaskDragArea = "left",
  ) {
    const draftId = `draft-${crypto.randomUUID()}`;
    const createdAt = source.createdAt;
    const shouldCreateChild = createChild && isContainer(source);
    const parentId = shouldCreateChild ? source.id : source.parentId;
    const draftAfterId = shouldCreateChild ? undefined : source.id;
    const isGoal = shouldCreateChild ? source.isQuest : source.isGoal;
    const isQuest = shouldCreateChild ? source.isMission : source.isQuest;
    const isMission = shouldCreateChild ? false : source.isMission;
    setTasks((current) => {
      const siblings = sortTasksByOrder(
        current.filter((task) => task.parentId === parentId && task.id !== source.id),
      );
      const firstTask = siblings[0];
      const nextTask = shouldCreateChild
        ? firstTask
        : siblings.find((task) => task.sortOrder > source.sortOrder);
      const sortOrder = shouldCreateChild
        ? (firstTask ? firstTask.sortOrder - 1 : 0)
        : nextTask
          ? (source.sortOrder + nextTask.sortOrder) / 2
          : source.sortOrder + 1;

      return [...current, {
        id: draftId,
        publicId: "",
        relativeNumber: null,
        title,
        description: null,
        result: null,
        status: "active",
        isGoal,
        isQuest,
        isMission,
        parentId,
        projectId: source.projectId,
        sortOrder,
        createdAt,
        blockers: [],
        blockerIds: [],
        isDraft: true,
        draftAfterId,
      }];
    });
    if (shouldCreateChild) {
      setCollapsedContainerIds((current) => {
        if (!current.has(source.id)) return current;
        const next = new Set(current);
        next.delete(source.id);
        return next;
      });
    }
    focusTaskTitle(draftId, area);
  }

  async function openDescriptionFromTitle(
    task: Task,
    element: HTMLTextAreaElement,
    area: TaskDragArea = "left",
  ) {
    const nextTitle = element.value.trim();
    if (!nextTitle) return;
    element.value = nextTitle;

    if (task.isDraft) {
      skipBlurSaveIdsRef.current.add(task.id);
      const savedTask = await persistDraft(task, nextTitle);
      if (savedTask) {
        clearTaskTitleDraft(task.id);
        focusTaskDetail(savedTask.id, "description", savedTask.description?.length ?? 0, area);
      } else {
        skipBlurSaveIdsRef.current.delete(task.id);
        element.focus();
      }
      return;
    }

    if (nextTitle !== task.title) {
      skipBlurSaveIdsRef.current.add(task.id);
      const saved = await updateTask(task.id, { title: nextTitle }, "Не удалось изменить название");
      if (!saved) {
        skipBlurSaveIdsRef.current.delete(task.id);
        element.focus();
        return;
      }
    }
    clearTaskTitleDraft(task.id);
    focusTaskDetail(task.id, "description", task.description?.length ?? 0, area);
  }

  async function commitTaskDetail(
    task: Task,
    field: DetailField,
    element: HTMLTextAreaElement,
  ) {
    const value = element.value.trim();
    element.value = value;
    if (value === (task[field] ?? "")) {
      clearTaskDetailDraft(task.id, field);
      return true;
    }
    const saved = await updateTask(
      task.id,
      { [field]: value || null },
      field === "description" ? "Не удалось изменить описание" : "Не удалось изменить результат",
    );
    clearTaskDetailDraft(task.id, field);
    return saved;
  }

  async function saveTaskDetail(
    task: Task,
    field: DetailField,
    element: HTMLTextAreaElement,
    area: TaskDragArea = "left",
  ) {
    const key = detailKey(task.id, field);
    if (skipDetailBlurKeysRef.current.delete(key)) return;
    element.scrollTop = 0;
    const saved = await commitTaskDetail(task, field, element);
    if (!saved) element.value = task[field] ?? "";
    if (document.activeElement !== element) {
      setEditingDetail((current) => current?.taskId === task.id
        && current.field === field
        && current.area === area
        ? null
        : current);
    }
  }

  async function createTaskFromDetail(
    task: Task,
    field: DetailField,
    element: HTMLTextAreaElement,
    createChild = false,
    area: TaskDragArea = "left",
  ) {
    const saved = await commitTaskDetail(task, field, element);
    if (!saved) {
      focusTaskDetail(task.id, field, 0, area);
      return;
    }
    skipDetailBlurKeysRef.current.add(detailKey(task.id, field));
    element.blur();
    setEditingDetail(null);
    createDraft(task, "", createChild, area);
  }

  async function splitTaskAtCursor(
    task: Task,
    element: HTMLTextAreaElement,
    createChild = false,
    area: TaskDragArea = "left",
  ) {
    const selectionStart = element.selectionStart ?? 0;
    const selectionEnd = element.selectionEnd ?? selectionStart;
    const titleBeforeCursor = element.value.slice(0, selectionStart).trim();
    if (!titleBeforeCursor) return;
    const titleAfterCursor = element.value.slice(selectionEnd).trim();
    element.value = titleBeforeCursor;
    skipBlurSaveIdsRef.current.add(task.id);

    let savedTask: Task | null = { ...task, title: titleBeforeCursor };
    if (task.isDraft) {
      savedTask = await persistDraft(task, titleBeforeCursor);
    } else if (titleBeforeCursor !== task.title) {
      const saved = await updateTask(
        task.id,
        { title: titleBeforeCursor },
        "Не удалось изменить название",
      );
      if (!saved) savedTask = null;
    }
    if (!savedTask) {
      skipBlurSaveIdsRef.current.delete(task.id);
      element.focus();
      return;
    }
    clearTaskTitleDraft(task.id);
    element.blur();
    createDraft(savedTask, titleAfterCursor, createChild, area);
  }

  async function saveTaskTitle(task: Task, element: HTMLTextAreaElement) {
    if (skipBlurSaveIdsRef.current.delete(task.id)) return;
    const title = element.value.trim();
    setEditingId(null);
    if (task.isDraft) {
      if (!title) {
        clearTaskTitleDraft(task.id);
        setTasks((current) => current.filter((currentTask) => currentTask.id !== task.id));
        return;
      }
      element.value = title;
      await persistDraft(task, title);
      clearTaskTitleDraft(task.id);
      return;
    }
    if (!title || title === task.title) {
      element.value = task.title;
      clearTaskTitleDraft(task.id);
      return;
    }
    element.value = title;
    const saved = await updateTask(task.id, { title }, "Не удалось изменить название");
    clearTaskTitleDraft(task.id);
    if (!saved) element.value = task.title;
  }

  return {
    createTaskFromDetail,
    detailElementKey,
    detailElementsRef,
    detailKey,
    editingDetail,
    editingId,
    editingTitleArea,
    focusTaskDetail,
    openDescriptionFromTitle,
    previewTaskDetail,
    previewTaskTitle,
    saveTaskDetail,
    saveTaskTitle,
    setEditingDetail,
    setEditingId,
    startEditingTitle,
    splitTaskAtCursor,
    taskDetailDrafts,
    taskTitleDrafts,
    titleElementKey,
    titleElementsRef,
  };
}
