// ABOUTME: Описывает данные карты и вычисляет геометрию просмотра.
// ABOUTME: Сохранённая раскладка не меняет Ходы, ресурсы или зависимости.
export type Point = { x: number; y: number };
export type Viewport = Point & { zoom: number };
export type Element = { id: string; kind: string; parentId: string | null; revision: string; title: string; description: string; input: string[]; output: string[] };
export type Move = { id: string; ownerId: string; targetId: string; previousId: string | null; kind: string; title: string; status: string; attemptId: string; executor: string; input: string[]; output: string[] };
export type Resource = { id: string; attemptId: string | null; title: string; content: string };
export type BoardData = { elements: Element[]; moves: Move[]; resources: Resource[] };
export type Layout = { positions: Record<string, Point>; view: Viewport };
export const cardWidth = 420;
export const cardHeight = 556;
/** Размещает корни над дочерними Элементами; новые ID не требуют разметки. */
export function initialPositions(elements: Element[]): Record<string, Point> {
 const roots = elements.filter(e => !e.parentId || !elements.some(p => p.id === e.parentId));
 const children = elements.filter(e => !roots.includes(e));
 return Object.fromEntries([...roots.map((e, i) => [e.id, { x: i * 520 + Math.max(0, children.length - 1) * 260, y: 0 }]), ...children.map((e, i) => [e.id, { x: i * 520, y: 700 }])]);
}
/** Ограничивает масштаб для сохранения управляемого просмотра. */
export function clampZoom(value: number) { return Math.max(0.2, Math.min(1.6, value)); }
/** Показывает всю карту с отступами; пустой набор возвращает исходный просмотр. */
export function fitView(positions: Record<string, Point>, width: number, height: number): Viewport {
 const points = Object.values(positions);
 if (!points.length) return { x: 0, y: 0, zoom: 1 };
 const minX = Math.min(...points.map(p => p.x)), minY = Math.min(...points.map(p => p.y));
 const spanX = Math.max(...points.map(p => p.x)) + cardWidth - minX, spanY = Math.max(...points.map(p => p.y)) + cardHeight - minY;
 const zoom = clampZoom(Math.min((width - 64) / spanX, (height - 64) / spanY, 1));
 return { x: (width - spanX * zoom) / 2 - minX * zoom, y: (height - spanY * zoom) / 2 - minY * zoom, zoom };
}
/** Читает только конечные координаты известных карточек; повреждение сбрасывает просмотр. */
export function readLayout(raw: string | null, defaults: Record<string, Point>): Layout | null {
 try {
  const value = JSON.parse(raw ?? 'null');
  const point = (p: Point) => p && Number.isFinite(p.x) && Number.isFinite(p.y) && Math.abs(p.x) < 1e7 && Math.abs(p.y) < 1e7;
  if (value?.version !== 1 || !point(value.view) || !Number.isFinite(value.view.zoom) || value.view.zoom < 0.2 || value.view.zoom > 1.6) return null;
  const positions = { ...defaults };
  for (const id of Object.keys(defaults)) if (point(value.positions?.[id])) positions[id] = value.positions[id];
  return { positions, view: value.view };
 } catch { return null; }
}

/** Сортирует по предшественникам и считает номер только среди Ходов владельца. */
export function sequenceMoves(moves: Move[]): (Move & { order: number })[] {
 const byId = new Map(moves.map(move => [move.id, move]));
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
 return moves.map(move => ({ ...move, order: localOrder(move) })).sort((a, b) => depth(a.id) - depth(b.id));
}
