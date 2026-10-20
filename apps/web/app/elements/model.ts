// ABOUTME: Описывает данные карты и вычисляет геометрию просмотра.
// ABOUTME: Сохранённая раскладка не меняет Ходы, ресурсы или зависимости.
export type Point = { x: number; y: number };
export type Viewport = Point & { zoom: number };
export type Provenance = { createdBy?: string | null; createdAt?: string | null; [key: string]: unknown };
export type Attempt = { id: string; moveId?: string; status: string; input?: unknown; result?: unknown; errorCode?: string | null; startedAt?: string; finishedAt?: string | null };
export type Element = { id: string; kind: string; parentId: string | null; status: string; revision: string; title: string; description: string; input: string[]; output: string[]; instructions?: string; conditions?: unknown; fields?: unknown; provenance?: Provenance; attempts?: Attempt[] };
/** ownerId — UUID Элемента, к которому относится Ход. */
export type Move = { id: string; ownerId: string; targetId: string; previousId: string | null; kind: string; purpose?: string; title: string; status: string; attemptId: string; executor: string; input: string[]; output: string[]; instructions?: string; conditions?: unknown; requiredResourceIds?: string[]; requiredOutputContracts?: { moveId: string; outputKey: string; revisionId: string }[]; fields?: unknown; provenance?: Provenance; attempts?: Attempt[] };
export type ProjectedMove = { move: Move; order: number; shared: boolean };
export type MoveAnchor = { x: number; y: number; width: number };
export type ResourceMoveLink = { id: string; resourceId: string; resourceTitle: string; producerId: string; consumerId: string; fromElementId: string; toElementId: string; expected: boolean };
export type Resource = { id: string; attemptId: string | null; title: string; content: string; metadata?: unknown; artifacts?: { id: string; name: string; available: boolean }[] };
export type BoardData = { elements: Element[]; moves: Move[]; resources: Resource[]; attempts?: Attempt[]; manualStatusEnabled?: boolean; readyMoveIds?: string[] };
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
 const subtreeWidths = new Map<string, number>();
 function subtreeWidth(element: Element, path = new Set<string>()): number {
  if (subtreeWidths.has(element.id)) return subtreeWidths.get(element.id)!;
  if (path.has(element.id)) return cardWidth;
  const nextPath = new Set(path).add(element.id);
  const group = (children.get(element.id) ?? []).filter(child => !nextPath.has(child.id));
  const descendantsWidth = group.reduce((sum, child) => sum + subtreeWidth(child, nextPath), 0) + Math.max(0, group.length - 1) * cardGap;
  const width = Math.max(cardWidth, descendantsWidth);
  subtreeWidths.set(element.id, width);
  return width;
 }
 function place(element: Element, left: number, top: number, path = new Set<string>()) {
  if (path.has(element.id)) return;
  const width = subtreeWidth(element);
  positions[element.id] = { x: left + (width - cardWidth) / 2, y: top };
  const nextPath = new Set(path).add(element.id);
  const group = (children.get(element.id) ?? []).filter(child => !nextPath.has(child.id));
  const childrenWidth = group.reduce((sum, child) => sum + subtreeWidth(child), 0) + Math.max(0, group.length - 1) * cardGap;
  let childLeft = left + (width - childrenWidth) / 2;
  for (const child of group) {
   place(child, childLeft, top + cardHeight(element.id, heights) + rowGap, nextPath);
   childLeft += subtreeWidth(child) + cardGap;
  }
 }
 let cursor = 0;
 for (const root of roots) {
  place(root, cursor, 0);
  cursor += subtreeWidth(root) + cardGap;
 }
 for (const element of elements) if (!positions[element.id]) {
  place(element, cursor, 0);
  cursor += subtreeWidth(element) + cardGap;
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
  // AIDEV-NOTE: Новые группы не занимают места сохранённых вручную карточек.
  const savedIds = Object.keys(defaults).filter(id => point(value.positions?.[id]));
  const addedIds = Object.keys(defaults).filter(id => !savedIds.includes(id));
  if (savedIds.length && addedIds.length) {
   const right = Math.max(...savedIds.map(id => positions[id].x + cardWidth));
   const left = Math.min(...addedIds.map(id => positions[id].x));
   const shift = Math.max(0, right + cardGap - left);
   for (const id of addedIds) positions[id] = { ...positions[id], x: positions[id].x + shift };
  }
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
 const shared = (move: Move) => move.kind === "operation" && move.ownerId !== move.targetId && (move.purpose === "start" || move.purpose === "accept");
 const incoming = ordered.filter(move => shared(move) && move.targetId === elementId);
 // AIDEV-NOTE: Управляющая цепь родителя не задаёт место внутренних Ходов ребёнка.
 const visible = [...incoming.filter(move => move.purpose === "start"), ...ordered.filter(move => move.ownerId === elementId), ...incoming.filter(move => move.purpose === "accept")];
 return visible.map((orderedMove, index) => {
  const move = sourceById.get(orderedMove.id)!;
  return { move, order: index + 1, shared: shared(move) };
 });
}

