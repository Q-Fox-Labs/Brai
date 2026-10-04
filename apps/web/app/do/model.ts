// ABOUTME: Вычисляет порядок, статусы и номера локального дерева «Дела».
// ABOUTME: Адаптировано из Brai_september; не обращается к API, хранилищу или БД.

export type TaskKind = "task" | "goal" | "quest" | "mission";
export type TaskStatus = "active" | "completed" | "not_completed";
export type Task = {
  id: string;
  publicId: string;
  relativeNumber: string | null;
  blockers: Task[];
  isDraft?: boolean;
  draftAfterId?: string;
  title: string;
  description: string | null;
  result: string | null;
  parentId: string | null;
  projectId: string | null;
  sortOrder: number;
  createdAt: number;
  status: TaskStatus;
  isGoal: boolean;
  isQuest: boolean;
  isMission: boolean;
  blockerIds: string[];
};
export type Project = { id: string; title: string; color: string };
export type OrderedTask = Task & { nestingDepth: number };
export type TaskUpdate = Partial<Pick<Task, "title" | "description" | "result" | "status" | "projectId" | "parentId">> & { siblingOrder?: string[]; kind?: TaskKind; blockerId?: string; removeBlockerId?: string };

type TaskKindSource = Pick<Task, "isGoal" | "isQuest" | "isMission">;

type TaskKindInfo = {
  kind: TaskKind;
  className: `is-${TaskKind}`;
  label: "Задача" | "Цель" | "Квест" | "Миссия";
};

/** Определяет, содержит ли запись вложенные элементы. */
export function isContainer(task: TaskKindSource) {
  return task.isGoal || task.isQuest || task.isMission;
}

/** Считает выполненные и отменённые записи закрытыми. */
export function isCountedStatus(status: TaskStatus) {
  return status === "completed" || status === "not_completed";
}

/** Возвращает вид записи и подпись для интерфейса. */
export function taskKind(task: TaskKindSource): TaskKindInfo {
  if (task.isMission) {
    return { kind: "mission", className: "is-mission", label: "Миссия" };
  }
  if (task.isQuest) {
    return { kind: "quest", className: "is-quest", label: "Квест" };
  }
  if (task.isGoal) {
    return { kind: "goal", className: "is-goal", label: "Цель" };
  }
  return { kind: "task", className: "is-task", label: "Задача" };
}

/** Сравнивает порядок соседей; при равенстве использует дату и стабильный ID. */
export function compareTaskOrder(
  first: Pick<Task, "id" | "sortOrder" | "createdAt">,
  second: Pick<Task, "id" | "sortOrder" | "createdAt">,
) {
  return first.sortOrder - second.sortOrder
    || second.createdAt - first.createdAt
    || first.id.localeCompare(second.id);
}

/** Возвращает отсортированную копию списка, не меняя исходные записи. */
export function sortTasksByOrder<T extends Pick<Task, "id" | "sortOrder" | "createdAt">>(
  tasks: readonly T[],
) {
  return [...tasks].sort(compareTaskOrder);
}

/** Группирует вложенные записи по родителю. */
export function groupTasksByParent(tasks: readonly Task[]) {
  const childrenByParent = new Map<string, Task[]>();
  for (const task of tasks) {
    if (!task.parentId) continue;
    const children = childrenByParent.get(task.parentId) ?? [];
    children.push(task);
    childrenByParent.set(task.parentId, children);
  }
  return childrenByParent;
}

/** Находит корень дерева; прекращает обход при цикле или отсутствующем родителе. */
export function taskTreeRoot(task: Task, taskById: ReadonlyMap<string, Task>) {
  const visitedIds = new Set<string>();
  let root = task;

  while (root.parentId && !visitedIds.has(root.id)) {
    visitedIds.add(root.id);
    const parent = taskById.get(root.parentId);
    if (!parent) break;
    root = parent;
  }
  return root;
}

/** Возвращает проект корня: дочерние записи наследуют принадлежность. */
export function taskTreeProjectId(task: Task, taskById: ReadonlyMap<string, Task>) {
  return taskTreeRoot(task, taskById).projectId;
}

/** Строит видимые строки дерева с глубиной; свёрнутые ветви пропускаются. */
export function orderTaskTree(
  tasks: readonly Task[],
  childrenByParent: ReadonlyMap<string, readonly Task[]>,
  collapsedContainerIds: ReadonlySet<string>,
) {
  const taskIds = new Set(tasks.map((task) => task.id));
  const topLevelTasks = sortTasksByOrder(
    tasks.filter((task) => !task.parentId || !taskIds.has(task.parentId)),
  );
  const ordered: OrderedTask[] = [];
  const visited = new Set<string>();

  const appendTask = (task: Task, nestingDepth: number) => {
    if (visited.has(task.id)) return;
    visited.add(task.id);
    ordered.push({ ...task, nestingDepth });
    if (!isContainer(task) || collapsedContainerIds.has(task.id)) return;
    for (const child of sortTasksByOrder(childrenByParent.get(task.id) ?? [])) {
      appendTask(child, nestingDepth + 1);
    }
  };

  topLevelTasks.forEach((task) => appendTask(task, 0));
  return ordered;
}

/** Собирает ID записи и всех её потомков. */
export function collectTaskAndDescendantIds(
  rootTaskId: string,
  childrenByParent: ReadonlyMap<string, readonly Task[]>,
) {
  const ids = new Set<string>();
  const collect = (taskId: string) => {
    if (ids.has(taskId)) return;
    ids.add(taskId);
    for (const child of childrenByParent.get(taskId) ?? []) collect(child.id);
  };
  collect(rootTaskId);
  return ids;
}

