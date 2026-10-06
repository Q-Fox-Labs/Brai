"use client";
// ABOUTME: Управляет перетаскиванием и анимацией мобильных панелей.
// ABOUTME: Сохраняет scroll viewport, исключает поля ввода и учитывает reduced motion.

import type { CSSProperties, PointerEvent } from "react";
import { useCallback, useEffect, useRef } from "react";

type DragState = {
  id: number;
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  active: boolean;
  initialScrollTop: number;
  startedWithScrollableOffset: boolean;
  scrollViewport: HTMLElement | null;
};

type DragAxis = "x" | "y";

const DRAG_HARD_EXCLUSION_SELECTOR = "input, select, textarea, [role='switch'], [role='slider'], [contenteditable='true'], [data-mobile-sheet-no-drag]";
const DRAG_CONTROL_SELECTOR = "button, a, [role='button']";
const SCROLL_VIEWPORT_SELECTOR = "[data-slot='scroll-area-viewport']";
const DRAG_ACTIVATION_PX = 10;
const MOTION_MS = 200;
const MOTION_EASING = "cubic-bezier(0.2, 0.8, 0.2, 1)";
const BACKDROP_FADE_START_RATIO = 0.5;
const SHEET_OFFSET_VAR = "--mobile-sheet-offset";
const BACKDROP_OPACITY_VAR = "--mobile-sheet-backdrop-opacity";

