"use client";
// ABOUTME: Сохраняет исходные пороги горизонтального перехода и жеста левого края.
// ABOUTME: Ограничивает навигацию тремя Brai-маршрутами без старых разделов приложения.

import type { CSSProperties, TouchEvent } from "react";
import { useEffect, useRef, useState } from "react";
type SectionId = "agent" | "timer" | "do";

type SectionSwipeStart = { identifier: number; x: number; y: number; lastX: number; lastTime: number; width: number; axis?: "horizontal" | "vertical"; };
type LeftEdgeMenuSwipeStart = { identifier: number; x: number; y: number; axis?: "horizontal" | "vertical"; };
type SectionSwipeVisual = { phase: "dragging" | "settling"; from: SectionId; to: SectionId | null; deltaX: number; width: number; };
const SECTION_SWIPE_MIN_DISTANCE = 72;
const SECTION_SWIPE_MAX_VERTICAL_DRIFT = 58;
const SECTION_SWIPE_VERTICAL_RATIO = 0.72;
const SECTION_SWIPE_AXIS_LOCK_DISTANCE = 10;
const SECTION_SWIPE_COMMIT_RATIO = 0.24;
const SECTION_SWIPE_FAST_VELOCITY = 0.55;
const SECTION_SWIPE_EDGE_RESISTANCE = 0.28;
const SECTION_SWIPE_SETTLE_MS = 220;
const SECTION_SWIPE_EASING = "cubic-bezier(0.22, 1, 0.36, 1)";
const LEFT_EDGE_MENU_SWIPE_START_PX = 24;
const NAV_SWIPE_EXCLUSION_SELECTOR = "[data-nav-swipe-exclusion], input, textarea, select, button, a, [role='button'], [role='slider']";
const MOBILE_SWIPE_NAV_ITEMS: SectionId[] = ["agent", "timer", "do"];

/**
 * Переключает три маршрута свайпом с порогами эталона Brai-Old.
 */
export function useSectionSwipeNavigation(
  section: SectionId,
  onSection: (section: SectionId) => void,
  enabled: boolean,
) {
  const swipeStartRef = useRef<SectionSwipeStart | null>(null);
  const settleTimerRef = useRef<number | null>(null);
  const [visual, setVisual] = useState<SectionSwipeVisual | null>(null);

  useEffect(() => {
    return () => {
      if (settleTimerRef.current != null) window.clearTimeout(settleTimerRef.current);
    };
  }, []);

  function clearSettleTimer() {
    if (settleTimerRef.current == null) return;
    window.clearTimeout(settleTimerRef.current);
    settleTimerRef.current = null;
  }

  function onTouchStart(event: TouchEvent<HTMLElement>) {
    clearSettleTimer();
    const touch = event.changedTouches[0];
    if (!enabled || !touch || !isMobileNavigationViewport() || isNavSwipeExcludedTarget(event.target, event.currentTarget)) {
      swipeStartRef.current = null;
      setVisual(null);
      return;
    }

    const width = event.currentTarget.hasAttribute("data-nav-swipe-zone")
      ? window.innerWidth || 1
      : event.currentTarget.getBoundingClientRect().width || window.innerWidth || 1;
    swipeStartRef.current = {
      identifier: touch.identifier,
      x: touch.clientX,
      y: touch.clientY,
      lastX: touch.clientX,
      lastTime: event.timeStamp,
      width,
    };
  }

  function onTouchMove(event: TouchEvent<HTMLElement>) {
    const start = swipeStartRef.current;
    if (!start) return;

    const touch = Array.from(event.changedTouches).find((item) => item.identifier === start.identifier);
    if (!touch) return;

    const deltaX = touch.clientX - start.x;
    const deltaY = touch.clientY - start.y;
    const horizontal = Math.abs(deltaX);
    const vertical = Math.abs(deltaY);

    if (!start.axis && (horizontal >= SECTION_SWIPE_AXIS_LOCK_DISTANCE || vertical >= SECTION_SWIPE_AXIS_LOCK_DISTANCE)) {
      if (horizontal > vertical && vertical / horizontal <= SECTION_SWIPE_VERTICAL_RATIO) {
        start.axis = "horizontal";
      } else if (vertical > horizontal) {
        start.axis = "vertical";
        setVisual(null);
        return;
      }
    }

    if (start.axis !== "horizontal") return;
    if (event.cancelable) event.preventDefault();

    start.lastX = touch.clientX;
    start.lastTime = event.timeStamp;
    setVisual({
      phase: "dragging",
      from: section,
      to: adjacentSectionAfterSwipe(section, deltaX),
      deltaX: adjustedSwipeDelta(section, deltaX),
      width: start.width,
    });
  }

  function onTouchEnd(event: TouchEvent<HTMLElement>) {
    const start = swipeStartRef.current;
    if (!start) return;
    swipeStartRef.current = null;

    const touch = Array.from(event.changedTouches).find((item) => item.identifier === start.identifier);
    if (!touch) return;

    const deltaX = touch.clientX - start.x;
    const deltaY = touch.clientY - start.y;
    if (start.axis === "vertical") {
      setVisual(null);
      return;
    }

    const elapsed = Math.max(1, event.timeStamp - start.lastTime);
    const velocityX = (touch.clientX - start.lastX) / elapsed;
    const next = adjacentSectionAfterSwipe(section, deltaX);
    const shouldCommit = next != null && shouldCommitSectionSwipe(deltaX, deltaY, start.width, velocityX);
    settleSwipe(next, shouldCommit, deltaX, start.width);
  }

  function onTouchCancel() {
    swipeStartRef.current = null;
    settleSwipe(visual?.to ?? null, false, 0, visual?.width ?? 1);
  }

  function settleSwipe(to: SectionId | null, shouldCommit: boolean, deltaX: number, width: number) {
    const targetOffset = shouldCommit ? (deltaX < 0 ? -width : width) : 0;
    setVisual({
      phase: "settling",
      from: section,
      to,
      deltaX: targetOffset,
      width,
    });
    clearSettleTimer();
    settleTimerRef.current = window.setTimeout(() => {
      if (shouldCommit && to) onSection(to);
      setVisual(null);
      settleTimerRef.current = null;
    }, SECTION_SWIPE_SETTLE_MS);
  }

  return { handlers: { onTouchStart, onTouchMove, onTouchEnd, onTouchCancel }, visual };
}