/** Проверяет, находится ли запись внутри указанной ветви. */
export function isTaskSelfOrDescendant(
  task: Task,
  rootTaskId: string,
  taskById: ReadonlyMap<string, Task>,
) {
  const visitedIds = new Set<string>();
  let currentTask: Task | undefined = task;

  while (currentTask && !visitedIds.has(currentTask.id)) {
    if (currentTask.id === rootTaskId) return true;
    visitedIds.add(currentTask.id);
    currentTask = currentTask.parentId
      ? taskById.get(currentTask.parentId)
      : undefined;
  }

  return false;
}

/** Проверяет допустимого родителя: миссия → квест → цель → задача, без циклов. */
export function canMoveTask(tasks: readonly Task[], id: string, parentId: string | null) {
  const byId = new Map(tasks.map(task => [task.id, task]));
  const task = byId.get(id);
  if (!task) return false;
  if (!parentId) return true;
  const parent = byId.get(parentId);
  if (!parent || isTaskSelfOrDescendant(parent, id, byId)) return false;
  const childKind: Partial<Record<TaskKind, TaskKind>> = { mission: "quest", quest: "goal", goal: "task" };
  return childKind[taskKind(parent).kind] === taskKind(task).kind;
}

/** Пересчитывает закрытие контейнеров по непосредственным детям снизу вверх. */
export function syncTaskStatuses(tasks: readonly Task[]): Task[] {
  const children = groupTasksByParent(tasks);
  const statuses = new Map<string, TaskStatus>();
  const resolve = (task: Task): TaskStatus => {
    if (!isContainer(task)) return task.status;
    const known = statuses.get(task.id);
    if (known) return known;
    const nested = children.get(task.id) ?? [];
    const status = nested.length > 0 && nested.every(child => isCountedStatus(resolve(child))) ? "completed" : "active";
    statuses.set(task.id, status);
    return status;
  };
  return tasks.map(task => ({ ...task, status: resolve(task) }));
}

/** Возвращает неизменяемое обновление; недопустимый перенос или статус игнорируется. */
export function updateLocalTask(tasks: readonly Task[], id: string, update: TaskUpdate): Task[] {
  const task = tasks.find(candidate => candidate.id === id);
  if (!task) return [...tasks];
  const children = groupTasksByParent(tasks);
  if ("parentId" in update && !canMoveTask(tasks, id, update.parentId ?? null)) return [...tasks];
  if (update.kind && children.has(id)) return [...tasks];
  if (update.status && (isContainer(task) || task.blockerIds.some(blockerId => tasks.some(candidate => candidate.id === blockerId && !isCountedStatus(candidate.status))))) return [...tasks];
  const { siblingOrder, kind, blockerId, removeBlockerId, ...fields } = update;
  if (fields.title !== undefined) {
    fields.title = fields.title.trim().slice(0, 200);
    if (!fields.title) return [...tasks];
  }
  let updated = { ...task, ...fields };
  if (blockerId && blockerId !== id && tasks.some(item => item.id === blockerId)) updated = { ...updated, blockerIds: [...new Set([...task.blockerIds, blockerId])] };
  if (removeBlockerId) updated = { ...updated, blockerIds: task.blockerIds.filter(value => value !== removeBlockerId) };
  if ("parentId" in update && !updated.parentId) updated = { ...updated, sortOrder: -updated.createdAt };
  if (kind) updated = { ...updated, isGoal: kind === "goal", isQuest: kind === "quest", isMission: kind === "mission", parentId: null, status: "active" };
  const root = "projectId" in update ? taskTreeRoot(task, new Map(tasks.map(item => [item.id, item]))) : task;
  const treeIds = collectTaskAndDescendantIds(root.id, children);
  const projectId = "parentId" in update && updated.parentId
    ? taskTreeProjectId(tasks.find(candidate => candidate.id === updated.parentId)!, new Map(tasks.map(candidate => [candidate.id, candidate])))
    : updated.projectId;
  const next = tasks.map(candidate => {
    let item = candidate.id === id ? updated : candidate;
    if (treeIds.has(item.id) && ("parentId" in update || "projectId" in update)) item = { ...item, projectId };
    const index = siblingOrder?.indexOf(item.id) ?? -1;
    return index < 0 ? item : { ...item, sortOrder: index };
  });
  return syncTaskStatuses(next);
}

/** Вычисляет номера M/Q/G/A-ID и позиции потомков из текущего порядка дерева. */
export function computeRelativeNumbers(tasks: readonly Task[]) {
  // AIDEV-NOTE: Номер зависит от порядка, публичный ID записи остаётся постоянным при переносе.
  const children = groupTasksByParent(tasks);
  const numbers = new Map<string, string>();
  const append = (task: Task, number: string) => {
    if (numbers.has(task.id)) return;
    numbers.set(task.id, number);
    sortTasksByOrder(children.get(task.id) ?? []).forEach((child, index) => append(child, `${number}-${index + 1}`));
  };
  sortTasksByOrder(tasks.filter(task => !task.parentId)).forEach(task => {
    const letter = { mission: "M", quest: "Q", goal: "G", task: "A" }[taskKind(task).kind];
    append(task, `${letter}-${Number.parseInt(task.publicId, 10)}`);
  });
  return numbers;
}