/** Возвращает refs, стили и обработчики для панели с закрытием свайпом. */
export function useMobileSheetDrag({
  axis = "y",
  excludeControls = true,
  enabled = true,
  onClose,
  onCloseStart,
}: {
  axis?: DragAxis;
  excludeControls?: boolean;
  enabled?: boolean;
  onClose: () => void;
  onCloseStart?: () => void;
}) {
  const reduceMotion = prefersReducedMotion();
  const onCloseRef = useRef(onClose);
  const onCloseStartRef = useRef(onCloseStart);
  const dragRef = useRef<DragState | null>(null);
  const sheetElementRef = useRef<HTMLElement | null>(null);
  const backdropElementRef = useRef<HTMLElement | null>(null);
  const gestureElementRef = useRef<HTMLElement | null>(null);
  const removeNativeTouchRef = useRef<(() => void) | null>(null);
  const timerRef = useRef<number | null>(null);
  const offsetFrameRef = useRef<number | null>(null);
  const openFrameRef = useRef<number | null>(null);
  const pendingOffsetRef = useRef(0);
  const currentOffsetRef = useRef(0);
  const closingRef = useRef(false);

  useEffect(() => {
    onCloseRef.current = onClose;
    onCloseStartRef.current = onCloseStart;
  }, [onClose, onCloseStart]);

  const clearMotion = useCallback(() => {
    if (timerRef.current != null) window.clearTimeout(timerRef.current);
    if (offsetFrameRef.current != null) window.cancelAnimationFrame(offsetFrameRef.current);
    if (openFrameRef.current != null) window.cancelAnimationFrame(openFrameRef.current);
    timerRef.current = null;
    offsetFrameRef.current = null;
    openFrameRef.current = null;
  }, []);

  useEffect(() => () => {
    removeNativeTouchRef.current?.();
    clearMotion();
  }, [clearMotion]);

  const applyOffset = useCallback((nextOffset: number) => {
    const offset = Math.max(0, nextOffset);
    currentOffsetRef.current = offset;
    sheetElementRef.current?.style.setProperty(SHEET_OFFSET_VAR, `${offset}px`);
    backdropElementRef.current?.style.setProperty(
      BACKDROP_OPACITY_VAR,
      String(backdropOpacity(offset, panelSize(sheetElementRef.current, axis))),
    );
  }, [axis]);

  const scheduleOffset = useCallback((nextOffset: number) => {
    pendingOffsetRef.current = Math.max(0, nextOffset);
    if (offsetFrameRef.current != null) return;
    offsetFrameRef.current = window.requestAnimationFrame(() => {
      offsetFrameRef.current = null;
      applyOffset(pendingOffsetRef.current);
    });
  }, [applyOffset]);

  const setTransition = useCallback((active: boolean) => {
    const transition = active && !prefersReducedMotion()
      ? `${MOTION_MS}ms ${MOTION_EASING}`
      : "none";
    if (sheetElementRef.current) sheetElementRef.current.style.transition = `transform ${transition}`;
    if (backdropElementRef.current) backdropElementRef.current.style.transition = `opacity ${transition}`;
  }, []);

  const settle = useCallback((offset: number, done?: () => void) => {
    clearMotion();
    setTransition(true);
    scheduleOffset(offset);
    if (prefersReducedMotion()) {
      applyOffset(offset);
      done?.();
      return;
    }
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      setTransition(false);
      done?.();
    }, MOTION_MS);
  }, [applyOffset, clearMotion, scheduleOffset, setTransition]);

  const finishClose = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    onCloseStartRef.current?.();
    settle(closeDistance(sheetElementRef.current, axis), () => onCloseRef.current());
  }, [axis, settle]);

  const resetOpen = useCallback(() => {
    closingRef.current = false;
    dragRef.current = null;
    clearMotion();
    setTransition(false);
    applyOffset(closeDistance(sheetElementRef.current, axis));
    if (prefersReducedMotion()) {
      applyOffset(0);
      return;
    }
    openFrameRef.current = window.requestAnimationFrame(() => {
      openFrameRef.current = null;
      settle(0);
    });
  }, [applyOffset, axis, clearMotion, setTransition, settle]);

  const start = useCallback((id: number, clientX: number, clientY: number, target: EventTarget | null) => {
    if (!enabled || isHardExcluded(target) || (excludeControls && axis === "x" && isControl(target))) return false;
    clearMotion();
    setTransition(false);
    closingRef.current = false;
    const scrollViewport = closestScrollViewport(target);
    const initialScrollTop = scrollViewport?.scrollTop ?? 0;
    dragRef.current = {
      id,
      startX: clientX,
      startY: clientY,
      currentX: clientX,
      currentY: clientY,
      active: false,
      initialScrollTop,
      startedWithScrollableOffset: initialScrollTop > 0,
      scrollViewport,
    };
    return true;
  }, [axis, clearMotion, enabled, excludeControls, setTransition]);

  const move = useCallback((id: number, clientX: number, clientY: number, preventDefault: () => void) => {
    const drag = dragRef.current;
    if (!drag || drag.id !== id) return;
    const deltaX = clientX - drag.startX;
    const deltaY = clientY - drag.startY;

    if (!drag.active) {
      if (axis === "x" && (deltaX > 8 || Math.abs(deltaY) > Math.max(12, -deltaX))) {
        dragRef.current = null;
        return;
      }
      if (axis === "y" && (deltaY < -8 || Math.abs(deltaX) > Math.max(12, deltaY))) {
        dragRef.current = null;
        return;
      }
      if (axis === "x" && deltaX > -DRAG_ACTIVATION_PX) return;
      if (axis === "y" && deltaY < DRAG_ACTIVATION_PX) return;
      if (axis === "y" && drag.scrollViewport && drag.scrollViewport.scrollTop > 0) return;
      if (axis === "x") drag.startX -= DRAG_ACTIVATION_PX;
      if (axis === "y") drag.startY += DRAG_ACTIVATION_PX;
      if (drag.startedWithScrollableOffset) {
        drag.startY += drag.initialScrollTop;
        drag.startedWithScrollableOffset = false;
      }
      drag.active = true;
    }

    preventDefault();
    drag.currentX = clientX;
    drag.currentY = clientY;
    scheduleOffset(dragOffset(drag, axis));
  }, [axis, scheduleOffset]);

  const end = useCallback((id: number) => {
    const drag = dragRef.current;
    if (!drag || drag.id !== id) return;
    dragRef.current = null;
    if (!drag.active) return;
    if (dragOffset(drag, axis) > closeThreshold(sheetElementRef.current, axis)) finishClose();
    else settle(0);
  }, [axis, finishClose, settle]);

  const onPointerDown = useCallback((event: PointerEvent<HTMLElement>) => {
    if (event.pointerType === "touch" || (excludeControls && isControl(event.target))) return;
    const started = start(event.pointerId, event.clientX, event.clientY, event.target);
    if (started && typeof event.currentTarget.setPointerCapture === "function") event.currentTarget.setPointerCapture(event.pointerId);
  }, [excludeControls, start]);

  const onPointerMove = useCallback((event: PointerEvent<HTMLElement>) => {
    if (event.pointerType === "touch") return;
    move(event.pointerId, event.clientX, event.clientY, () => {
      if (event.cancelable) event.preventDefault();
    });
  }, [move]);

  const onPointerEnd = useCallback((event: PointerEvent<HTMLElement>) => {
    if (event.pointerType === "touch") return;
    if (typeof event.currentTarget.hasPointerCapture === "function" && event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    end(event.pointerId);
  }, [end]);

  const onNativeTouchStart = useCallback((event: TouchEvent) => {
    const touch = event.changedTouches[0];
    if (touch) start(touch.identifier, touch.clientX, touch.clientY, event.target);
  }, [start]);

  const onNativeTouchMove = useCallback((event: TouchEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const touch = Array.from(event.changedTouches).find((item) => item.identifier === drag.id);
    if (!touch) return;
    move(touch.identifier, touch.clientX, touch.clientY, () => {
      if (event.cancelable) event.preventDefault();
    });
  }, [move]);

  const onNativeTouchEnd = useCallback((event: TouchEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const touch = Array.from(event.changedTouches).find((item) => item.identifier === drag.id);
    end(touch?.identifier ?? drag.id);
  }, [end]);

  const setGestureRef = useCallback((element: HTMLElement | null) => {
    removeNativeTouchRef.current?.();
    removeNativeTouchRef.current = null;
    gestureElementRef.current = element;
    if (!element) return;
    element.addEventListener("touchstart", onNativeTouchStart, { capture: true, passive: true });
    element.addEventListener("touchmove", onNativeTouchMove, { capture: true, passive: false });
    element.addEventListener("touchend", onNativeTouchEnd, { capture: true, passive: true });
    element.addEventListener("touchcancel", onNativeTouchEnd, { capture: true, passive: true });
    removeNativeTouchRef.current = () => {
      element.removeEventListener("touchstart", onNativeTouchStart, { capture: true });
      element.removeEventListener("touchmove", onNativeTouchMove, { capture: true });
      element.removeEventListener("touchend", onNativeTouchEnd, { capture: true });
      element.removeEventListener("touchcancel", onNativeTouchEnd, { capture: true });
    };
  }, [onNativeTouchEnd, onNativeTouchMove, onNativeTouchStart]);

  const setSheetRef = useCallback((element: HTMLElement | null) => {
    sheetElementRef.current = element;
    if (!element) return;
    setTransition(false);
    applyOffset(closeDistance(element, axis));
  }, [applyOffset, axis, setTransition]);

  const setBackdropRef = useCallback((element: HTMLElement | null) => {
    backdropElementRef.current = element;
    if (!element) return;
    setTransition(false);
    applyOffset(currentOffsetRef.current);
  }, [applyOffset, setTransition]);

  return {
    backdropRef: setBackdropRef,
    backdropStyle: {
      opacity: `var(${BACKDROP_OPACITY_VAR}, 1)`,
      transition: reduceMotion ? "none" : undefined,
    } as CSSProperties,
    closeWithAnimation: finishClose,
    gestureRef: setGestureRef,
    resetOpen,
    sheetDragHandlers: {
      onPointerDownCapture: onPointerDown,
      onPointerMove,
      onPointerUp: onPointerEnd,
      onPointerCancel: onPointerEnd,
    },
    sheetRef: setSheetRef,
    sheetStyle: {
      transform: sheetTransform(axis),
      transition: reduceMotion ? "none" : undefined,
    } as CSSProperties,
  };
}

