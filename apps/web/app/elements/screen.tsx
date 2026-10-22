"use client";
// ABOUTME: Показывает карту Элементов и понятные подробности выбранной записи.
// ABOUTME: Данные меняются через серверный API; браузер хранит только раскладку.
import { useCallback, useEffect, useRef, useState, type PointerEvent } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Bot, Check, CircleDashed, Grip, Layers, Maximize, Play, UserRound, X, Ban } from "lucide-react";
import { cardHeight, cardWidth, clampZoom, fitView, initialPositions, projectMoves, readLayout, sequenceMoves, sharedMoveLinkAnchors, siblingResourceLinks, statusPresentation, type BoardData, type CardHeights, type Layout, type MoveAnchor, type Point } from "./model";
import "./elements.css";
import {NewTask,WorkflowAction} from "./workflow";

import { readable, resourceText, conditionText, presentBoard } from "./presentation";

function elementLabel(kind: string) {
 return ({ level: "Уровень", mission: "Миссия", quest: "Квест", goal: "Цель", task: "Задача" } as Record<string, string>)[kind] ?? "Элемент";
}
function MoveActor({ kind }: { kind: string }) {
 return <span className="elements-move-actor" data-role={kind === "operation" ? "agent" : "human"} role="img" aria-label={kind === "operation" ? "Агент" : "Игрок"} title={kind === "operation" ? "Агент" : "Игрок"}>{kind === "operation" ? <Bot size={24} aria-hidden="true" /> : <UserRound size={24} aria-hidden="true" />}</span>;
}
function projectionKey(elementId: string, moveId: string) { return `${elementId}:${moveId}`; }
function statusOptions(kind: "element" | "move") {
 return kind === "element"
  ? [{ value: "draft", label: "Черновик" }, { value: "active", label: "В работе" }, { value: "completed", label: "Выполнена" }, { value: "cancelled", label: "Отменена" }]
  : [{ value: "planned", label: "Запланирован" }, { value: "claimed", label: "В работе" }, { value: "succeeded", label: "Выполнен" }, { value: "cancelled", label: "Отменён" }];
}

/** Загружает личную карту; переданный набор оставляет компонент пригодным для проверки. */
export default function ElementsScreen({ userId, dataset }: { userId: string; dataset?: BoardData }) {
 const [loaded, setLoaded] = useState<BoardData | null>(dataset ?? null);
 const [error, setError] = useState("");
 const [retry, setRetry] = useState(0);
 useEffect(() => {
  if (dataset) { setLoaded(dataset); setError(""); return; }
  const controller = new AbortController(); setLoaded(null); setError("");
  void fetch("/api/elements", { cache: "no-store", signal: controller.signal }).then(async response => {
   if (!response.ok) throw new Error(response.status === 401 ? "Сессия завершена. Войдите снова." : "Не удалось загрузить карту.");
   return await response.json() as BoardData;
  }).then(value => { if (!controller.signal.aborted) setLoaded(value); }).catch(reason => {
   if (!controller.signal.aborted) setError(reason instanceof Error && reason.message === "Сессия завершена. Войдите снова." ? reason.message : "Не удалось загрузить карту.");
  });
  return () => controller.abort();
 }, [dataset, retry, userId]);
 if (!dataset && error) return <main className="elements-screen" aria-label="Карта Элементов"><p className="elements-empty" role="alert">{error}</p><button type="button" onClick={() => setRetry(value => value + 1)}>Повторить</button></main>;
 if (!loaded) return <main className="elements-screen" aria-label="Карта Элементов"><p className="elements-empty" role="status">Загружаем карту…</p></main>;
 return <ElementsBoard userId={userId} dataset={presentBoard(loaded)} onDataChange={setLoaded} />;
}

function StatusLabel({ status, kind, className }: { status: string; kind: "element" | "move"; className: string }) {
 const { tone, label } = statusPresentation(status, kind);
 const Icon = tone === "completed" ? Check : tone === "active" ? Play : tone === "cancelled" ? Ban : CircleDashed;
 return <span className={className} data-state={tone}><Icon size={16} aria-hidden="true" /><span>{label}</span></span>;
}

