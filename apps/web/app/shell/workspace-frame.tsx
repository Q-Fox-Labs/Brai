"use client";
// ABOUTME: Геометрия рабочих разделов и локальные настройки панелей.
// ABOUTME: Раздел передаёт содержимое, оболочка управляет размерами и прокруткой.
import { createContext, useContext, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen } from "lucide-react";
import "./workspace-frame.css";

type Tab = { id: string; label: string; content: ReactNode };
type Settings = { left: number; right: number; leftOpen: boolean; rightOpen: boolean; tab: string };
type Props = { section: string; userId: string; title: string; railTitle?: string; railStatus?: ReactNode; rail?: ReactNode; children: ReactNode; tabs?: Tab[]; defaultRightOpen?: boolean; onRightOpen?: () => void; onRightClose?: () => void; openRightSignal?: string | null; externalRightHeader?: boolean };
const LEFT_MIN = 220, LEFT_MAX = 420, RIGHT_MIN = 320, RIGHT_MAX = 720, CENTER_MIN = 360;
const RightHeader = createContext<HTMLElement | null>(null);
export const useWorkspaceRightHeader = () => useContext(RightHeader);
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, Math.max(min, max)));

/** Сохраняет размеры и открытое состояние отдельно для аккаунта и раздела. */
export default function WorkspaceFrame({ section, userId, title, railTitle, railStatus, rail, children, tabs = [], defaultRightOpen = false, onRightOpen, onRightClose, openRightSignal, externalRightHeader = false }: Props) {
 const key = `brai.workspace.${userId}.${section}`;
 const defaults = (): Settings => ({ left: 280, right: 440, leftOpen: !!rail, rightOpen: defaultRightOpen, tab: tabs[0]?.id ?? "" });
 const [settings, setSettings] = useState<Settings>(defaults);
 const [loadedKey, setLoadedKey] = useState("");
 const [width, setWidth] = useState(0);
 const [rightHeader, setRightHeader] = useState<HTMLElement | null>(null);
 const [everRight, setEverRight] = useState(false);
 const [temporary, setTemporary] = useState<"left" | "right" | null>(null);
 const frame = useRef<HTMLDivElement>(null);
 const onRightOpenRef = useRef(onRightOpen);
 onRightOpenRef.current = onRightOpen;
 const overlayOpener = useRef<HTMLElement | null>(null);
 const drag = useRef<{ side: "left" | "right"; x: number; initial: number } | null>(null);
 useEffect(() => {
  const next = defaults();
  try {
   const saved = JSON.parse(localStorage.getItem(key) || "null") as Partial<Settings> | null;
   if (saved) {
    if (typeof saved.left === "number" && Number.isFinite(saved.left)) next.left = clamp(saved.left, LEFT_MIN, LEFT_MAX);
    if (typeof saved.right === "number" && Number.isFinite(saved.right)) next.right = clamp(saved.right, RIGHT_MIN, RIGHT_MAX);
    if (typeof saved.leftOpen === "boolean") next.leftOpen = saved.leftOpen;
    if (typeof saved.rightOpen === "boolean") next.rightOpen = saved.rightOpen;
    if (typeof saved.tab === "string") next.tab = saved.tab;
   }
  } catch { /* Хранилище может быть недоступно. */ }
  setSettings(next); setLoadedKey(key); setTemporary(null);
 }, [key]);
 useEffect(() => { if (loadedKey === key) { try { localStorage.setItem(key, JSON.stringify(settings)); } catch { /* Работа без сохранения. */ } } }, [key, loadedKey, settings]);
 useEffect(() => {
  const node = frame.current;
  if (!node) return;
  const observer = new ResizeObserver(entries => setWidth(entries[0].contentRect.width));
  observer.observe(node);
  return () => observer.disconnect();
 }, []);
 const leftAvailable = !!rail && width >= LEFT_MIN + CENTER_MIN;
 const rightAvailable = !!tabs.length && width >= RIGHT_MIN + CENTER_MIN + (settings.leftOpen && leftAvailable ? LEFT_MIN : 0);
 useEffect(() => {
  if (temporary === "left" && leftAvailable || temporary === "right" && rightAvailable) setTemporary(null);
 }, [temporary, leftAvailable, rightAvailable]);
 const leftVisible = !!rail && settings.leftOpen && leftAvailable;
 const rightVisible = !!tabs.length && settings.rightOpen && rightAvailable;
 useEffect(() => { if (rightVisible || temporary === "right") { setEverRight(true); onRightOpenRef.current?.(); } }, [rightVisible, temporary]);
 useEffect(() => {
  if (openRightSignal === undefined) return;
  setSettings(current => ({ ...current, rightOpen: !!openRightSignal }));
  if (openRightSignal && width && !rightAvailable) { overlayOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setTemporary("right"); }
  if (!openRightSignal) setTemporary(null);
 }, [openRightSignal]);
 const leftWidth = leftVisible ? clamp(settings.left, LEFT_MIN, Math.min(LEFT_MAX, width - CENTER_MIN - (rightVisible ? RIGHT_MIN : 0))) : 0;
 const rightWidth = rightVisible ? clamp(settings.right, RIGHT_MIN, Math.min(RIGHT_MAX, width - CENTER_MIN - leftWidth)) : 0;
 const style = { "--frame-left": `${leftWidth}px`, "--frame-right": `${rightWidth}px` } as CSSProperties;
 useEffect(() => {
  if (!temporary) return;
  const closeButton = frame.current?.querySelector<HTMLButtonElement>(".workspace-frame-overlay-close");
  requestAnimationFrame(() => closeButton?.focus());
  const close = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); setTemporary(null); if (temporary === "right") onRightClose?.(); overlayOpener.current?.focus(); } };
  document.addEventListener("keydown", close);
  return () => document.removeEventListener("keydown", close);
 }, [temporary]);
 const activeTab = tabs.find(tab => tab.id === settings.tab) ?? tabs[0];
 const toggle = (side: "left" | "right") => {
  if (side === "left" && !leftAvailable || side === "right" && !rightAvailable) { if (side === "right" && temporary === "right") onRightClose?.(); setTemporary(current => current === side ? null : side); return; }
  if (side === "right" && settings.rightOpen) onRightClose?.();
  setSettings(current => side === "left" ? { ...current, leftOpen: !current.leftOpen } : { ...current, rightOpen: !current.rightOpen });
 };
 const resize = (side: "left" | "right", value: number) => setSettings(current => side === "left"
  ? { ...current, left: clamp(value, LEFT_MIN, Math.min(LEFT_MAX, width - CENTER_MIN - (rightVisible ? rightWidth : 0))) }
  : { ...current, right: clamp(value, RIGHT_MIN, Math.min(RIGHT_MAX, width - CENTER_MIN - (leftVisible ? leftWidth : 0))) });
 const start = (side: "left" | "right", event: PointerEvent<HTMLDivElement>) => {
  drag.current = { side, x: event.clientX, initial: side === "left" ? leftWidth : rightWidth };
  event.currentTarget.setPointerCapture(event.pointerId);
 };
 const move = (event: PointerEvent<HTMLDivElement>) => {
  if (!drag.current) return;
  const { side, x, initial } = drag.current;
  resize(side, initial + (event.clientX - x) * (side === "left" ? 1 : -1));
 };
 const keyboard = (side: "left" | "right", event: KeyboardEvent<HTMLDivElement>) => {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const current = side === "left" ? leftWidth : rightWidth;
  const direction = (event.key === "ArrowRight" ? 1 : -1) * (side === "left" ? 1 : -1);
  resize(side, event.key === "Home" ? 0 : event.key === "End" ? 10000 : current + direction * (event.shiftKey ? 40 : 10));
 };
 const separator = (side: "left" | "right", value: number) => <div className={`workspace-frame-separator is-${side}`} role="separator" aria-label={side === "left" ? "Ширина панели раздела" : "Ширина правой панели"} aria-orientation="vertical" aria-valuemin={side === "left" ? LEFT_MIN : RIGHT_MIN} aria-valuemax={side === "left" ? LEFT_MAX : RIGHT_MAX} aria-valuenow={Math.round(value)} tabIndex={0} onPointerDown={event => start(side, event)} onPointerMove={move} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} onKeyDown={event => keyboard(side, event)}><span aria-hidden="true">⋮</span></div>;
 const controls = (side: "left" | "right", open: boolean) => <button type="button" className="workspace-frame-toggle" aria-label={`${open ? "Скрыть" : "Открыть"} ${side === "left" ? "панель раздела" : "правую панель"}`} aria-expanded={open} onClick={event => { overlayOpener.current = event.currentTarget; toggle(side); }}>{side === "left" ? open ? <PanelLeftClose /> : <PanelLeftOpen /> : open ? <PanelRightClose /> : <PanelRightOpen />}</button>;
 const tabButtons = <nav aria-label="Вкладки правой панели">{tabs.map(tab => <button key={tab.id} type="button" aria-current={activeTab?.id === tab.id ? "page" : undefined} onClick={() => setSettings(current => ({ ...current, tab: tab.id }))}>{tab.label}</button>)}</nav>;
 const tabContents = tabs.map(tab => <div className="workspace-frame-tab-panel" key={tab.id} hidden={tab.id !== activeTab?.id}>{tab.content}</div>);
 return <RightHeader.Provider value={rightHeader}><div className="workspace-frame" style={style}>
  <header className="workspace-frame-header">
   {leftVisible && <div className={`workspace-frame-heading-left${railStatus ? " has-status" : ""}`}><strong>{railTitle ?? title}</strong>{railStatus && <div className="workspace-frame-rail-status">{railStatus}</div>}{controls("left", true)}</div>}
   <div className="workspace-frame-heading-center">{rail && !leftVisible && controls("left", temporary === "left")}<strong title={title}>{title}</strong>{!!tabs.length && !rightVisible && controls("right", temporary === "right")}</div>
   {rightVisible && <div className="workspace-frame-heading-right">{externalRightHeader ? <div ref={setRightHeader} className="workspace-frame-custom-tabs" /> : tabButtons}{controls("right", true)}</div>}
  </header>
  <div className="workspace-frame-body" ref={frame}>
   {rail && <aside className={`workspace-frame-rail${temporary === "left" ? " workspace-frame-overlay is-left" : ""}`} hidden={!leftVisible && temporary !== "left"} onClick={event => { if (temporary === "left" && (event.target as HTMLElement).closest("[data-frame-close-rail]")) setTemporary(null); }}>{temporary === "left" && (railStatus ? <div className="workspace-frame-overlay-heading"><strong>{railTitle ?? title}</strong><div className="workspace-frame-rail-status">{railStatus}</div><button type="button" className="workspace-frame-overlay-close workspace-frame-toggle" aria-label="Скрыть панель раздела" onClick={() => { setTemporary(null); overlayOpener.current?.focus(); }}><PanelLeftClose /></button></div> : <button type="button" className="workspace-frame-overlay-close" onClick={() => { setTemporary(null); overlayOpener.current?.focus(); }}>Закрыть</button>)}{rail}</aside>}
   {leftVisible && separator("left", leftWidth)}
   <div className="workspace-frame-center">{children}</div>
   {rightVisible && separator("right", rightWidth)}
   {!!tabs.length && <aside className={`workspace-frame-right${temporary === "right" ? " workspace-frame-overlay is-right" : ""}`} hidden={!rightVisible && temporary !== "right"}>{temporary === "right" && <><button type="button" className="workspace-frame-overlay-close" onClick={() => { setTemporary(null); onRightClose?.(); overlayOpener.current?.focus(); }}>Закрыть</button>{externalRightHeader ? <div ref={setRightHeader} className="workspace-frame-custom-tabs" /> : tabButtons}</>}{everRight && tabContents}</aside>}
  </div>
 </div></RightHeader.Provider>;
}