function isHardExcluded(target: EventTarget | null) {
  return target instanceof Element && target.closest(DRAG_HARD_EXCLUSION_SELECTOR) != null;
}

function isControl(target: EventTarget | null) {
  return target instanceof Element && target.closest(DRAG_CONTROL_SELECTOR) != null;
}

function closestScrollViewport(target: EventTarget | null) {
  if (!(target instanceof Element)) return null;
  return target.closest(SCROLL_VIEWPORT_SELECTOR) as HTMLElement | null;
}

function dragOffset(drag: DragState, axis: DragAxis) {
  return axis === "x" ? Math.max(0, drag.startX - drag.currentX) : Math.max(0, drag.currentY - drag.startY);
}

function sheetTransform(axis: DragAxis) {
  return axis === "x" ? `translate3d(calc(var(${SHEET_OFFSET_VAR}, 0px) * -1), 0, 0)` : `translate3d(0, var(${SHEET_OFFSET_VAR}, 0px), 0)`;
}

function closeDistance(element: HTMLElement | null, axis: DragAxis) {
  return panelSize(element, axis);
}

function closeThreshold(element: HTMLElement | null, axis: DragAxis) {
  return panelSize(element, axis) / 4;
}

function panelSize(element: HTMLElement | null, axis: DragAxis) {
  const rect = element?.getBoundingClientRect();
  return Math.max(1, axis === "x" ? rect?.width ?? window.innerWidth : rect?.height ?? window.innerHeight);
}

function backdropOpacity(offset: number, size = window.innerHeight) {
  const safeSize = Math.max(1, size);
  const fadeStart = safeSize * BACKDROP_FADE_START_RATIO;
  if (offset <= fadeStart) return 1;
  return Math.max(0, 1 - (offset - fadeStart) / (safeSize - fadeStart));
}

function prefersReducedMotion() {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