/** Соединяет обращённые стороны строк; при вертикальном расположении обходит их снаружи. */
export function sharedMoveLinkAnchors(parent: MoveAnchor, child: MoveAnchor) {
 const parentRight = parent.x + parent.width, childRight = child.x + child.width;
 if (parentRight <= child.x || childRight <= parent.x) {
  const childOnRight = parentRight <= child.x;
  const start = { x: childOnRight ? parentRight : parent.x, y: parent.y };
  const end = { x: childOnRight ? child.x : childRight, y: child.y };
  const direction = childOnRight ? 1 : -1;
  const bend = Math.min(80, Math.abs(end.x - start.x) / 2);
  return { start, end, controlStart: { x: start.x + direction * bend, y: start.y }, controlEnd: { x: end.x - direction * bend, y: end.y }, side: "gap" };
 }
 // AIDEV-NOTE: При общем диапазоне X обращённые порты вели бы сквозь карточки.
 const left = Math.min(parent.x, child.x), right = Math.max(parentRight, childRight);
 const leftDistance = parent.x + child.x - 2 * left;
 const rightDistance = 2 * right - parentRight - childRight;
 const useLeft = leftDistance < rightDistance || (leftDistance === rightDistance && child.x + child.width / 2 < parent.x + parent.width / 2);
 const start = { x: useLeft ? parent.x : parentRight, y: parent.y };
 const end = { x: useLeft ? child.x : childRight, y: child.y };
 const gutter = useLeft ? left - 48 : right + 48;
 return { start, end, controlStart: { x: gutter, y: start.y }, controlEnd: { x: gutter, y: end.y }, side: useLeft ? "left" : "right" };
}

/** Находит передачу существующего ресурса между Ходами разных целей. */
export function resourceMoveLinks(moves: Move[], resources: Resource[], attempts: Attempt[] = []): ResourceMoveLink[] {
 const uniqueMoves = [...new Map(moves.map(move => [move.id, move])).values()];
 const resourceById = new Map(resources.map(resource => [resource.id, resource]));
 const isShared = (move: Move) => move.kind === "operation" && move.ownerId !== move.targetId && (move.purpose === "start" || move.purpose === "accept");
 const producedBy = new Map<string, Move[]>();
 const requiredResources = (move: Move) => {
  if (move.status !== "planned" || move.attemptId) return [];
  if (move.requiredResourceIds) return move.requiredResourceIds;
  if (!move.conditions || typeof move.conditions !== "object") return [];
  const required = (move.conditions as { required_resources?: unknown }).required_resources;
  return Array.isArray(required) ? required.filter((id): id is string => typeof id === "string") : [];
 };
 const targetInputs = (move: Move) => {
  if (move.purpose !== "start") return move.status === "planned" && !move.attemptId ? requiredResources(move) : move.input;
  const result = attempts.find(attempt => attempt.id === move.attemptId)?.result;
  if (!result || typeof result !== "object") return [];
  const claim = (result as { claim?: unknown }).claim;
  if (!claim || typeof claim !== "object") return [];
  const ids = (claim as { target_input_resource_ids?: unknown }).target_input_resource_ids;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
 };
 for (const producer of uniqueMoves) {
  const produced = new Set(producer.output.filter(id => resourceById.has(id)));
  if (producer.attemptId) for (const resource of resources) if (resource.attemptId === producer.attemptId) produced.add(resource.id);
  for (const resourceId of produced) producedBy.set(resourceId, [...(producedBy.get(resourceId) ?? []), producer]);
 }
 const links: ResourceMoveLink[] = [], seen = new Set<string>();
 for (const consumer of uniqueMoves) {
  const expectedIds = new Set(requiredResources(consumer));
  const inputs = new Set(targetInputs(consumer).filter(id => resourceById.has(id)));
  for (const resourceId of inputs) for (const producer of producedBy.get(resourceId) ?? []) {
   if (producer.id === consumer.id || producer.targetId === consumer.targetId) continue;
   const key = `${resourceId}:${producer.id}:${consumer.id}`;
   if (seen.has(key)) continue;
   seen.add(key);
   links.push({ id: key, resourceId, resourceTitle: resourceById.get(resourceId)!.title, producerId: producer.id, consumerId: consumer.id, fromElementId: isShared(producer) ? producer.targetId : producer.ownerId, toElementId: isShared(consumer) ? consumer.targetId : consumer.ownerId, expected: expectedIds.has(resourceId) });
  }
 }
 return links;
}

