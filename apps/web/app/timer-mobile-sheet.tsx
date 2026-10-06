"use client";
// ABOUTME: Переносит мобильную панель Focus с исходными drag, анимацией и browser Back.
// ABOUTME: Обёртка не меняет таймер и оставляет всю сессию целью редактора истории.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useMobileSheetDrag } from "./shell/use-mobile-sheet-drag";
import { useSoftwareKeyboardOpen } from "./shell/use-software-keyboard-open";

const marker = "__braiTimerContextSheet";

/** Показывает исходную context sheet в доступной области Timer; Back и drag закрывают только её. */
export default function TimerMobileSheet({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) {
 const pathname = usePathname();
 const keyboardOpen = useSoftwareKeyboardOpen(true);
 const [sheetTop, setSheetTop] = useState(0);
 const onCloseRef = useRef(onClose);
 const labelRef = useRef(label);
 const initialPath = useRef(pathname);
 const opener = useRef<HTMLElement | null>(null);
 const closeButton = useRef<HTMLButtonElement | null>(null);
 const backPending = useRef(false);
 const backDone = useRef(false);
 const animationDone = useRef(false);
 const finalized = useRef(false);
 onCloseRef.current = onClose;
 labelRef.current = label;
 const finishIfReady = useCallback(() => {
  if (!backDone.current || !animationDone.current || finalized.current) return;
  finalized.current = true;
  onCloseRef.current();
  const trigger = opener.current;
  if (trigger?.isConnected) requestAnimationFrame(() => { if (trigger.isConnected) trigger.focus(); });
 }, []);
 const finishAnimation = useCallback(() => {
  animationDone.current = true;
  if (history.state?.[marker] && !backPending.current) {
   backPending.current = true; backDone.current = false; history.back();
  } else if (!backPending.current) backDone.current = true;
  finishIfReady();
 }, [finishIfReady]);
 const sheet = useMobileSheetDrag({ axis: "y", enabled: true, onClose: finishAnimation });
 const closeSheet = useCallback(() => {
  if (finalized.current || backPending.current) return;
  if (history.state?.[marker]) {
   backPending.current = true; backDone.current = false; history.back();
  } else backDone.current = true;
  sheet.closeWithAnimation();
 }, [sheet.closeWithAnimation]);

 // AIDEV-NOTE: Исходный useMobileSheetTop привязывает sheet к нижней границе текущего header.
 useLayoutEffect(() => {
  const header = document.querySelector<HTMLElement>(".timer-page-header");
  const update = () => setSheetTop(Math.ceil(header?.getBoundingClientRect().bottom ?? 0));
  update();
  const observer = header && typeof ResizeObserver !== "undefined" ? new ResizeObserver(update) : null;
  if (header) observer?.observe(header);
  window.addEventListener("resize", update); window.visualViewport?.addEventListener("resize", update);
  return () => { observer?.disconnect(); window.removeEventListener("resize", update); window.visualViewport?.removeEventListener("resize", update); };
 }, []);

 useEffect(() => {
  opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  sheet.resetOpen();
  const oldState = history.state && typeof history.state === "object" ? history.state : {};
  if (oldState[marker]) history.replaceState({ ...oldState, [marker]: labelRef.current }, "", location.href);
  else history.pushState({ ...oldState, [marker]: labelRef.current }, "", location.href);
  const popstate = () => {
   if (history.state?.[marker]) return;
   backPending.current = false; backDone.current = true;
   sheet.closeWithAnimation(); finishIfReady();
  };
  const escape = (event: KeyboardEvent) => {
   if (event.key !== "Escape" || event.defaultPrevented) return;
   event.preventDefault(); closeSheet();
  };
  const frame = requestAnimationFrame(() => closeButton.current?.focus());
  window.addEventListener("popstate", popstate);
  window.addEventListener("keydown", escape);
  return () => {
   cancelAnimationFrame(frame);
   window.removeEventListener("popstate", popstate); window.removeEventListener("keydown", escape);
   if (history.state?.[marker]) {
    // AIDEV-NOTE: Смена native route не должна возвращать пользователя на прошлый раздел.
    if (location.pathname !== initialPath.current) {
     const state = { ...history.state }; delete state[marker]; history.replaceState(state, "", location.href);
    } else if (!backPending.current) history.back();
   }
  };
 }, [closeSheet, finishIfReady, sheet.closeWithAnimation, sheet.resetOpen]);
 useEffect(() => {
  if (history.state?.[marker]) history.replaceState({ ...history.state, [marker]: label }, "", location.href);
 }, [label]);
 useEffect(() => {
  if (pathname !== initialPath.current) onCloseRef.current();
 }, [pathname]);

 return <div ref={sheet.gestureRef} className="mobile-context-backdrop fixed inset-x-0 z-[84] flex items-end" style={{ top: sheetTop, bottom: keyboardOpen ? 0 : "calc(3.25rem + env(safe-area-inset-bottom))" }} data-nav-swipe-exclusion onClick={closeSheet} {...sheet.sheetDragHandlers}>
  <div ref={sheet.backdropRef} className="absolute inset-0 z-0 bg-foreground/20 dark:bg-background/80" style={sheet.backdropStyle} aria-hidden="true" />
  <aside ref={sheet.sheetRef} className={`timer-mobile-context-sheet pointer-events-auto relative z-[1] grid h-full max-h-full w-full min-w-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden rounded-t-2xl border-t border-border bg-card pt-2 shadow-xl will-change-transform ${keyboardOpen ? "pb-0" : "pb-[env(safe-area-inset-bottom)]"}`} style={sheet.sheetStyle} aria-label={label} onClick={event => event.stopPropagation()}>
   <header className="relative flex min-h-12 items-start justify-center pt-4">
    <button ref={closeButton} type="button" className="sr-only" aria-label={`Закрыть панель: ${label}`} onClick={closeSheet}>Закрыть</button>
    <div className="mobile-context-drag-zone absolute left-1/2 top-0 flex h-6 w-32 -translate-x-1/2 touch-none cursor-grab items-start justify-center pt-1.5 active:cursor-grabbing"><span className="mobile-context-grabber h-1 w-11 rounded-full bg-muted-foreground/30" aria-hidden="true" /></div>
    <h2 className="m-0 text-lg font-semibold leading-tight">{label}</h2>
   </header>
   <ScrollArea className="min-h-0" contentInset="balanced">{children}</ScrollArea>
  </aside>
 </div>;
}