function ResourceDetails({ ids, label, dataset, moves, onSelectMove }: { ids: string[]; label: string; dataset: BoardData; moves: ReturnType<typeof sequenceMoves>; onSelectMove: (id: string) => void }) {
 if (!ids.length) return null;
 return <section className="elements-resources"><h3>{label}</h3>
  {ids.map(id => {
   const resource = dataset.resources.find(item => item.id === id);
   if (!resource) return <p className="elements-resource-missing" key={id}>Связанный ресурс недоступен.</p>;
   const creator = moves.find(move => move.attemptId === resource.attemptId);
   return <details key={resource.id}>
    <summary>{readable(resource.title) || "Ресурс"}</summary>
    {resourceText(resource.content) && <p>{resourceText(resource.content)}</p>}
    {creator && <p className="elements-resource-origin">Создан в ходе: <button type="button" className="elements-text-link" onClick={() => onSelectMove(creator.id)}>{readable(creator.title) || "Открыть ход"}</button></p>}
    {resource.artifacts?.map(file => file.available
      ? <a className="elements-file-link" key={file.id} href={`/api/elements/artifacts/${encodeURIComponent(file.id)}`} target="_blank" rel="noreferrer">Открыть {readable(file.name) || "файл"}</a>
      : <span className="elements-file-unavailable" key={file.id}>{readable(file.name) || "Файл"} · недоступен</span>)}
   </details>;
  })}
 </section>;
}

