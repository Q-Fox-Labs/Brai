// ABOUTME: Описывает данные карты и вычисляет геометрию просмотра.
// ABOUTME: Сохранённая раскладка не меняет Ходы, ресурсы или зависимости.
export type Point = { x: number; y: number };
export type Viewport = Point & { zoom: number };
export type Provenance = { createdBy?: string | null; createdAt?: string | null; [key: string]: unknown };
export type Attempt = { id: string; moveId?: string; status: string; input?: unknown; result?: unknown; errorCode?: string | null; startedAt?: string; finishedAt?: string | null };
export type Element = { id: string; kind: string; parentId: string | null; status: string; revision: string; title: string; description: string; input: string[]; output: string[]; instructions?: string; conditions?: unknown; fields?: unknown; provenance?: Provenance; attempts?: Attempt[] };
/** ownerId — UUID Элемента, к которому относится Ход. */
export type Move = { id: string; ownerId: string; targetId: string; previousId: string | null; kind: string; purpose?: string; title: string; status: string; attemptId: string; executor: string; input: string[]; output: string[]; instructions?: string; conditions?: unknown; fields?: unknown; provenance?: Provenance; attempts?: Attempt[] };
export type ProjectedMove = { move: Move; order: number; shared: boolean };
export type MoveAnchor = { x: number; y: number; width: number };
export type Resource = { id: string; attemptId: string | null; title: string; content: string; metadata?: unknown; artifacts?: { id: string; name: string; available: boolean }[] };
export type BoardData = { elements: Element[]; moves: Move[]; resources: Resource[]; attempts?: Attempt[]; manualStatusEnabled?: boolean };
export type Layout = { positions: Record<string, Point>; view: Viewport };
export const cardWidth = 420;
export type CardHeights = Record<string, number>;
export const cardHeight = (id: string, heights: CardHeights) => heights[id] ?? 556;
const cardGap = 100;
const rowGap = 144;
/** Размещает каждый корень над его детьми и сохраняет места для неизвестных высот. */
export function initialPositions(elements: Element[], heights: CardHeights = {}): Record<string, Point> {
 const byId = new Map(elements.map(element => [element.id, element]));
 const children = new Map<string, Element[]>();
 for (const element of elements) if (element.parentId && byId.has(element.parentId)) children.set(element.parentId, [...(children.get(element.parentId) ?? []), element]);
 const roots = elements.filter(element => !element.parentId || !byId.has(element.parentId));
 const positions: Record<string, Point> = {};
 let cursor = 0;
 for (const root of roots) {
  const group = children.get(root.id) ?? [];
  const groupWidth = Math.max(cardWidth, group.length * cardWidth + Math.max(0, group.length - 1) * cardGap);
  const rootX = cursor + (groupWidth - cardWidth) / 2;
  positions[root.id] = { x: rootX, y: 0 };
  const childrenWidth = group.length * cardWidth + Math.max(0, group.length - 1) * cardGap;
  const childStart = cursor + (groupWidth - childrenWidth) / 2;
  group.forEach((child, index) => { positions[child.id] = { x: childStart + index * (cardWidth + cardGap), y: cardHeight(root.id, heights) + rowGap }; });
  cursor += groupWidth + cardGap;
 }
 for (const element of elements) if (!positions[element.id]) {
  positions[element.id] = { x: cursor, y: 0 };
  cursor += cardWidth + cardGap;
 }
 return positions;
}
/** Ограничивает масштаб для сохранения управляемого просмотра. */
export function clampZoom(value: number) { return Math.max(0.01, Math.min(1.6, value)); }
/** Показывает всю карту с отступами; пустой набор возвращает исходный просмотр. */
export function fitView(positions: Record<string, Point>, width: number, height: number, heights: CardHeights = {}): Viewport {
 const points = Object.values(positions);
 if (!points.length) return { x: 0, y: 0, zoom: 1 };
 const minX = Math.min(...points.map(p => p.x)), minY = Math.min(...points.map(p => p.y));
 const spanX = Math.max(...points.map(p => p.x)) + cardWidth - minX, spanY = Math.max(...Object.entries(positions).map(([id, p]) => p.y + cardHeight(id, heights))) - minY;
 const zoom = clampZoom(Math.min((width - 64) / spanX, (height - 64) / spanY, 1));
 return { x: (width - spanX * zoom) / 2 - minX * zoom, y: (height - spanY * zoom) / 2 - minY * zoom, zoom };
}
/** Читает только конечные координаты известных карточек; повреждение сбрасывает просмотр. */
export function readLayout(raw: string | null, defaults: Record<string, Point>, heights: CardHeights = {}): Layout | null {
 try {
  const value = JSON.parse(raw ?? 'null');
  const point = (p: Point) => p && Number.isFinite(p.x) && Number.isFinite(p.y) && Math.abs(p.x) < 1e7 && Math.abs(p.y) < 1e7;
  if (![1, 2].includes(value?.version) || !point(value.view) || !Number.isFinite(value.view.zoom) || value.view.zoom < 0.01 || value.view.zoom > 1.6) return null;
  const positions = { ...defaults };
  for (const id of Object.keys(defaults)) if (point(value.positions?.[id])) positions[id] = value.positions[id];
  // AIDEV-NOTE: v1 использовала фиксированную высоту. Сохраняем x и сдвигаем только пересечения вниз.
  if (value.version === 1) {
   const placed: string[] = [];
   for (const id of Object.keys(positions).sort((a, b) => positions[a].y - positions[b].y || positions[a].x - positions[b].x)) {
    positions[id] = { ...positions[id] };
    let conflict: string | undefined;
    do {
     const p = positions[id];
     conflict = placed.find(other => { const q = positions[other]; return p.x < q.x + cardWidth && p.x + cardWidth > q.x && p.y < q.y + cardHeight(other, heights) && p.y + cardHeight(id, heights) > q.y; });
     if (conflict) positions[id].y = positions[conflict].y + cardHeight(conflict, heights) + 144;
    } while (conflict);
    placed.push(id);
   }
  }
  return { positions, view: value.view };
 } catch { return null; }
}

