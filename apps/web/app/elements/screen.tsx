"use client";
// ABOUTME: Показывает личную карту Элементов и подробности Ходов.
// ABOUTME: Данные читаются через серверный API; браузер сохраняет только раскладку.
import { useCallback, useEffect, useRef, useState, type PointerEvent } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Check, CircleDashed, Grip, Layers, ListOrdered, Maximize, Play, X } from "lucide-react";
import { cardHeight, cardWidth, clampZoom, fitView, initialPositions, readLayout, sequenceMoves, statusPresentation, type BoardData, type CardHeights, type Layout, type Move, type Point } from "./model";
import "./elements.css";

function describe(value: unknown): string {
 if (typeof value === "string") return value;
 try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function elementLabel(kind: string) {
 return ({ level: "Уровень", mission: "Миссия", quest: "Квест", goal: "Цель", task: "Задача" } as Record<string, string>)[kind] ?? kind;
}

function attemptsFor(move: Move, dataset: BoardData) {
 const attempts = move.attempts ?? [];
 return [...attempts, ...(dataset.attempts ?? []).filter(attempt => attempt.moveId === move.id && !attempts.some(item => item.id === attempt.id))];
}

/** Загружает личный граф; переданный набор оставляет компонент пригодным для проверки. */
export default function ElementsScreen({ userId, dataset }: { userId: string; dataset?: BoardData }) {
 const [loaded, setLoaded] = useState<BoardData | null>(dataset ?? null);
 const [error, setError] = useState("");
 const [retry, setRetry] = useState(0);
 useEffect(() => {
  if (dataset) { setLoaded(dataset); setError(""); return; }
  const controller = new AbortController(); setLoaded(null); setError("");
  void fetch("/api/elements", { cache: "no-store", signal: controller.signal }).then(async response => {
   if (!response.ok) throw new Error(response.status === 401 ? "Сессия завершена. Войдите снова." : "Не удалось загрузить карту Элементов.");
   return await response.json() as BoardData;
  }).then(value => { if (!controller.signal.aborted) setLoaded(value); }).catch(reason => {
   if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Не удалось загрузить карту Элементов.");
  });
  return () => controller.abort();
 }, [dataset, retry, userId]);
 if (!dataset && error) return <main className="elements-screen" aria-label="Карта Элементов"><p className="elements-empty" role="alert">{error}</p><button type="button" onClick={() => setRetry(value => value + 1)}>Повторить</button></main>;
 if (!dataset && !loaded) return <main className="elements-screen" aria-label="Карта Элементов"><p className="elements-empty" role="status">Загружаем карту Элементов…</p></main>;
 return <ElementsBoard userId={userId} dataset={dataset ?? loaded!} />;
}

function StatusLabel({ status, kind, className }: { status: string; kind: "element" | "move"; className: string }) {
 const { tone, label } = statusPresentation(status, kind), Icon = tone === "completed" ? Check : tone === "active" ? Play : CircleDashed;
 return <span className={className} data-state={tone}><Icon size={16} aria-hidden="true" /><span>{label}</span></span>;
}

/** Отображает BoardData на согласованном полотне с правой панелью подробностей. */
function ElementsBoard({ userId, dataset }: { userId: string; dataset: BoardData }) {
 const orderedMoves = sequenceMoves(dataset.moves);
 const canvas = useRef<HTMLDivElement>(null);
 const positionsDefault = initialPositions(dataset.elements);
 const storageKey = `brai.elements-layout.v1:${userId}`;
 const [layout, setLayout] = useState<Layout>({ positions: positionsDefault, view: { x: 0, y: 0, zoom: 0.5 } });
 const [heights, setHeights] = useState<CardHeights>({});
 const [ready, setReady] = useState(false);
 const [selection, setSelection] = useState<{ kind: "element" | "move"; id: string } | null>(null);
 const selectedElement = selection?.kind === "element" ? dataset.elements.find(element => element.id === selection.id) : null;
 const selectedMove = selection?.kind === "move" ? orderedMoves.find(move => move.id === selection.id) : null;
 const selected = selectedElement ?? selectedMove ?? null;
 const selectElement = (id: string) => setSelection({ kind: "element", id });
 const selectMove = (id: string) => setSelection({ kind: "move", id });
 const suppressClick = useRef(false);
 const drag = useRef<{ pointer: number; start: Point; origin: Point; elementId?: string; moved: boolean } | null>(null);
 const [dragging, setDragging] = useState(false);
 const state = useRef(layout); state.current = layout;
 const showAll = useCallback(() => {
  const bounds = canvas.current?.getBoundingClientRect();
  if (bounds) setLayout(old => ({ ...old, view: fitView(old.positions, bounds.width, bounds.height, heights) }));
 }, [heights]);
 useEffect(() => {
  const node = canvas.current;
  if (!node) return;
  let disposed = false, initialized = false;
  const measure = () => {
   if (disposed) return;
   const measured = Object.fromEntries([...node.querySelectorAll<HTMLElement>(".elements-card")].map(card => [card.dataset.elementId!, card.offsetHeight]));
   setHeights(old => Object.keys(measured).every(id => old[id] === measured[id]) && Object.keys(old).length === Object.keys(measured).length ? old : measured);
   if (initialized) return;
   initialized = true;
   const positions = initialPositions(dataset.elements, measured), bounds = node.getBoundingClientRect();
   let saved: Layout | null = null;
   try { saved = readLayout(localStorage.getItem(storageKey), positions, measured); } catch { /* Без localStorage карта работает в памяти. */ }
   setLayout(saved ?? { positions, view: fitView(positions, bounds.width, bounds.height, measured) });
   setReady(true);
  };
  const observer = new ResizeObserver(measure);
  // AIDEV-NOTE: Первую раскладку считаем после шрифта; далее наблюдаем переносы текста и рост карточек.
  void document.fonts.ready.then(() => {
   if (disposed) return;
   node.querySelectorAll(".elements-card").forEach(card => observer.observe(card));
   measure();
  });
  return () => { disposed = true; observer.disconnect(); };
 }, [storageKey, dataset]);
 useEffect(() => {
  if (!ready) return;
  const timer = setTimeout(() => {
   try { localStorage.setItem(storageKey, JSON.stringify({ version: 2, ...layout })); }
   catch { /* Раскладка остаётся в памяти, если браузер запретил хранилище. */ }
  }, 180);
  return () => clearTimeout(timer);
 }, [layout, ready, storageKey]);
 const zoomAt = useCallback((factor: number, point?: Point) => {
  const bounds = canvas.current?.getBoundingClientRect(); if (!bounds) return;
  const anchor = point ?? { x: bounds.width / 2, y: bounds.height / 2 };
  setLayout(old => {
   const zoom = clampZoom(old.view.zoom * factor), ratio = zoom / old.view.zoom;
   return { ...old, view: { x: anchor.x - (anchor.x - old.view.x) * ratio, y: anchor.y - (anchor.y - old.view.y) * ratio, zoom } };
  });
 }, []);
 useEffect(() => {
  const node = canvas.current; if (!node) return;
  const wheel = (event: WheelEvent) => {
   event.preventDefault();
   const bounds = node.getBoundingClientRect();
   zoomAt(Math.exp(-event.deltaY * 0.002), { x: event.clientX - bounds.left, y: event.clientY - bounds.top });
  };
  node.addEventListener("wheel", wheel, { passive: false });
  return () => node.removeEventListener("wheel", wheel);
 }, [zoomAt]);
 function focusElement(id: string) {
  const p = layout.positions[id], bounds = canvas.current?.getBoundingClientRect(); if (!p || !bounds) return;
  const height = cardHeight(id, heights), zoom = Math.min(1, (bounds.width - 36) / cardWidth, (bounds.height - 36) / height);
  setLayout(old => ({ ...old, view: { x: bounds.width / 2 - (p.x + cardWidth / 2) * zoom, y: bounds.height / 2 - (p.y + height / 2) * zoom, zoom: clampZoom(zoom) } }));
 }
 function startDrag(event: PointerEvent<HTMLElement>, elementId?: string) {
  if (event.button !== 0 || drag.current) return;
  if (!elementId && (event.target as HTMLElement).closest("article,button,select")) return;
  event.preventDefault(); event.stopPropagation();
  event.currentTarget.setPointerCapture(event.pointerId);
  drag.current = { pointer: event.pointerId, start: { x: event.clientX, y: event.clientY }, origin: elementId ? layout.positions[elementId] : layout.view, elementId, moved: false };
  setDragging(true);
 }
 function moveDrag(event: PointerEvent<HTMLElement>) {
  const d = drag.current; if (!d || d.pointer !== event.pointerId) return;
  if (!d.moved && Math.hypot(event.clientX - d.start.x, event.clientY - d.start.y) < 5) return;
  d.moved = true; suppressClick.current = true;
  const scale = d.elementId ? state.current.view.zoom : 1;
  const next = { x: d.origin.x + (event.clientX - d.start.x) / scale, y: d.origin.y + (event.clientY - d.start.y) / scale };
  setLayout(old => d.elementId ? { ...old, positions: { ...old.positions, [d.elementId]: next } } : { ...old, view: { ...old.view, ...next } });
 }
 function stopDrag() { drag.current = null; setDragging(false); }
 // Передача к следующей Задаче берётся из её входов. Накопленные транзитивные входы не дублируют линию.
 const chainPositions = new Map(orderedMoves.map((move, index) => [move.id, index]));
 const transfers = dataset.elements.flatMap(target => {
  const sources = dataset.elements.filter(source => source.id !== target.id && source.output.some(id => target.input.includes(id)));
  const latest = sources.sort((a, b) => Math.max(...orderedMoves.filter(m => m.targetId === b.id).map(m => chainPositions.get(m.id)!)) - Math.max(...orderedMoves.filter(m => m.targetId === a.id).map(m => chainPositions.get(m.id)!)))[0];
  return latest ? [{ from: latest.id, to: target.id, label: latest.output.filter(id => target.input.includes(id)).join(", "), returnToParent: false }] : [];
 });
 // Приёмка принадлежит родителю. Выход дочернего Элемента создаёт именно этот Ход.
 for (const source of dataset.elements) {
  if (!source.parentId) continue;
  const acceptance = orderedMoves.find(m => m.ownerId === source.parentId && m.targetId === source.id && m.output.some(id => source.output.includes(id)));
  if (acceptance) transfers.push({ from: source.id, to: source.parentId, label: `${source.output.join(", ")} · ${acceptance.id}`, returnToParent: true });
 }
 const links = [
  ...dataset.elements.filter(e => e.parentId && layout.positions[e.parentId]).map(e => ({ from: e.parentId!, to: e.id, label: "Вложенность", type: "hierarchy", returnToParent: false })),
  ...transfers.map(t => ({ ...t, type: "result" })),
 ];
 const selectedMoveAttempts = selectedMove ? attemptsFor(selectedMove, dataset) : [];
 const selectedElementAttempts = selectedElement ? [...(selectedElement.attempts ?? []), ...orderedMoves.filter(move => move.ownerId === selectedElement.id).flatMap(move => attemptsFor(move, dataset))] : [];
 return <main className="elements-screen" aria-label="Карта Элементов">
  <button type="button" className="elements-fit" aria-label="Вся карта" title="Вся карта" onClick={showAll}><Maximize size={18} /></button>
  <div ref={canvas} className={"elements-canvas" + (dragging ? " is-dragging" : "")} tabIndex={0} role="region" aria-label="Полотно Элементов"
   onPointerDownCapture={() => { suppressClick.current = false; }}
   onClickCapture={event => { if (suppressClick.current && event.detail !== 0) { event.preventDefault(); event.stopPropagation(); } suppressClick.current = false; }}
   onPointerDown={event => startDrag(event)} onPointerMove={moveDrag} onPointerUp={stopDrag} onPointerCancel={stopDrag} onLostPointerCapture={stopDrag}
   onKeyDown={event => { if (event.target !== event.currentTarget) return; const shifts: Record<string, Point> = { ArrowLeft: { x: 60, y: 0 }, ArrowRight: { x: -60, y: 0 }, ArrowUp: { x: 0, y: 60 }, ArrowDown: { x: 0, y: -60 } }; const delta = shifts[event.key]; if (delta) { event.preventDefault(); setLayout(old => ({ ...old, view: { ...old.view, x: old.view.x + delta.x, y: old.view.y + delta.y } })); } if (event.key === "+" || event.key === "=") zoomAt(1.2); if (event.key === "-") zoomAt(1 / 1.2); }}>
   {!dataset.elements.length && <p className="elements-empty">На карте пока нет Элементов.</p>}
   <div className="elements-world" style={{ transform: `translate(${layout.view.x}px, ${layout.view.y}px) scale(${layout.view.zoom})`, visibility: ready ? "visible" : "hidden" }}>
    <svg className="elements-links" aria-label="Связи Элементов"><defs>{["hierarchy", "result"].map(type => <marker key={type} id={`elements-arrow-${type}`} markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto"><path d="M1,1 L8,5 L1,9" fill="none" stroke={type === "result" ? "#8ea2ff" : "#8c9c96"} strokeWidth="1.5" /></marker>)}</defs>
     {links.map((link, index) => {
      const a = layout.positions[link.from], b = layout.positions[link.to]; if (!a || !b) return null;
      const hierarchyLink = link.type === "hierarchy";
      const side = !hierarchyLink && !link.returnToParent;
      const start = side ? { x: a.x + cardWidth, y: a.y + cardHeight(link.from, heights) / 2 } : { x: a.x + cardWidth / 2 + (link.returnToParent ? 135 : -50), y: a.y + (link.returnToParent ? 0 : cardHeight(link.from, heights)) };
      const end = side ? { x: b.x, y: b.y + cardHeight(link.to, heights) / 2 } : { x: b.x + cardWidth / 2 + (link.returnToParent ? 100 : -50), y: b.y + (link.returnToParent ? cardHeight(link.to, heights) : 0) };
      const middle = (start.y + end.y) / 2 + (link.returnToParent ? 35 : -25);
      const path = side ? `M${start.x},${start.y} C${start.x + 70},${start.y} ${end.x - 70},${end.y} ${end.x},${end.y}` : `M${start.x},${start.y} C${start.x},${middle} ${end.x},${middle} ${end.x},${end.y}`;
      return <g key={`${link.type}-${link.from}-${link.to}`} className={`elements-link ${link.type}`}><title>{`${link.from} → ${link.to}: ${link.label}`}</title><path d={path} markerEnd={`url(#elements-arrow-${link.type})`} /><text x={(start.x + end.x) / 2} y={side ? start.y - 12 : middle + (index % 2) * 20} textAnchor="middle">{link.label}</text></g>;
     })}
    </svg>
    {dataset.elements.map(element => {
     const point = layout.positions[element.id] ?? { x: 0, y: 0 }, moves = orderedMoves.filter(m => m.ownerId === element.id);
     return <article key={element.id} className="elements-card" data-state={statusPresentation(element.status, "element").tone} data-element-id={element.id} style={{ left: point.x, top: point.y, width: cardWidth }} aria-label={`${element.id}: ${element.title}`} onClick={event => { if (!(event.target as HTMLElement).closest("button,a,details")) selectElement(element.id); }}>
      <button type="button" className="elements-card-grip" aria-label={`Переместить ${element.id}. Стрелки перемещают карточку`} onPointerDown={event => startDrag(event, element.id)} onPointerMove={moveDrag} onPointerUp={stopDrag} onPointerCancel={stopDrag} onLostPointerCapture={stopDrag}
       onDoubleClick={() => focusElement(element.id)} onKeyDown={event => { const deltas: Record<string, Point> = { ArrowLeft: { x: -20, y: 0 }, ArrowRight: { x: 20, y: 0 }, ArrowUp: { x: 0, y: -20 }, ArrowDown: { x: 0, y: 20 } }; const delta = deltas[event.key]; if (delta) { event.preventDefault(); setLayout(old => ({ ...old, positions: { ...old.positions, [element.id]: { x: point.x + delta.x, y: point.y + delta.y } } })); } }}><span>{elementLabel(element.kind)} · {element.id}</span><StatusLabel status={element.status} kind="element" className="elements-card-status" /><Grip size={16} /></button>
      <h2><button type="button" className="elements-card-title" aria-label={`Открыть Элемент ${element.id}`} onClick={event => { event.stopPropagation(); selectElement(element.id); }}>{element.title}</button></h2><p className="elements-description">{element.description}</p>
      <div className="elements-moves-title"><span>Ходы</span><span>{moves.filter(move => statusPresentation(move.status, "move").tone === "completed").length} / {moves.length}</span></div>
      <div className="elements-moves" aria-label={`Ходы ${element.id}`}>
       {moves.map(move => <button type="button" key={move.id} className="elements-move" data-state={statusPresentation(move.status, "move").tone} data-move-id={move.id} onClick={event => { event.stopPropagation(); selectMove(move.id); }}><span className="elements-move-number">{move.order}</span><span className="elements-move-body"><span>{move.title}</span><small>{move.kind === "operation" ? "Операция" : "Экшен"} · {move.id}</small></span><StatusLabel status={move.status} kind="move" className="elements-move-status" /></button>)}
       {!moves.length && <p>Ходов пока нет.</p>}
      </div><footer>Результат: {element.output.map(id => dataset.resources.find(r => r.id === id)?.title ?? id).join(", ") || "Не указан"}</footer>
     </article>;
    })}
   </div>
  </div>
  <Dialog.Root open={selected !== null} onOpenChange={open => { if (!open) setSelection(null); }}><Dialog.Portal><Dialog.Overlay className="elements-detail-overlay" /><Dialog.Content className="elements-detail" data-kind={selection?.kind} data-detail-id={selected?.id} data-state={selected && selection ? statusPresentation(selected.status, selection.kind).tone : undefined} aria-describedby="elements-detail-description">
   <Dialog.Close className="elements-detail-close" aria-label="Закрыть подробности"><X size={20} /></Dialog.Close>
   <header className="elements-detail-heading">
    <div className="elements-detail-kind">{selectedElement ? <Layers size={22} aria-hidden="true" /> : <ListOrdered size={22} aria-hidden="true" />}<span>{selectedElement ? `Элемент · ${elementLabel(selectedElement.kind)}` : `Ход · ${selectedMove?.kind === "operation" ? "Операция" : "Экшен"} · №${selectedMove?.order}`}</span></div>
    <Dialog.Title>{selected?.title}</Dialog.Title><Dialog.Description id="elements-detail-description">{selected?.id}</Dialog.Description>
    {selected && selection && <StatusLabel status={selected.status} kind={selection.kind} className="elements-detail-summary-status" />}
   </header>
   {selectedElement && <>
    <p className="elements-detail-description">{selectedElement.description}</p>
    <dl><dt>Уровень</dt><dd>{elementLabel(selectedElement.kind)}</dd><dt>Статус Элемента</dt><dd><StatusLabel status={selectedElement.status} kind="element" className="elements-detail-status" /></dd><dt>Родитель</dt><dd>{selectedElement.parentId ? <button type="button" className="elements-text-link" onClick={() => selectElement(selectedElement.parentId!)}>{selectedElement.parentId} · {dataset.elements.find(element => element.id === selectedElement.parentId)?.title}</button> : "Нет — корневой Элемент"}</dd><dt>Версия</dt><dd>{selectedElement.revision}</dd></dl>
    {selectedElement.instructions && <section className="elements-resources"><h3>Инструкция</h3><p>{selectedElement.instructions}</p></section>}
    {selectedElement.conditions !== undefined && <section className="elements-resources"><h3>Условия</h3><pre>{describe(selectedElement.conditions)}</pre></section>}
    {selectedElement.fields !== undefined && <section className="elements-resources"><h3>Поля</h3><pre>{describe(selectedElement.fields)}</pre></section>}
    {selectedElement.provenance && <section className="elements-resources"><h3>Происхождение</h3><pre>{describe(selectedElement.provenance)}</pre></section>}
    {!!selectedElementAttempts.length && <section className="elements-resources"><h3>Попытки <span>{selectedElementAttempts.length}</span></h3>{selectedElementAttempts.map(attempt => <details key={attempt.id}><summary>{attempt.id} · {attempt.status}</summary><pre>{describe(attempt)}</pre></details>)}</section>}
    <section className="elements-panel-moves"><h3>Собственные Ходы <span>{orderedMoves.filter(move => move.ownerId === selectedElement.id).length}</span></h3>
     {orderedMoves.filter(move => move.ownerId === selectedElement.id).map(move => <button type="button" key={move.id} className="elements-move" data-state={statusPresentation(move.status, "move").tone} data-panel-move-id={move.id} onClick={() => selectMove(move.id)}><span className="elements-move-number">{move.order}</span><span className="elements-move-body"><span>{move.title}</span><small>{move.id}</small></span><StatusLabel status={move.status} kind="move" className="elements-move-status" /></button>)}
    </section>
   </>}
   {selectedMove && <>
    <dl><dt>Статус Хода</dt><dd><StatusLabel status={selectedMove.status} kind="move" className="elements-detail-status" /></dd><dt>Номер Хода в Элементе</dt><dd>{selectedMove.order}</dd><dt>Тип</dt><dd>{selectedMove.kind === "operation" ? "Операция" : "Экшен"}</dd><dt>Исполнитель</dt><dd>{selectedMove.executor === "agent" ? "Агент" : selectedMove.executor === "human" || selectedMove.executor === "player" ? "Игрок" : selectedMove.executor || "Не указан"}</dd><dt>Владелец Хода</dt><dd>{selectedMove.ownerId} · {dataset.elements.find(element => element.id === selectedMove.ownerId)?.title}</dd><dt>Целевой Элемент</dt><dd>{selectedMove.targetId} · {dataset.elements.find(element => element.id === selectedMove.targetId)?.title}</dd><dt>Предшественник</dt><dd>{selectedMove.previousId ? <button type="button" className="elements-text-link" onClick={() => selectMove(selectedMove.previousId!)}>{selectedMove.previousId} · {orderedMoves.find(move => move.id === selectedMove.previousId)?.title}</button> : "Нет — начало цепочки"}</dd><dt>Попытка</dt><dd>{selectedMove.attemptId || "Не указана"}{statusPresentation(selectedMove.status, "move").tone === "completed" ? " · Успешна" : ""}</dd></dl>
    {selectedMove.instructions && <section className="elements-resources"><h3>Инструкция</h3><p>{selectedMove.instructions}</p></section>}
    {selectedMove.conditions !== undefined && <section className="elements-resources"><h3>Условия</h3><pre>{describe(selectedMove.conditions)}</pre></section>}
    {selectedMove.fields !== undefined && <section className="elements-resources"><h3>Поля результата</h3><pre>{describe(selectedMove.fields)}</pre></section>}
    {selectedMove.provenance && <section className="elements-resources"><h3>Происхождение</h3><pre>{describe(selectedMove.provenance)}</pre></section>}
    {!!selectedMoveAttempts.length && <section className="elements-resources"><h3>Попытки <span>{selectedMoveAttempts.length}</span></h3>{selectedMoveAttempts.map(attempt => <details key={attempt.id}><summary>{attempt.id} · {attempt.status}</summary><pre>{describe(attempt)}</pre></details>)}</section>}
   </>}
   {selected && <>
    {(["output", "input"] as const).filter(role => selected[role].length).map(role => <section key={role} className="elements-resources"><h3>{role === "input" ? "Входные ресурсы" : "Выходные ресурсы"} <span>{selected[role].length}</span></h3>{selected[role].map(id => { const resource = dataset.resources.find(resource => resource.id === id); if (!resource) return <details key={id}><summary>{id}</summary><p>Ресурс не включён в карту.</p></details>; const creator = orderedMoves.find(move => move.attemptId === resource.attemptId); return <details key={id}><summary><span>{id}</span> {resource.title}</summary><p>{resource.content}</p>{resource.attemptId && <p className="elements-resource-origin">Попытка: {creator ? <button type="button" className="elements-text-link" onClick={() => selectMove(creator.id)}>{creator.id} · {resource.attemptId}</button> : resource.attemptId}</p>}</details>; })}</section>)}
   </>}
  </Dialog.Content></Dialog.Portal></Dialog.Root>
 </main>;
}