/**
 * Открывает левую панель свайпом от левого края вне dock и управляющих элементов.
 */
export function useLeftEdgeMenuSwipe(onOpen: () => void, enabled: boolean) {
  const swipeStartRef = useRef<LeftEdgeMenuSwipeStart | null>(null);

  function onTouchStart(event: TouchEvent<HTMLElement>) {
    const touch = event.changedTouches[0];
    if (
      !enabled ||
      !touch ||
      !isMobileNavigationViewport() ||
      touch.clientX > LEFT_EDGE_MENU_SWIPE_START_PX ||
      isNavSwipeExcludedTarget(event.target, event.currentTarget)
    ) {
      swipeStartRef.current = null;
      return;
    }

    swipeStartRef.current = {
      identifier: touch.identifier,
      x: touch.clientX,
      y: touch.clientY,
    };
  }

  function onTouchMove(event: TouchEvent<HTMLElement>) {
    const start = swipeStartRef.current;
    if (!start) return;

    const touch = Array.from(event.changedTouches).find((item) => item.identifier === start.identifier);
    if (!touch) return;

    const deltaX = touch.clientX - start.x;
    const deltaY = touch.clientY - start.y;
    const horizontal = Math.abs(deltaX);
    const vertical = Math.abs(deltaY);

    if (!start.axis && (horizontal >= SECTION_SWIPE_AXIS_LOCK_DISTANCE || vertical >= SECTION_SWIPE_AXIS_LOCK_DISTANCE)) {
      if (deltaX > 0 && horizontal > vertical && vertical / horizontal <= SECTION_SWIPE_VERTICAL_RATIO) {
        start.axis = "horizontal";
      } else if (vertical > horizontal || deltaX < 0) {
        start.axis = "vertical";
        return;
      }
    }

    if (start.axis === "horizontal" && event.cancelable) event.preventDefault();
  }

  function onTouchEnd(event: TouchEvent<HTMLElement>) {
    const start = swipeStartRef.current;
    if (!start) return;
    swipeStartRef.current = null;

    const touch = Array.from(event.changedTouches).find((item) => item.identifier === start.identifier);
    if (!touch || start.axis === "vertical") return;

    const deltaX = touch.clientX - start.x;
    const deltaY = touch.clientY - start.y;
    if (deltaX >= SECTION_SWIPE_MIN_DISTANCE && isSwipeAxisAllowed(deltaX, deltaY)) onOpen();
  }

  function onTouchCancel() {
    swipeStartRef.current = null;
  }

  return { handlers: { onTouchStart, onTouchMove, onTouchEnd, onTouchCancel } };
}

