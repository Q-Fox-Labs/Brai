// ABOUTME: Формирует раскрываемое дерево целей с сохранением контекста предков.
// ABOUTME: Некорректные или недоступные связи не скрывают остальные записи.
export type GoalRow = Record<string, string | boolean | null>;
export type GoalTreeItem = { row: GoalRow; depth: number; hasChildren: boolean; expanded: boolean; matches: boolean };
const idOf = (row: GoalRow) => typeof row.id === "string" ? row.id : "";
const parentOf = (row: GoalRow) => typeof row.parent_goal_id === "string" ? row.parent_goal_id : "";

/** Сохраняет совпадения и их предков; циклы выводит один раз без бесконечного обхода. */
export function buildGoalTree(goals: GoalRow[], matching: Set<string>, collapsed: Set<string>, filtering: boolean): GoalTreeItem[] {
 const byId = new Map(goals.map(row => [idOf(row), row]).filter(([id]) => !!id) as [string, GoalRow][]);
 const included = new Set<string>();
 for (const id of matching) {
  const path = new Set<string>();
  let current = id;
  while (current && byId.has(current) && !path.has(current) && !included.has(current)) {
   path.add(current); included.add(current); current = parentOf(byId.get(current)!);
  }
 }
 const children = new Map<string, string[]>(), roots: string[] = [];
 for (const row of goals) {
  const id = idOf(row), parent = parentOf(row);
  if (!included.has(id)) continue;
  if (!parent || parent === id || !included.has(parent)) roots.push(id);
  else { const group = children.get(parent) ?? []; group.push(id); children.set(parent, group); }
 }
 const result: GoalTreeItem[] = [], visited = new Set<string>();
 const walk = (root: string) => {
  const stack = [{ id: root, depth: 0 }];
  while (stack.length) {
   const { id, depth } = stack.pop()!;
   if (visited.has(id)) continue;
   visited.add(id);
   const nested = (children.get(id) ?? []).filter(child => !visited.has(child));
   const expanded = filtering || !collapsed.has(id);
   result.push({ row: byId.get(id)!, depth, hasChildren: nested.length > 0, expanded, matches: matching.has(id) });
   if (expanded) for (const child of [...nested].reverse()) stack.push({ id: child, depth: depth + 1 });
  }
 };
 roots.forEach(walk);
 // Записи без корня возможны только при повреждённой циклической связи.
 const rooted = new Set<string>(), pending = [...roots];
 while (pending.length) {
  const id = pending.pop()!;
  if (rooted.has(id)) continue;
  rooted.add(id); pending.push(...(children.get(id) ?? []));
 }
 for (const id of included) if (!rooted.has(id) && !visited.has(id)) walk(id);
 return result;
}

/** Возвращает путь к выбранной цели, останавливаясь на отсутствующей или повторной записи. */
export function goalPath(goals: GoalRow[], selectedId: string): GoalRow[] {
 const byId = new Map(goals.map(row => [idOf(row), row]));
 const seen = new Set<string>(), path: GoalRow[] = [];
 let id = selectedId;
 while (id && byId.has(id) && !seen.has(id)) {
  seen.add(id); const row = byId.get(id)!; path.push(row); id = parentOf(row);
 }
 return path.reverse();
}
