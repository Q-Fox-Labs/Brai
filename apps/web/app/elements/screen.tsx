"use client";
// ABOUTME: Показывает интерактивную карту исторического демонстрационного снимка.
// ABOUTME: Только раскладка сохраняется в браузере; реальные действия и API не вызываются.
import { useCallback, useEffect, useRef, useState, type PointerEvent } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Check, Grip, Maximize, Minus, Plus, RotateCcw, X } from "lucide-react";
import demo from "./demo.json";
import { cardHeight, cardWidth, clampZoom, fitView, initialPositions, readLayout, sequenceMoves, type BoardData, type Layout, type Move, type Point } from "./model";
import "./elements.css";
const data: BoardData = demo;
const defaults = initialPositions(data.elements);

/** Создаёт карту по переданным записям; хранилище разделено по аккаунтам. */
export default function ElementsScreen({ userId, dataset = data }: { userId: string; dataset?: BoardData }) {
 const orderedMoves = sequenceMoves(dataset.moves);
 const canvas = useRef<HTMLDivElement>(null);
 const positionsDefault = dataset === data ? defaults : initialPositions(dataset.elements);
 const storageKey = `brai.elements.demo-layout.v1:${userId}`;
 const [layout, setLayout] = useState<Layout>({ positions: positionsDefault, view: { x: 0, y: 0, zoom: 0.5 } });
 const [ready, setReady] = useState(false), [notice, setNotice] = useState(""), [selected, setSelected] = useState<Move | null>(null);
 const [hierarchy, setHierarchy] = useState(true), [results, setResults] = useState(true);
 const drag = useRef<{ pointer: number; start: Point; origin: Point; elementId?: string } | null>(null);
 const [dragging, setDragging] = useState(false);
 const listTouch = useRef<{ y: number; top: number } | null>(null);
 const state = useRef(layout); state.current = layout;
 const showAll = useCallback(() => {
  const bounds = canvas.current?.getBoundingClientRect();
  if (bounds) setLayout(old => ({ ...old, view: fitView(old.positions, bounds.width, bounds.height) }));
 }, []);
 useEffect(() => {
  const bounds = canvas.current?.getBoundingClientRect();
  let saved: Layout | null = null;
  try { saved = readLayout(localStorage.getItem(storageKey), positionsDefault); } catch { setNotice("Хранение недоступно. Раскладка сохранится до закрытия страницы."); }
  setLayout(saved ?? { positions: positionsDefault, view: fitView(positionsDefault, bounds?.width ?? 900, bounds?.height ?? 650) });
  setReady(true);
  // AIDEV-NOTE: Account размонтирует экран при смене раздела; восстановление относится к текущему набору.
 }, [storageKey, dataset]);
 useEffect(() => {
  if (!ready) return;
  const timer = setTimeout(() => {
   try { localStorage.setItem(storageKey, JSON.stringify({ version: 1, ...layout })); }
   catch { setNotice("Не удалось сохранить раскладку. Она доступна до закрытия страницы."); }
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
   if ((event.target as HTMLElement).closest?.(".elements-moves") && !event.ctrlKey && !event.metaKey) return;
   event.preventDefault();
   const bounds = node.getBoundingClientRect();
   zoomAt(Math.exp(-event.deltaY * 0.002), { x: event.clientX - bounds.left, y: event.clientY - bounds.top });
  };
  node.addEventListener("wheel", wheel, { passive: false });
  return () => node.removeEventListener("wheel", wheel);
 }, [zoomAt]);
 function focusElement(id: string) {
  const p = layout.positions[id], bounds = canvas.current?.getBoundingClientRect(); if (!p || !bounds) return;
  const zoom = Math.min(1, (bounds.width - 36) / cardWidth, (bounds.height - 36) / cardHeight);
  setLayout(old => ({ ...old, view: { x: bounds.width / 2 - (p.x + cardWidth / 2) * zoom, y: bounds.height / 2 - (p.y + cardHeight / 2) * zoom, zoom: clampZoom(zoom) } }));
 }
 function startDrag(event: PointerEvent<HTMLElement>, elementId?: string) {
  if (event.button !== 0 || drag.current) return;
  if (!elementId && (event.target as HTMLElement).closest("article,button,select")) return;
  event.preventDefault(); event.stopPropagation();
  event.currentTarget.setPointerCapture(event.pointerId);
  drag.current = { pointer: event.pointerId, start: { x: event.clientX, y: event.clientY }, origin: elementId ? layout.positions[elementId] : layout.view, elementId };
  setDragging(true);
 }
 function moveDrag(event: PointerEvent<HTMLElement>) {
  const d = drag.current; if (!d || d.pointer !== event.pointerId) return;
  const scale = d.elementId ? state.current.view.zoom : 1;
  const next = { x: d.origin.x + (event.clientX - d.start.x) / scale, y: d.origin.y + (event.clientY - d.start.y) / scale };
  setLayout(old => d.elementId ? { ...old, positions: { ...old.positions, [d.elementId]: next } } : { ...old, view: { ...old.view, ...next } });
 }
 function stopDrag() { drag.current = null; setDragging(false); }
 function reset() {
  const bounds = canvas.current?.getBoundingClientRect(); if (!bounds) return;
  setLayout({ positions: positionsDefault, view: fitView(positionsDefault, bounds.width, bounds.height) });
  setNotice("Исходная раскладка восстановлена.");
 }
 // Передача к следующей Задаче берётся из её входов. Накопленные транзитивные входы не дублируют линию.
 const transfers = dataset.elements.flatMap(target => {
  const sources = dataset.elements.filter(source => source.id !== target.id && source.output.some(id => target.input.includes(id)));
  const latest = sources.sort((a, b) => Math.max(...orderedMoves.filter(m => m.targetId === b.id).map(m => m.order)) - Math.max(...orderedMoves.filter(m => m.targetId === a.id).map(m => m.order)))[0];
  return latest ? [{ from: latest.id, to: target.id, label: latest.output.filter(id => target.input.includes(id)).join(", "), returnToParent: false }] : [];
 });
 // Приёмка принадлежит родителю. Выход дочернего Элемента создаёт именно этот Ход.
 for (const source of dataset.elements) {
  if (!source.parentId) continue;
  const acceptance = orderedMoves.find(m => m.ownerId === source.parentId && m.targetId === source.id && m.output.some(id => source.output.includes(id)));
  if (acceptance) transfers.push({ from: source.id, to: source.parentId, label: `${source.output.join(", ")} · ${acceptance.id}`, returnToParent: true });
 }
 const links = [
  ...(hierarchy ? dataset.elements.filter(e => e.parentId && layout.positions[e.parentId]).map(e => ({ from: e.parentId!, to: e.id, label: "Вложенность", type: "hierarchy", returnToParent: false })) : []),
  ...(results ? transfers.map(t => ({ ...t, type: "result" })) : []),
 ];
 return <main className="elements-screen">
  <header className="elements-heading"><div><h1>Элементы</h1><p>Карта Цели, Задач и их Ходов</p></div><span className="elements-demo">Демонстрация</span></header>
  <div className="elements-context"><span><Check size={15} /> Исторический конечный снимок</span><span>{dataset.elements.length} Элемента · {dataset.moves.length} Хода · {dataset.resources.length} ресурсов. Все Ходы выполнены.</span><span>Это симуляция. Живое исполнение не подключено.</span></div>
  <div className="elements-toolbar" aria-label="Управление картой">
   <button type="button" onClick={showAll}><Maximize size={16} /> Вся карта</button>
   <select aria-label="Приблизить Элемент" value="" onChange={event => focusElement(event.target.value)}><option value="" disabled>К Элементу…</option>{dataset.elements.map(e => <option key={e.id} value={e.id}>{e.id} · {e.title}</option>)}</select>
   <div className="elements-zoom"><button type="button" aria-label="Уменьшить масштаб" onClick={() => zoomAt(1 / 1.2)}><Minus size={16} /></button><output aria-label="Масштаб">{Math.round(layout.view.zoom * 100)}%</output><button type="button" aria-label="Увеличить масштаб" onClick={() => zoomAt(1.2)}><Plus size={16} /></button></div>
   <button type="button" className="elements-reset" onClick={reset}><RotateCcw size={15} /><span>Сбросить раскладку</span></button>
  </div>
  <div className="elements-legend"><label><input type="checkbox" checked={hierarchy} onChange={event => setHierarchy(event.target.checked)} /><i className="elements-line-key hierarchy" />Вложенность</label><label><input type="checkbox" checked={results} onChange={event => setResults(event.target.checked)} /><i className="elements-line-key result" />Передача результата</label><span>Стрелка указывает получателя. Нажмите Ход для подробностей.</span></div>
  <div ref={canvas} className={"elements-canvas" + (dragging ? " is-dragging" : "")} tabIndex={0} role="region" aria-label="Полотно Элементов" aria-describedby="elements-help"
   onPointerDown={event => startDrag(event)} onPointerMove={moveDrag} onPointerUp={stopDrag} onPointerCancel={stopDrag} onLostPointerCapture={stopDrag}
   onKeyDown={event => { if (event.target !== event.currentTarget) return; const shifts: Record<string, Point> = { ArrowLeft: { x: 60, y: 0 }, ArrowRight: { x: -60, y: 0 }, ArrowUp: { x: 0, y: 60 }, ArrowDown: { x: 0, y: -60 } }; const delta = shifts[event.key]; if (delta) { event.preventDefault(); setLayout(old => ({ ...old, view: { ...old.view, x: old.view.x + delta.x, y: old.view.y + delta.y } })); } if (event.key === "+" || event.key === "=") zoomAt(1.2); if (event.key === "-") zoomAt(1 / 1.2); }}>
   {!dataset.elements.length && <p className="elements-empty">На карте пока нет Элементов.</p>}
   <div className="elements-world" style={{ transform: `translate(${layout.view.x}px, ${layout.view.y}px) scale(${layout.view.zoom})`, visibility: ready ? "visible" : "hidden" }}>
    <svg className="elements-links" aria-label="Связи Элементов"><defs>{["hierarchy", "result"].map(type => <marker key={type} id={`elements-arrow-${type}`} markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto"><path d="M1,1 L8,5 L1,9" fill="none" stroke={type === "result" ? "#8ea2ff" : "#8c9c96"} strokeWidth="1.5" /></marker>)}</defs>
     {links.map((link, index) => {
      const a = layout.positions[link.from], b = layout.positions[link.to]; if (!a || !b) return null;
      const hierarchyLink = link.type === "hierarchy";
      const side = !hierarchyLink && !link.returnToParent;
      const start = side ? { x: a.x + cardWidth, y: a.y + cardHeight / 2 } : { x: a.x + cardWidth / 2 + (link.returnToParent ? 135 : -50), y: a.y + (link.returnToParent ? 0 : cardHeight) };
      const end = side ? { x: b.x, y: b.y + cardHeight / 2 } : { x: b.x + cardWidth / 2 + (link.returnToParent ? 100 : -50), y: b.y + (link.returnToParent ? cardHeight : 0) };
      const middle = (start.y + end.y) / 2 + (link.returnToParent ? 35 : -25);
      const path = side ? `M${start.x},${start.y} C${start.x + 70},${start.y} ${end.x - 70},${end.y} ${end.x},${end.y}` : `M${start.x},${start.y} C${start.x},${middle} ${end.x},${middle} ${end.x},${end.y}`;
      return <g key={`${link.type}-${link.from}-${link.to}`} className={`elements-link ${link.type}`}><title>{`${link.from} → ${link.to}: ${link.label}`}</title><path d={path} markerEnd={`url(#elements-arrow-${link.type})`} /><text x={(start.x + end.x) / 2} y={side ? start.y - 12 : middle + (index % 2) * 20} textAnchor="middle">{link.label}</text></g>;
     })}
    </svg>
    {dataset.elements.map(element => {
     const point = layout.positions[element.id] ?? { x: 0, y: 0 }, moves = orderedMoves.filter(m => m.ownerId === element.id);
     return <article key={element.id} className="elements-card" data-element-id={element.id} style={{ left: point.x, top: point.y, width: cardWidth, height: cardHeight }} aria-label={`${element.id}: ${element.title}`}>
      <button type="button" className="elements-card-grip" aria-label={`Переместить ${element.id}. Стрелки перемещают карточку`} onPointerDown={event => startDrag(event, element.id)} onPointerMove={moveDrag} onPointerUp={stopDrag} onPointerCancel={stopDrag} onLostPointerCapture={stopDrag}
       onDoubleClick={() => focusElement(element.id)} onKeyDown={event => { const deltas: Record<string, Point> = { ArrowLeft: { x: -20, y: 0 }, ArrowRight: { x: 20, y: 0 }, ArrowUp: { x: 0, y: -20 }, ArrowDown: { x: 0, y: 20 } }; const delta = deltas[event.key]; if (delta) { event.preventDefault(); setLayout(old => ({ ...old, positions: { ...old.positions, [element.id]: { x: point.x + delta.x, y: point.y + delta.y } } })); } }}><span>{element.kind === "goal" ? "Цель" : "Задача"} {element.id}</span><span className="elements-card-done"><Check size={14} /> Выполнена</span><Grip size={16} /></button>
      <h2>{element.title}</h2><p className="elements-description">{element.description}</p>
      <div className="elements-moves-title"><span>Ходы</span><span>{moves.length} / {moves.length}</span></div>
      <div className="elements-moves" tabIndex={0} aria-label={`Ходы ${element.id}`} onPointerDown={event => { if (event.pointerType === "touch") listTouch.current = { y: event.clientY, top: event.currentTarget.scrollTop }; }} onPointerMove={event => { if (event.pointerType === "touch" && listTouch.current) event.currentTarget.scrollTop = listTouch.current.top + listTouch.current.y - event.clientY; }} onPointerUp={() => { listTouch.current = null; }} onPointerCancel={() => { listTouch.current = null; }}>
       {moves.map(move => <button type="button" key={move.id} className="elements-move" data-move-id={move.id} onClick={() => setSelected(move)}><span className="elements-move-number">{move.order}</span><span className="elements-move-body"><span>{move.title}</span><small>{move.kind === "operation" ? "Операция" : "Экшен"} · {move.id}</small></span><span className="elements-move-status" aria-label="Выполнен"><Check size={16} /></span></button>)}
       {!moves.length && <p>Ходов пока нет.</p>}
      </div><footer>Результат: {element.output.map(id => dataset.resources.find(r => r.id === id)?.title ?? id).join(", ") || "Не указан"}</footer>
     </article>;
    })}
   </div>
  </div>
  <footer className="elements-help" id="elements-help"><span>Тяните фон для перемещения. Колесо или + / − меняют масштаб. Тяните карточку за верхнюю строку.</span><span role="status">{notice || "Раскладка сохраняется в этом браузере."}</span></footer>
  <Dialog.Root open={selected !== null} onOpenChange={open => { if (!open) setSelected(null); }}><Dialog.Portal><Dialog.Overlay className="elements-detail-overlay" /><Dialog.Content className="elements-detail" aria-describedby="elements-detail-description">
   <Dialog.Close className="elements-detail-close" aria-label="Закрыть подробности"><X size={20} /></Dialog.Close>
   <Dialog.Title>{selected?.title}</Dialog.Title><Dialog.Description id="elements-detail-description">Исторический Ход {selected?.id}. Выполнен в симуляции.</Dialog.Description>
   {selected && <><dl><dt>Тип</dt><dd>{selected.kind === "operation" ? "Операция" : "Экшен"}</dd><dt>Исполнитель</dt><dd>{selected.executor === "agent" ? "Агент" : "Игрок"}</dd><dt>Владелец Хода</dt><dd>{selected.ownerId} · {dataset.elements.find(e => e.id === selected.ownerId)?.title}</dd><dt>Целевой Элемент</dt><dd>{selected.targetId} · {dataset.elements.find(e => e.id === selected.targetId)?.title}</dd><dt>Предшественник</dt><dd>{selected.previousId ? <button type="button" className="elements-text-link" onClick={() => setSelected(orderedMoves.find(m => m.id === selected.previousId) ?? null)}>{selected.previousId} · {orderedMoves.find(m => m.id === selected.previousId)?.title}</button> : "Нет — начало цепочки"}</dd><dt>Попытка</dt><dd>{selected.attemptId} · Успешна</dd></dl>
    <p className="elements-detail-note">Подробная инструкция в исходном снимке не приведена. Просмотр Хода не запускает действий.</p>
    {(["output", "input"] as const).map(role => <section key={role} className="elements-resources"><h3>{role === "input" ? "Входные ресурсы" : "Выходные ресурсы"} <span>{selected[role].length}</span></h3>{role === "input" && <p>Все накопленные ссылки предшественника.</p>}{selected[role].map(id => { const resource = dataset.resources.find(r => r.id === id); if (!resource) return null; const creator = orderedMoves.find(m => m.attemptId === resource.attemptId); return <details key={id}><summary><span>{id}</span> {resource.title}</summary><p>{resource.content}</p><p className="elements-resource-origin">Происхождение: {creator ? <button type="button" className="elements-text-link" onClick={() => setSelected(creator)}>{creator.id} · {resource.attemptId}</button> : "Внешнее поручение Игрока"}</p></details>; })}</section>)}
   </>}
  </Dialog.Content></Dialog.Portal></Dialog.Root>
 </main>;
}