/** Убирает повторные проекции, сортирует по predecessor и считает номер владельца. */
export function sequenceMoves(moves: Move[]): (Move & { order: number })[] {
 const unique = [...new Map(moves.map(move => [move.id, move])).values()];
 const byId = new Map(unique.map(move => [move.id, move]));
 const depths = new Map<string, number>();
 function depth(id: string, seen = new Set<string>()): number {
  if (depths.has(id)) return depths.get(id)!;
  if (seen.has(id)) return 0;
  seen.add(id);
  const previous = byId.get(id)?.previousId;
  const value = previous && byId.has(previous) ? depth(previous, seen) + 1 : 1;
  depths.set(id, value);
  return value;
 }
 function localOrder(move: Move): number {
  let order = 1, previous = move.previousId;
  const seen = new Set([move.id]);
  while (previous && !seen.has(previous)) {
   seen.add(previous);
   const ancestor = byId.get(previous);
   if (!ancestor) break;
   if (ancestor.ownerId === move.ownerId) order += 1;
   previous = ancestor.previousId;
  }
  return order;
 }
 return unique.map(move => ({ ...move, order: localOrder(move) })).sort((a, b) => depth(a.id) - depth(b.id));
}

/** Выбирает единую запись для владельца и, только у start/accept, её дочерней цели. */
export function projectMoves(moves: Move[], elementId: string): ProjectedMove[] {
 const ordered = sequenceMoves(moves);
 const sourceById = new Map(moves.map(move => [move.id, move]));
 const byId = new Map(ordered.map(move => [move.id, move]));
 const shared = (move: Move) => move.kind === "operation" && move.ownerId !== move.targetId && (move.purpose === "start" || move.purpose === "accept");
 const visible = new Set(ordered.filter(move => move.ownerId === elementId || (shared(move) && move.targetId === elementId)).map(move => move.id));
 const localOrder = (move: Move) => {
  let order = 1, previous = move.previousId;
  const seen = new Set([move.id]);
  while (previous && !seen.has(previous)) {
   seen.add(previous);
   const ancestor = byId.get(previous);
   if (!ancestor) break;
   if (visible.has(ancestor.id)) order += 1;
   previous = ancestor.previousId;
  }
  return order;
 };
 return ordered.filter(move => visible.has(move.id)).map(orderedMove => {
  const move = sourceById.get(orderedMove.id)!;
  return { move, order: localOrder(orderedMove), shared: shared(move) };
 });
}

/** Возвращает общие внешние точки строк для связи родителя и дочерней цели. */
export function sharedMoveLinkAnchors(parent: MoveAnchor, child: MoveAnchor, purpose: string) {
 const side = child.x < parent.x ? "left" : "right";
 const parentPoint = { x: side === "left" ? parent.x : parent.x + parent.width, y: parent.y };
 const childPoint = { x: side === "left" ? child.x : child.x + child.width, y: child.y };
 const gutterX = side === "left" ? Math.min(parent.x, child.x) - 60 : Math.max(parent.x + parent.width, child.x + child.width) + 60;
 return { start: purpose === "start" ? parentPoint : childPoint, end: purpose === "start" ? childPoint : parentPoint, gutterX, side };
}

/** Возвращает русскую подпись для каждого допустимого статуса без показа кода. */
export function statusPresentation(status: string, kind: "element" | "move") {
 if (kind === "element") {
  if (status === "draft") return { tone: "draft", label: "Черновик" };
  if (status === "active") return { tone: "active", label: "В работе" };
  if (status === "completed") return { tone: "completed", label: "Выполнена" };
  if (status === "cancelled") return { tone: "cancelled", label: "Отменена" };
 } else {
  if (status === "planned") return { tone: "planned", label: "Запланирован" };
  if (status === "claimed") return { tone: "active", label: "В работе" };
  if (status === "succeeded" || status === "completed") return { tone: "completed", label: "Выполнен" };
  if (status === "cancelled") return { tone: "cancelled", label: "Отменён" };
 }
 return { tone: "unknown", label: "Статус не указан" };
}