/** Отображает карту с панелью подробностей и ручным выбором статуса в DEV. */
function ElementsBoard({ userId, dataset, onDataChange }: { userId: string; dataset: BoardData; onDataChange: (data: BoardData) => void }) {
 const orderedMoves = sequenceMoves(dataset.moves);
 const canvas = useRef<HTMLDivElement>(null);
 const positionsDefault = initialPositions(dataset.elements);
 const storageKey = `brai.elements-layout.v1:${userId}`;
 const [layout, setLayout] = useState<Layout>({ positions: positionsDefault, view: { x: 0, y: 0, zoom: 0.5 } });
 const [heights, setHeights] = useState<CardHeights>({});
 const [ready, setReady] = useState(false);
 const [selection, setSelection] = useState<{ kind: "element" | "move"; id: string; elementId?: string } | null>(null);
 const [highlightedMoveId, setHighlightedMoveId] = useState<string | null>(null);
 const [moveAnchors, setMoveAnchors] = useState<Record<string, MoveAnchor>>({});
 const [savingStatus, setSavingStatus] = useState(false);
 const [statusError, setStatusError] = useState("");
 const selectedElement = selection?.kind === "element" ? dataset.elements.find(element => element.id === selection.id) : null;
 const selectedMove = selection?.kind === "move" ? orderedMoves.find(move => move.id === selection.id) : null;
 const selected = selectedElement ?? selectedMove ?? null;
 const projections = new Map(dataset.elements.map(element => [element.id, projectMoves(dataset.moves, element.id)]));
 const selectedMoveOrder = selectedMove ? (projections.get(selection?.elementId ?? selectedMove.ownerId) ?? []).find(row => row.move.id === selectedMove.id)?.order ?? selectedMove.order : null;
 const selectElement = (id: string) => setSelection({ kind: "element", id });
 const selectMove = (id: string, elementId?: string) => setSelection({ kind: "move", id, elementId });
 const suppressClick = useRef(false);
 const drag = useRef<{ pointer: number; start: Point; origin: Point; elementId?: string; moved: boolean } | null>(null);
 const [dragging, setDragging] = useState(false);
 const state = useRef(layout); state.current = layout;
 const measureMoveAnchors = useRef<() => void>(() => {});
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
  // AIDEV-NOTE: Первую раскладку считаем после шрифта; далее наблюдаем рост карточек.
  void document.fonts.ready.then(() => {
   if (disposed) return;
   node.querySelectorAll(".elements-card").forEach(card => observer.observe(card));
   measure();
  });
  return () => { disposed = true; observer.disconnect(); };
 }, [storageKey, dataset]);
 useEffect(() => {
  const node = canvas.current;
  if (!node || !ready) return;
  let frame = 0;
  const measure = () => {
   cancelAnimationFrame(frame);
   frame = requestAnimationFrame(() => {
    const currentView = state.current.view, bounds = node.getBoundingClientRect(), zoom = currentView.zoom;
    const measured = Object.fromEntries([...node.querySelectorAll<HTMLElement>(".elements-move[data-projection-key]")].map(row => {
     const rect = row.getBoundingClientRect();
     return [row.dataset.projectionKey!, { x: (rect.left - bounds.left - currentView.x) / zoom, y: (rect.top + rect.height / 2 - bounds.top - currentView.y) / zoom, width: rect.width / zoom }];
    }));
    setMoveAnchors(previous => Object.keys(measured).length === Object.keys(previous).length && Object.keys(measured).every(key => {
     const a = measured[key], b = previous[key]; return b && Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.width - b.width) < 0.5;
    }) ? previous : measured);
   });
  };
  measureMoveAnchors.current = measure;
  const observer = new ResizeObserver(measure);
  node.querySelectorAll<HTMLElement>(".elements-move[data-projection-key]").forEach(row => observer.observe(row));
  measure();
  return () => { observer.disconnect(); cancelAnimationFrame(frame); measureMoveAnchors.current = () => {}; };
 }, [dataset.moves, ready]);
 useEffect(() => { measureMoveAnchors.current(); }, [layout, heights]);
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
  const wheel = (event: WheelEvent) => { event.preventDefault(); const bounds = node.getBoundingClientRect(); zoomAt(Math.exp(-event.deltaY * 0.002), { x: event.clientX - bounds.left, y: event.clientY - bounds.top }); };
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
  if (!elementId && (event.target as HTMLElement).closest("article,button,select,a,details")) return;
  event.preventDefault(); event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId);
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
 const resourceName = (id: string) => readable(dataset.resources.find(resource => resource.id === id)?.title) || "Ресурс";
 const transfers = siblingResourceLinks(dataset);
 const sharedMoves = orderedMoves.filter(move => move.kind === "operation" && move.ownerId !== move.targetId && (move.purpose === "start" || move.purpose === "accept"));
 async function changeStatus(kind: "element" | "move", id: string, status: string) {
  setSavingStatus(true); setStatusError("");
  try {
   const response = await fetch("/api/elements/status", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind, id, status, request_id: crypto.randomUUID() }) });
   if (!response.ok) throw new Error("Не удалось сохранить статус. Повторите попытку.");
   onDataChange(await response.json() as BoardData);
  } catch { setStatusError("Не удалось сохранить статус. Повторите попытку."); }
  finally { setSavingStatus(false); }
 }
 return <main className="elements-screen" aria-label="Карта Элементов">
  <NewTask dataset={dataset} onDataChange={onDataChange} />
  <button type="button" className="elements-fit" aria-label="Вся карта" title="Вся карта" onClick={showAll}><Maximize size={18} /></button>
  <div ref={canvas} className={"elements-canvas" + (dragging ? " is-dragging" : "")} tabIndex={0} role="region" aria-label="Полотно Элементов"
   onPointerDownCapture={() => { suppressClick.current = false; }} onClickCapture={event => { if (suppressClick.current && event.detail !== 0) { event.preventDefault(); event.stopPropagation(); } suppressClick.current = false; }}
   onPointerDown={event => startDrag(event)} onPointerMove={moveDrag} onPointerUp={stopDrag} onPointerCancel={stopDrag} onLostPointerCapture={stopDrag}
   onKeyDown={event => { if (event.target !== event.currentTarget) return; const shifts: Record<string, Point> = { ArrowLeft: { x: 60, y: 0 }, ArrowRight: { x: -60, y: 0 }, ArrowUp: { x: 0, y: 60 }, ArrowDown: { x: 0, y: -60 } }; const delta = shifts[event.key]; if (delta) { event.preventDefault(); setLayout(old => ({ ...old, view: { ...old.view, x: old.view.x + delta.x, y: old.view.y + delta.y } })); } if (event.key === "+" || event.key === "=") zoomAt(1.2); if (event.key === "-") zoomAt(1 / 1.2); }}>
   {!dataset.elements.length && <p className="elements-empty">На карте пока нет Элементов.</p>}
   <div className="elements-world" style={{ transform: `translate(${layout.view.x}px, ${layout.view.y}px) scale(${layout.view.zoom})`, visibility: ready ? "visible" : "hidden" }}>
    <svg className="elements-links" aria-label="Общие Ходы и передача результатов между связанными элементами">
     <defs><marker id="elements-resource-arrow" viewBox="0 0 8 8" refX="8" refY="4" markerWidth="8" markerHeight="8" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="#f1c56e" /></marker></defs>
     {sharedMoves.map(move => {
      const parent = moveAnchors[projectionKey(move.ownerId, move.id)], child = moveAnchors[projectionKey(move.targetId, move.id)];
      if (!parent || !child) return null;
      const { start, end, controlStart, controlEnd } = sharedMoveLinkAnchors(parent, child);
      const path = `M${start.x},${start.y} C${controlStart.x},${controlStart.y} ${controlEnd.x},${controlEnd.y} ${end.x},${end.y}`;
      const label = `Одна общая операция «${readable(move.title) || "Операция"}»`;
      return <g key={move.id} className="elements-link identity" data-move-id={move.id} data-parent-element-id={move.ownerId} data-child-element-id={move.targetId} role="img" aria-label={label}><title>{label}</title><path className={highlightedMoveId === move.id ? "is-highlighted" : ""} d={path} /><circle cx={start.x} cy={start.y} r={3} /><circle cx={end.x} cy={end.y} r={3} /></g>;
     })}
     {transfers.map(link => {
      const from = moveAnchors[projectionKey(link.fromElementId, link.producerId)], to = moveAnchors[projectionKey(link.toElementId, link.consumerId)];
      if (!from || !to) return null;
      const { start, end, controlStart, controlEnd } = sharedMoveLinkAnchors(from, to);
      const path = `M${start.x},${start.y} C${controlStart.x},${controlStart.y} ${controlEnd.x},${controlEnd.y} ${end.x},${end.y}`;
      const title = readable(link.resourceTitle) || "Ресурс";
      return <g key={link.id} className="elements-link resource" data-resource-id={link.resourceId} data-producer-id={link.producerId} data-consumer-id={link.consumerId} data-from-element-id={link.fromElementId} data-to-element-id={link.toElementId} role="img" aria-label={`Передача ресурса: ${title}`}><title>{title}</title><path d={path} markerEnd="url(#elements-resource-arrow)" /></g>;
     })}
    </svg>
    {dataset.elements.map(element => {
     const point = layout.positions[element.id] ?? { x: 0, y: 0 }, moves = projections.get(element.id) ?? [];
     const completeCount = moves.filter(({ move }) => statusPresentation(move.status, "move").tone === "completed").length;
     return <article key={element.id} className="elements-card" data-state={statusPresentation(element.status, "element").tone} data-element-id={element.id} style={{ left: point.x, top: point.y, width: cardWidth }} aria-label={`${elementLabel(element.kind)}: ${readable(element.title)}`} onClick={event => { if (!(event.target as HTMLElement).closest("button,a,details,select")) selectElement(element.id); }}>
      <button type="button" className="elements-card-grip" aria-label={`Переместить карточку «${readable(element.title)}»`} onPointerDown={event => startDrag(event, element.id)} onPointerMove={moveDrag} onPointerUp={stopDrag} onPointerCancel={stopDrag} onLostPointerCapture={stopDrag}
       onDoubleClick={() => focusElement(element.id)} onKeyDown={event => { const deltas: Record<string, Point> = { ArrowLeft: { x: -20, y: 0 }, ArrowRight: { x: 20, y: 0 }, ArrowUp: { x: 0, y: -20 }, ArrowDown: { x: 0, y: 20 } }; const delta = deltas[event.key]; if (delta) { event.preventDefault(); setLayout(old => ({ ...old, positions: { ...old.positions, [element.id]: { x: point.x + delta.x, y: point.y + delta.y } } })); } }}>
       <span>{elementLabel(element.kind)}</span><StatusLabel status={element.status} kind="element" className="elements-card-status" /><Grip size={16} aria-hidden="true" />
      </button>
      <h2><button type="button" className="elements-card-title" aria-label={`Открыть ${elementLabel(element.kind)} «${readable(element.title)}»`} onClick={event => { event.stopPropagation(); selectElement(element.id); }}>{readable(element.title) || "Без названия"}</button></h2>
      {readable(element.description) && <p className="elements-description">{readable(element.description)}</p>}
      <div className="elements-moves-title"><span>Ходы</span><span>{completeCount} из {moves.length} завершено</span></div>
      {element.parentId && <button type="button" className="elements-related-link" onClick={() => focusElement(element.parentId!)}>Родитель: {readable(dataset.elements.find(item => item.id === element.parentId)?.title) || "Открыть родителя"}</button>}
      <div className="elements-moves" aria-label={`Ходы элемента «${readable(element.title)}»`}>
       {moves.map(({ move, order, shared }) => <div key={move.id} className="elements-move-entry" data-linked={highlightedMoveId === move.id || undefined} onPointerEnter={() => shared && setHighlightedMoveId(move.id)} onPointerLeave={() => setHighlightedMoveId(current => current === move.id ? null : current)} onFocusCapture={() => shared && setHighlightedMoveId(move.id)} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setHighlightedMoveId(current => current === move.id ? null : current); }}>
        <button type="button" className="elements-move" data-kind={move.kind} data-state={statusPresentation(move.status, "move").tone} data-move-id={move.id} data-projection-key={projectionKey(element.id, move.id)} onClick={event => { event.stopPropagation(); selectMove(move.id, element.id); }}>
         <span className="elements-move-number">{order}</span><MoveActor kind={move.kind} /><span className="elements-move-body"><span>{readable(move.title) || "Без названия"}</span></span><StatusLabel status={move.status} kind="move" className="elements-move-status" />
        </button>
       </div>)}
       {!moves.length && <p className="elements-no-moves">Ходов пока нет.</p>}
      </div>
      {element.output.length > 0 && <footer>Результат: {element.output.map(resourceName).join(", ")}</footer>}
     </article>;
    })}
   </div>
  </div>
  <Dialog.Root open={selected !== null} onOpenChange={open => { if (!open) setSelection(null); }}><Dialog.Portal><Dialog.Overlay className="elements-detail-overlay" /><Dialog.Content className="elements-detail" data-kind={selection?.kind} data-detail-id={selected?.id} data-state={selected && selection ? statusPresentation(selected.status, selection.kind).tone : undefined} aria-describedby="elements-detail-description">
   <Dialog.Close className="elements-detail-close" aria-label="Закрыть подробности"><X size={20} /></Dialog.Close>
   <header className="elements-detail-heading">
    <div className="elements-detail-kind">{selectedElement ? <Layers size={22} aria-hidden="true" /> : <MoveActor kind={selectedMove?.kind ?? "operation"} />}<span>{selectedElement ? `${elementLabel(selectedElement.kind)}` : `Ход ${selectedMoveOrder}`}</span></div>
    <Dialog.Title>{readable(selected?.title) || "Без названия"}</Dialog.Title><Dialog.Description id="elements-detail-description">{selectedElement ? "Подробности элемента" : "Подробности хода"}</Dialog.Description>
    {selected && selection && <StatusLabel status={selected.status} kind={selection.kind} className="elements-detail-summary-status" />}
    {selected && dataset.manualStatusEnabled && selection && <label className="elements-status-control">Изменить статус
     <select value={selected.status} disabled={savingStatus} onChange={event => void changeStatus(selection.kind, selected.id, event.target.value)}>
      {statusOptions(selection.kind).map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
     </select>
    </label>}
    {selected && dataset.manualStatusEnabled && <p className="elements-dev-note">Ручная проверка в DEV. Результаты работы не создаются.</p>}
    {statusError && <p className="elements-status-error" role="alert">{statusError}</p>}
   </header>
   {selectedElement && <>
    {readable(selectedElement.description) && <p className="elements-detail-description">{readable(selectedElement.description)}</p>}
    {selectedElement.parentId && <p className="elements-parent">Входит в: <button type="button" className="elements-text-link" onClick={() => selectElement(selectedElement.parentId!)}>{readable(dataset.elements.find(item => item.id === selectedElement.parentId)?.title) || "Родительский элемент"}</button></p>}
    {selectedElement.instructions && <details className="elements-secondary"><summary>Дополнительная инструкция</summary><p>{readable(selectedElement.instructions)}</p></details>}
    <ResourceDetails ids={selectedElement.input} label="Входящие ресурсы" dataset={dataset} moves={orderedMoves} onSelectMove={selectMove} />
    <ResourceDetails ids={selectedElement.output} label="Итоговые ресурсы" dataset={dataset} moves={orderedMoves} onSelectMove={selectMove} />
    <section className="elements-panel-moves"><h3>Ходы <span>{(projections.get(selectedElement.id) ?? []).length}</span></h3>
     {(projections.get(selectedElement.id) ?? []).map(({ move, order, shared }) => <div key={move.id} className="elements-move-entry" data-linked={highlightedMoveId === move.id || undefined} onPointerEnter={() => shared && setHighlightedMoveId(move.id)} onPointerLeave={() => setHighlightedMoveId(current => current === move.id ? null : current)} onFocusCapture={() => shared && setHighlightedMoveId(move.id)} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setHighlightedMoveId(current => current === move.id ? null : current); }}><button type="button" className="elements-move" data-kind={move.kind} data-state={statusPresentation(move.status, "move").tone} data-panel-move-id={move.id} onClick={() => selectMove(move.id, selectedElement.id)}><span className="elements-move-number">{order}</span><MoveActor kind={move.kind} /><span className="elements-move-body"><span>{readable(move.title) || "Без названия"}</span></span><StatusLabel status={move.status} kind="move" className="elements-move-status" /></button></div>)}
    </section>
   </>}
   {selectedMove && <>
    <ResourceDetails ids={selectedMove.input.length?selectedMove.input:selectedMove.requiredResourceIds??[]} label={selectedMove.input.length?"Полученные ресурсы":"Доступные входы"} dataset={dataset} moves={orderedMoves} onSelectMove={selectMove} />
    <WorkflowAction key={selectedMove.id} move={selectedMove} dataset={dataset} onDataChange={onDataChange} />
    {selectedMove.instructions && <section className="elements-resources"><h3>Инструкция</h3><p>{readable(selectedMove.instructions)}</p></section>}
    <ResourceDetails ids={selectedMove.output} label="Результат" dataset={dataset} moves={orderedMoves} onSelectMove={selectMove} />
    {selectedMove.previousId && <p className="elements-parent">Предыдущий ход: <button type="button" className="elements-text-link" onClick={() => selectMove(selectedMove.previousId!, selection?.elementId)}>{readable(orderedMoves.find(move => move.id === selectedMove.previousId)?.title) || "Открыть предыдущий ход"}</button></p>}
    {selectedMove.conditions !== undefined && conditionText(selectedMove.conditions) && <details className="elements-secondary"><summary>Условия выполнения</summary><p>{conditionText(selectedMove.conditions)}</p></details>}
   </>}
  </Dialog.Content></Dialog.Portal></Dialog.Root>
 </main>;
}
