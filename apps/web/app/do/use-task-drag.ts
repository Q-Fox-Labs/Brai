// ABOUTME: Переносит записи дерева и прокручивает панель у краёв во время переноса.
// ABOUTME: Адаптировано из Brai_september/app/tasks/use-task-drag.ts; команды меняют только память.
import {
  type Dispatch,
  type DragEvent,
  type SetStateAction,
  useEffect,
  useRef,
  useState,
} from "react";
import { sortTasksByOrder, type TaskUpdate, type Task } from "./model";

// AIDEV-NOTE: Скорости исходного задачника заданы в пикселях в секунду, независимо от частоты кадров.
const DRAG_SCROLL_SLOW_SPEED = 72;
const DRAG_SCROLL_FAST_MULTIPLIER = 3;

export type TaskDragArea = "left" | "right";

type DragOptions = {
  tasks: Task[];
  childTasksByParent: Map<string, Task[]>;
  active: boolean;
  setCollapsedContainerIds: Dispatch<SetStateAction<Set<string>>>;
  updateTask: (id: string, update: TaskUpdate) => void;
};

/** Управляет переносом внутри одной панели и прокруткой её краёв; скрытие экрана отменяет перенос. */
export function useTaskDrag({
  tasks,
  childTasksByParent,
  active,
  setCollapsedContainerIds,
  updateTask,
}: DragOptions) {
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [dragArea, setDragArea] = useState<TaskDragArea | null>(null);
  const dragScrollFrameRef = useRef<number | null>(null);
  const dragScrollDirectionRef = useRef<-1 | 0 | 1>(0);
  const dragScrollSpeedRef = useRef(0);
  const dragScrollLastTimestampRef = useRef<number | null>(null);
  const dragScrollElementRef = useRef<HTMLElement | null>(null);

  const draggedTask = tasks.find((task) => task.id === draggedId) ?? null;
  const isDraggingChild = Boolean(draggedTask?.parentId);

  useEffect(() => {
    if (!active) {
      if (dragScrollFrameRef.current !== null) window.cancelAnimationFrame(dragScrollFrameRef.current);
      dragScrollFrameRef.current = null;
      dragScrollDirectionRef.current = 0;
      dragScrollLastTimestampRef.current = null;
      setDraggedId(null);
      setDragArea(null);
      setDropTarget(null);
    }
    return () => {
      if (dragScrollFrameRef.current !== null) window.cancelAnimationFrame(dragScrollFrameRef.current);
    };
  }, [active]);

  function startDragging(event: DragEvent<HTMLElement>, task: Task, area: TaskDragArea) {
    const target = event.target as HTMLElement;
    if (
      target.closest("input, textarea, select, button, a, [data-task-detail]")
    ) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", task.id);
    const taskScrollContainer = target.closest<HTMLElement>("[data-task-scroll-container]");
    dragScrollElementRef.current = taskScrollContainer;
    stopDragScrolling();
    setDropTarget(null);
    setDragArea(area);
    setDraggedId(task.id);
  }

  function stopDragScrolling() {
    if (dragScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(dragScrollFrameRef.current);
      dragScrollFrameRef.current = null;
    }
    dragScrollDirectionRef.current = 0;
    dragScrollSpeedRef.current = 0;
    dragScrollLastTimestampRef.current = null;
  }

  function scrollWhileDragging(timestamp: number) {
    const direction = dragScrollDirectionRef.current;
    const speed = dragScrollSpeedRef.current;
    const previousTimestamp = dragScrollLastTimestampRef.current;
    if (!direction || !speed) {
      dragScrollFrameRef.current = null;
      return;
    }
    if (previousTimestamp !== null) {
      const elapsed = Math.min(timestamp - previousTimestamp, 64);
      dragScrollElementRef.current?.scrollBy(0, direction * speed * elapsed / 1000);
    }
    dragScrollLastTimestampRef.current = timestamp;
    dragScrollFrameRef.current = window.requestAnimationFrame(scrollWhileDragging);
  }

  function updateDragScrolling(
    event: DragEvent<HTMLDivElement>,
    position: "top" | "bottom",
  ) {
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    const bounds = event.currentTarget.getBoundingClientRect();
    const distanceFromEdge = position === "top"
      ? event.clientY - bounds.top
      : bounds.bottom - event.clientY;
    const isCloserToEdge = distanceFromEdge < 28;
    dragScrollDirectionRef.current = position === "top" ? -1 : 1;
    dragScrollSpeedRef.current = DRAG_SCROLL_SLOW_SPEED
      * (isCloserToEdge ? DRAG_SCROLL_FAST_MULTIPLIER : 1);
    if (dragScrollFrameRef.current === null) {
      dragScrollLastTimestampRef.current = null;
      dragScrollFrameRef.current = window.requestAnimationFrame(scrollWhileDragging);
    }
  }

  function finishDragging() {
    stopDragScrolling();
    dragScrollElementRef.current = null;
    setDraggedId(null);
    setDragArea(null);
    setDropTarget(null);
  }

  function toggleContainer(containerId: string) {
    setCollapsedContainerIds((current) => {
      const next = new Set(current);
      if (next.has(containerId)) next.delete(containerId);
      else next.add(containerId);
      return next;
    });
  }

  function moveTask(
    taskId: string,
    parentId: string,
    targetId?: string,
    edge: "before" | "after" = "after",
  ) {
    const movingTask = tasks.find((task) => task.id === taskId);
    if (!movingTask) return;
    const siblings = sortTasksByOrder(
      tasks.filter((task) => task.parentId === parentId && task.id !== taskId),
    );
    const insertionIndex = targetId
      ? siblings.findIndex((task) => task.id === targetId)
      : siblings.length;
    if (targetId && insertionIndex < 0) return;
    siblings.splice(edge === "after" ? insertionIndex + 1 : insertionIndex, 0, movingTask);
    updateTask(
      taskId,
      { parentId, siblingOrder: siblings.map((task) => task.id) },
    );
  }

  function moveRootTask(
    containerId: string,
    targetId: string,
    edge: "before" | "after",
  ) {
    const movingContainer = tasks.find((task) => task.id === containerId);
    if (!movingContainer || movingContainer.parentId) return;
    const siblings = sortTasksByOrder(
      tasks.filter((task) => !task.parentId && task.id !== containerId),
    );
    const insertionIndex = siblings.findIndex((container) => container.id === targetId);
    if (insertionIndex < 0) return;
    siblings.splice(
      edge === "after" ? insertionIndex + 1 : insertionIndex,
      0,
      movingContainer,
    );
    updateTask(
      containerId,
      { siblingOrder: siblings.map((container) => container.id) },
    );
  }

  function insertionEdge(event: DragEvent<HTMLElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    return event.clientY < bounds.top + bounds.height / 2 ? "before" as const : "after" as const;
  }

  function dropIntoContainer(event: DragEvent<HTMLElement>, container: Task) {
    event.preventDefault();
    event.stopPropagation();
    const taskId = draggedId ?? event.dataTransfer.getData("text/plain");
    finishDragging();
    if (!taskId || taskId === container.id) return;
    const firstChild = sortTasksByOrder(
      (childTasksByParent.get(container.id) ?? []).filter((task) => task.id !== taskId),
    )[0];
    moveTask(taskId, container.id, firstChild?.id, "before");
  }

  function dropBesideNestedTask(event: DragEvent<HTMLElement>, target: Task) {
    event.preventDefault();
    event.stopPropagation();
    const taskId = draggedId ?? event.dataTransfer.getData("text/plain");
    const edge = insertionEdge(event);
    finishDragging();
    if (!taskId || !target.parentId || taskId === target.id) return;
    moveTask(taskId, target.parentId, target.id, edge);
  }

  function dropBesideRootTask(event: DragEvent<HTMLElement>, target: Task) {
    event.preventDefault();
    event.stopPropagation();
    const containerId = draggedId ?? event.dataTransfer.getData("text/plain");
    const edge = insertionEdge(event);
    finishDragging();
    if (!containerId || containerId === target.id) return;
    moveRootTask(containerId, target.id, edge);
  }

  function dropOutsideParent(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    event.stopPropagation();
    const taskId = draggedId ?? event.dataTransfer.getData("text/plain");
    finishDragging();
    if (taskId && isDraggingChild) {
      updateTask(taskId, { parentId: null, siblingOrder: [...sortTasksByOrder(tasks.filter(task => !task.parentId)).map(task => task.id), taskId] });
    }
  }

  return {
    dragArea,
    draggedId,
    dropBesideNestedTask,
    dropBesideRootTask,
    dropIntoContainer,
    dropOutsideParent,
    dropTarget,
    finishDragging,
    insertionEdge,
    isDraggingChild,
    setDropTarget,
    startDragging,
    stopDragScrolling,
    toggleContainer,
    updateDragScrolling,
  };
}
