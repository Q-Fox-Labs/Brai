// ABOUTME: Выделяет документы плана, текущий прогресс и native цель из данных владельца.
// ABOUTME: Хранит только локальную видимость; история и жизненный цикл принадлежат Codex.
import type { DisplayItem, NativeSnapshot } from "@brai/agent/contracts";

export type Material = { id: string; title: string; fingerprint: string } & (
  { kind: "plan"; item: DisplayItem } | { kind: "progress"; value: NonNullable<NativeSnapshot["planProgress"]> } | { kind: "goal"; value: NonNullable<NativeSnapshot["goal"]> }
);
export type MaterialView = { open: boolean; focus: boolean; selected: string; seen: Record<string, string>; updated: string[] };
/** Пустая область не содержит собственной копии документов. */
export const emptyMaterialView = (): MaterialView => ({ open: false, focus: false, selected: "", seen: {}, updated: [] });

/** Предложенный документ отделён от transient шагов; missing поля старого owner не создают материал. */
export function collectMaterials(items: DisplayItem[], snapshot: NativeSnapshot | null): Material[] {
  const result: Material[] = items.filter(item => item.type === "plan").map((item, index) => ({ id: `plan:${item.id}`, title: `Предложенный план ${index + 1}`, kind: "plan", item, fingerprint: JSON.stringify([item.text, item.status, item.revision, item.truncated]) }));
  if (snapshot?.planProgress?.turnId && (snapshot.planProgress.state !== "unavailable" || snapshot.planProgress.steps.length > 0 || !!snapshot.planProgress.explanation)) result.push({ id: `progress:${snapshot.planProgress.turnId}`, title: "Ход выполнения", kind: "progress", value: snapshot.planProgress, fingerprint: JSON.stringify(snapshot.planProgress) });
  if (snapshot?.goal?.value) result.push({ id: `goal:${snapshot.goal.value.createdAt}`, title: "Цель", kind: "goal", value: snapshot.goal, fingerprint: JSON.stringify(snapshot.goal) });
  return result;
}

/** Новый материал открывается один раз; обновление уже закрытого отмечается без раскрытия. */
export function reconcileMaterialView(view: MaterialView, materials: Material[]): MaterialView {
  if (!materials.length) return view.open || view.updated.length ? { ...view, open: false, updated: [] } : view;
  const present = materials.some(value => value.id === view.selected);
  const updated = view.updated.filter(id => materials.some(value => value.id === id));
  const fresh = materials.filter(value => !(value.id in view.seen));
  const changed = materials.filter(value => value.id in view.seen && view.seen[value.id] !== value.fingerprint);
  if (!fresh.length && !changed.length) return present && updated.length === view.updated.length ? view : { ...view, selected: present ? view.selected : materials.at(-1)!.id, updated };
  const selected = fresh.at(-1)?.id ?? (present ? view.selected : materials.at(-1)!.id);
  const open = fresh.length > 0 || view.open;
  return { open, focus: fresh.length ? false : view.focus, selected, seen: { ...view.seen, ...Object.fromEntries(materials.map(value => [value.id, value.fingerprint])) }, updated: [...new Set([...updated, ...changed.filter(value => !open || value.id !== selected).map(value => value.id)])].filter(id => !open || id !== selected) };
}

/** Открытие прочитанного материала снимает отметку обновления. */
export function openMaterial(view: MaterialView, id: string): MaterialView {
  return { ...view, open: true, focus: true, selected: id, updated: view.updated.filter(value => value !== id) };
}

/** Исполнение получает точный завершённый документ и явное поручение, без планирующего режима. */
export function executionText(item: DisplayItem): string {
  if (item.type !== "plan" || item.status !== "completed" || item.truncated || !item.text.trim()) throw new Error("Дождитесь полного завершённого плана.");
  return `Реализуй следующий согласованный план:\n\n${item.text}`;
}

/** Незавершённая цель владеет промежутками между native ходами до явной паузы или завершения. */
export function goalBlocksNewTask(snapshot: NativeSnapshot | null): boolean {
  return !!snapshot?.goal?.value && !["paused", "complete"].includes(snapshot.goal.value.status);
}