/** Показывает реальные ресурсы, предусмотренные планом между соседними дочерними элементами. */
export function siblingResourceLinks(data: BoardData): ResourceMoveLink[] {
 const elements = new Map(data.elements.map(element => [element.id, element]));
 const moves = new Map(data.moves.map(move => [move.id, move]));
 const resources = new Map(data.resources.map(resource => [resource.id, resource]));
 const attempts = new Map((data.attempts ?? []).map(attempt => [attempt.id, attempt]));
 return resourceMoveLinks(data.moves, data.resources, data.attempts).filter(link => {
  const from = elements.get(link.fromElementId), to = elements.get(link.toElementId);
  const producer = moves.get(link.producerId)!, consumer = moves.get(link.consumerId)!;
  const resource = resources.get(link.resourceId)!;
  const childKinds = new Set(["task", "goal", "quest"]);
  const required = consumer.requiredOutputContracts;
  const requiredOutput = required?.find(item => item.moveId === producer.id);
  const metadata = resource.metadata && typeof resource.metadata === "object" ? resource.metadata as Record<string, unknown> : {};
  return childKinds.has(from?.kind ?? "") && childKinds.has(to?.kind ?? "") && Boolean(from?.parentId) && from?.parentId === to?.parentId
   && producer.kind === "operation" && producer.purpose === "accept" && producer.ownerId === from?.parentId && producer.targetId === from.id
   && consumer.kind === "operation" && consumer.purpose === "start" && consumer.ownerId === to?.parentId && consumer.targetId === to.id
   && from?.output.includes(resource.id) && to?.input.includes(resource.id)
   && (!required?.length || Boolean(requiredOutput && requiredOutput.outputKey === metadata.output_key && requiredOutput.revisionId === metadata.plan_revision_id))
   && Boolean(resource.attemptId) && attempts.get(resource.attemptId!)?.moveId === producer.id;
 });
}

/** Wraps a resource name to a bounded number of readable SVG lines. */
export function wrapResourceLabel(value: string, width: number, maxLines = 3): string[] {
 const limit = Math.max(1, Math.floor(width / 7));
 const words = value.trim().split(/\s+/).filter(Boolean);
 const lines: string[] = [];
 let line = "";
 for (const word of words) {
  if (word.length > limit) {
   if (line) { lines.push(line); line = ""; }
   for (let offset = 0; offset < word.length; offset += limit) {
    if (lines.length === maxLines) break;
    lines.push(word.slice(offset, offset + limit));
   }
   if (lines.length === maxLines) break;
   continue;
  }
  const next = line ? `${line} ${word}` : word;
  if (next.length > limit) { lines.push(line); line = word; }
  else line = next;
  if (lines.length === maxLines) break;
 }
 if (lines.length < maxLines && line) lines.push(line);
 const consumed = lines.join(" ").replace(/…$/, "").length;
 if (lines.length === maxLines && consumed < words.join(" ").length) lines[maxLines - 1] = `${lines[maxLines - 1].replace(/…$/, "")}…`;
 return lines;
}

/** Прокладывает ребро между строками по кратчайшим сторонам или внешнему gutter. */
export function resourceMoveLinkAnchors(from: MoveAnchor, to: MoveAnchor) {
 const fromRight = from.x + from.width, toRight = to.x + to.width;
 if (fromRight <= to.x) return { start: { x: fromRight, y: from.y }, end: { x: to.x, y: to.y }, controlX: (fromRight + to.x) / 2, side: "gap" as const };
 if (toRight <= from.x) return { start: { x: from.x, y: from.y }, end: { x: toRight, y: to.y }, controlX: (from.x + toRight) / 2, side: "gap" as const };
 const useLeft = Math.abs(from.x - to.x) <= Math.abs(fromRight - toRight);
 const controlX = useLeft ? Math.min(from.x, to.x) - 60 : Math.max(fromRight, toRight) + 60;
 return { start: { x: useLeft ? from.x : fromRight, y: from.y }, end: { x: useLeft ? to.x : toRight, y: to.y }, controlX, side: useLeft ? "left" as const : "right" as const };
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