function isSectionSwipe(deltaX: number, deltaY: number): boolean {
  const horizontal = Math.abs(deltaX);
  const vertical = Math.abs(deltaY);
  return (
    horizontal >= SECTION_SWIPE_MIN_DISTANCE &&
    vertical <= SECTION_SWIPE_MAX_VERTICAL_DRIFT &&
    vertical / horizontal <= SECTION_SWIPE_VERTICAL_RATIO
  );
}

function shouldCommitSectionSwipe(deltaX: number, deltaY: number, width: number, velocityX: number): boolean {
  if (!isSwipeAxisAllowed(deltaX, deltaY)) return false;

  const horizontal = Math.abs(deltaX);
  return (
    isSectionSwipe(deltaX, deltaY) ||
    horizontal / width >= SECTION_SWIPE_COMMIT_RATIO ||
    (horizontal >= SECTION_SWIPE_AXIS_LOCK_DISTANCE && Math.abs(velocityX) >= SECTION_SWIPE_FAST_VELOCITY)
  );
}

function isSwipeAxisAllowed(deltaX: number, deltaY: number): boolean {
  const horizontal = Math.abs(deltaX);
  const vertical = Math.abs(deltaY);
  return (
    horizontal > 0 &&
    vertical <= SECTION_SWIPE_MAX_VERTICAL_DRIFT &&
    vertical / horizontal <= SECTION_SWIPE_VERTICAL_RATIO
  );
}

export function sectionAfterMobileSwipe(section: SectionId, deltaX: number): SectionId {
  const currentIndex = MOBILE_SWIPE_NAV_ITEMS.findIndex((item) => item === section);
  if (currentIndex < 0) return section;

  const direction = deltaX < 0 ? 1 : -1;
  const nextIndex = Math.max(0, Math.min(MOBILE_SWIPE_NAV_ITEMS.length - 1, currentIndex + direction));
  return MOBILE_SWIPE_NAV_ITEMS[nextIndex] ?? section;
}

function adjacentSectionAfterSwipe(section: SectionId, deltaX: number): SectionId | null {
  const next = sectionAfterMobileSwipe(section, deltaX);
  return next === section ? null : next;
}

function adjustedSwipeDelta(section: SectionId, deltaX: number): number {
  return adjacentSectionAfterSwipe(section, deltaX) ? deltaX : deltaX * SECTION_SWIPE_EDGE_RESISTANCE;
}

export function sectionSwipePageStyle(
  visual: SectionSwipeVisual | null,
  page: "current" | "adjacent",
): CSSProperties | undefined {
  if (!visual) return undefined;

  const transition =
    visual.phase === "settling"
      ? `transform ${SECTION_SWIPE_SETTLE_MS}ms ${SECTION_SWIPE_EASING}`
      : "none";
  const offset = page === "current" ? visual.deltaX : adjacentPageOffset(visual);
  return {
    transform: `translate3d(${roundSwipeOffset(offset)}px, 0, 0)`,
    transition,
  };
}

function adjacentPageOffset(visual: SectionSwipeVisual): number {
  if (!visual.to) return 0;
  const fromIndex = MOBILE_SWIPE_NAV_ITEMS.findIndex((item) => item === visual.from);
  const toIndex = MOBILE_SWIPE_NAV_ITEMS.findIndex((item) => item === visual.to);
  const baseOffset = toIndex > fromIndex ? visual.width : -visual.width;
  return baseOffset + visual.deltaX;
}

function roundSwipeOffset(offset: number): number {
  return Math.round(offset * 1000) / 1000;
}

export function isMobileNavigationViewport(): boolean {
  if (typeof window === "undefined") return false;
  if (typeof window.matchMedia === "function") {
    return window.matchMedia("(max-width: 860px)").matches;
  }
  return window.innerWidth <= 860;
}

export function useMobileNavigationViewport(): boolean {
  const [mobile, setMobile] = useState(() => isMobileNavigationViewport());

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(max-width: 860px)");
    const update = (event: MediaQueryListEvent) => setMobile(event.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return mobile;
}

function isNavSwipeExcludedTarget(target: EventTarget | null, currentTarget: EventTarget | null): boolean {
  if (target instanceof Element && currentTarget instanceof Element && currentTarget.hasAttribute("data-nav-swipe-zone") && currentTarget.contains(target)) {
    return false;
  }
  return target instanceof Element && target.closest(NAV_SWIPE_EXCLUSION_SELECTOR) != null;
}
