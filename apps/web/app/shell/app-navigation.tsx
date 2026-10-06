"use client";
// ABOUTME: Показывает desktop rail, dock и мобильные панели оболочки Brai.
// ABOUTME: Поддерживает только действующие маршруты и состояние текущего аккаунта.
import { AlertsBell } from "../alerts/bell";
import Link, { navigateWorkspace } from "./workspace-link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type TouchEvent as ReactTouchEvent } from "react";
import { motion, useMotionValue, useSpring, useTransform, type MotionValue } from "motion/react";
import { ChevronDown, ChevronUp, Ellipsis, SquareTerminal, Timer, X } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { BraiBrandIcon } from "@/components/ui/brai-brand-icon";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { AnimatedThemeToggler } from "@/components/ui/animated-theme-toggler";
import { useThemeMode } from "@/lib/theme";
import { useMobileSheetDrag } from "./use-mobile-sheet-drag";
import { useSoftwareKeyboardOpen } from "./use-software-keyboard-open";
import { sectionSwipePageStyle, useLeftEdgeMenuSwipe, useSectionSwipeNavigation } from "./use-section-swipe-navigation";

type Route = { href: "/" | "/agent" | "/do" | "/alerts"; label: string; icon: "agent" | "timer" | "do" };
type MobilePanel = "profile" | "shortcuts";
const routes: Route[] = [
  { href: "/agent", label: "Агент", icon: "agent" },
  { href: "/", label: "Таймер", icon: "timer" },
  { href: "/do", label: "Дела", icon: "do" },
];
const mobileQuery = "(max-width: 860px)";
const historyMarker = "__braiNavigationPanel";

/** Отображает desktop rail и мобильный dock с независимыми панелями. */
export default function AppNavigation({ email, timerElapsed, onLogout }: {
  email: string;
  timerElapsed: string | null;
  onLogout: () => void;
}) {
  const pathname = usePathname();
  const [panel, setPanel] = useState<MobilePanel | null>(null);
  const [isMobile, setIsMobile] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const isMobileRef = useRef(false);
  const opener = useRef<HTMLElement | null>(null);
  const dock = useRef<HTMLElement>(null);
  const keyboardOpen = useSoftwareKeyboardOpen(isMobile);
  const activeSection = pathname === "/agent" ? "agent" : pathname === "/do" ? "do" : "timer";
  const selectSection = useCallback((section: "agent" | "timer" | "do") => navigateWorkspace(section === "timer" ? "/" : `/${section}`), []);
  const dockSwipe = useSectionSwipeNavigation(activeSection, selectSection, isMobile && panel === null && pathname !== "/alerts");
  const currentSwipeStyle = sectionSwipePageStyle(dockSwipe.visual, "current");
  const openPanel = useCallback((next: MobilePanel, source: HTMLElement) => {
    opener.current = source;
    setPanel(next);
  }, []);
  const closePanel = useCallback(() => {
    setPanel(null);
    if (opener.current?.isConnected && opener.current.getClientRects().length) opener.current.focus();
    else if (!isMobileRef.current) document.querySelector<HTMLElement>(".brai-navigation-rail .brai-profile-trigger")?.focus();
  }, []);
  const edgeOpen = useCallback(() => {
    const active = document.activeElement;
    const source = active instanceof HTMLElement && active !== document.body
      ? active
      : dock.current?.querySelector<HTMLElement>("[aria-current='page']") ?? document.body;
    openPanel("profile", source);
  }, [openPanel]);
  const edgeSwipe = useLeftEdgeMenuSwipe(edgeOpen, isMobile && panel === null);
  const edgeHandlers = useRef(edgeSwipe.handlers);
  edgeHandlers.current = edgeSwipe.handlers;

  useEffect(() => {
    const query = window.matchMedia(mobileQuery);
    const update = () => { isMobileRef.current = query.matches; setIsMobile(query.matches); };
    update(); query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (!isMobile) return;
    const root = document.querySelector<HTMLElement>(".brai-workspace-shell");
    if (!root) return;
    const onStart = (event: TouchEvent) => edgeHandlers.current.onTouchStart(event as unknown as ReactTouchEvent<HTMLElement>);
    const onMove = (event: TouchEvent) => edgeHandlers.current.onTouchMove(event as unknown as ReactTouchEvent<HTMLElement>);
    const onEnd = (event: TouchEvent) => edgeHandlers.current.onTouchEnd(event as unknown as ReactTouchEvent<HTMLElement>);
    const onCancel = () => edgeHandlers.current.onTouchCancel();
    root.addEventListener("touchstart", onStart, { passive: true });
    root.addEventListener("touchmove", onMove, { passive: false });
    root.addEventListener("touchend", onEnd, { passive: true });
    root.addEventListener("touchcancel", onCancel, { passive: true });
    return () => {
      root.removeEventListener("touchstart", onStart); root.removeEventListener("touchmove", onMove);
      root.removeEventListener("touchend", onEnd); root.removeEventListener("touchcancel", onCancel);
    };
  }, [isMobile]);

  useEffect(() => {
    const content = document.querySelector<HTMLElement>(".brai-workspace-shell .workspace-content");
    if (!content) return;
    const previousTransform = content.style.transform;
    const previousTransition = content.style.transition;
    if (currentSwipeStyle) {
      content.style.transform = currentSwipeStyle.transform ?? "";
      content.style.transition = currentSwipeStyle.transition ?? "";
    }
    return () => {
      content.style.transform = previousTransform;
      content.style.transition = previousTransition;
    };
  }, [currentSwipeStyle]);

  useEffect(() => {
    if (isMobile || !panel) return;
    setPanel(null);
  }, [isMobile, panel]);

  return <>
    <aside className="brai-navigation-rail" aria-label="Навигация Brai">
      <Link className="brai-rail-brand" href="/agent" aria-label="Brai — Агент"><BraiBrandIcon /></Link>
      <nav className="brai-rail-links" aria-label="Разделы Brai">
        {routes.map(route => <RouteLink key={route.href} route={route} current={pathname === route.href} compact timerElapsed={timerElapsed} />)}
      </nav>
      <div className="brai-rail-footer"><AlertsBell /><ThemeButton /><ProfileMenu email={email} onLogout={onLogout} open={profileOpen} setOpen={setProfileOpen} /></div>
    </aside>
    {/* Dock скрыт по запросу; реализация сохранена для возврата.
    <Dock routes={routes} pathname={pathname} timerElapsed={timerElapsed} />
    */}
    <div className="brai-mobile-shell">
      <motion.nav ref={dock} className="brai-mobile-dock" aria-label="Разделы Brai" data-keyboard-open={keyboardOpen || undefined}
        data-nav-swipe-zone
        inert={keyboardOpen || panel !== null || undefined}
        onTouchStart={dockSwipe.handlers.onTouchStart} onTouchMove={dockSwipe.handlers.onTouchMove}
        onTouchEnd={dockSwipe.handlers.onTouchEnd} onTouchCancel={dockSwipe.handlers.onTouchCancel}>
        <button className="brai-mobile-dock-action" type="button" aria-label="Профиль и разделы" aria-expanded={panel === "profile"} onClick={event => openPanel("profile", event.currentTarget)}><Ellipsis /></button>
        {routes.map(route => <MobileDockLink key={route.href} route={route} current={pathname === route.href} timerElapsed={timerElapsed} />)}
        <button className="brai-mobile-dock-action" type="button" aria-label={panel === "shortcuts" ? "Закрыть быстрые настройки" : "Быстрые настройки"} aria-expanded={panel === "shortcuts"}
          onClick={event => panel === "shortcuts" ? setPanel(null) : openPanel("shortcuts", event.currentTarget)}>{panel === "shortcuts" ? <ChevronDown /> : <ChevronUp />}</button>
      </motion.nav>
    </div>
    {panel && <MobilePanel panel={panel} email={email} onClose={closePanel} onLogout={onLogout}
      onNavigate={navigateWorkspace} />}
  </>;
}

function MobilePanel({ panel, email, onClose, onLogout, onNavigate }: {
  panel: MobilePanel; email: string; onClose: () => void; onLogout: () => void;
  onNavigate: (href: Route["href"]) => void;
}) {
  const pathname = usePathname();
  const suppressPop = useRef(false);
  const afterClose = useRef<(() => void) | null>(null);
  const historyBackPending = useRef(false);
  const historyBackDone = useRef(false);
  const animationDone = useRef(false);
  const finalized = useRef(false);
  const opener = useRef<HTMLElement | null>(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const onCloseRef = useRef(onClose);
  const onLogoutRef = useRef(onLogout);
  onCloseRef.current = onClose;
  onLogoutRef.current = onLogout;
  const finishIfReady = useCallback(() => {
    if (!historyBackDone.current || !animationDone.current || finalized.current) return;
    finalized.current = true;
    onCloseRef.current();
    const action = afterClose.current; afterClose.current = null; action?.();
    const source = opener.current;
    if (source?.isConnected) window.requestAnimationFrame(() => { if (source.isConnected) source.focus(); });
  }, []);
  const finishClose = useCallback(() => {
    animationDone.current = true;
    if (history.state?.[historyMarker] === panel && !historyBackPending.current) {
      historyBackPending.current = true; historyBackDone.current = false; history.back();
    } else if (!historyBackPending.current) historyBackDone.current = true;
    finishIfReady();
  }, [finishIfReady, panel]);
  const sheet = useMobileSheetDrag({ axis: panel === "profile" ? "x" : "y", enabled: true, excludeControls: true, onClose: finishClose });
  const closeSheet = useCallback((action?: () => void) => {
    afterClose.current = action ?? null;
    finalized.current = false; animationDone.current = false;
    if (history.state?.[historyMarker] === panel) {
      suppressPop.current = true; historyBackPending.current = true; historyBackDone.current = false; history.back();
    } else { historyBackPending.current = false; historyBackDone.current = true; }
    sheet.closeWithAnimation();
  }, [panel, sheet.closeWithAnimation]);

  useEffect(() => {
    finalized.current = false; historyBackPending.current = false; historyBackDone.current = false; animationDone.current = false;
    sheet.resetOpen();
    const oldState = history.state && typeof history.state === "object" ? history.state : {};
    if (oldState[historyMarker]) history.replaceState({ ...oldState, [historyMarker]: panel }, "", location.href);
    else history.pushState({ ...oldState, [historyMarker]: panel }, "", location.href);
    const content = document.querySelector<HTMLElement>(".brai-workspace-shell .workspace-content");
    const previousInert = content?.inert ?? false;
    if (content) content.inert = true;
    const onPopState = () => {
      if (suppressPop.current) {
        suppressPop.current = false; historyBackPending.current = false; historyBackDone.current = true; finishIfReady(); return;
      }
      if (history.state?.[historyMarker] !== panel) {
        historyBackPending.current = false; historyBackDone.current = true; sheet.closeWithAnimation(); finishIfReady();
      }
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); closeSheet(); return; }
      if (event.key !== "Tab") return;
      const dialog = document.querySelector<HTMLElement>(".brai-mobile-panel, .brai-mobile-shortcut-sheet");
      const focusable = Array.from(dialog?.querySelectorAll<HTMLElement>("a[href],button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex='-1'])") ?? [])
        .filter(item => item.getClientRects().length > 0);
      if (!focusable.length) { event.preventDefault(); return; }
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (!dialog?.contains(document.activeElement)) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    const focusFrame = requestAnimationFrame(() => document.querySelector<HTMLElement>(".brai-mobile-panel, .brai-mobile-shortcut-sheet")?.focus());
    window.addEventListener("popstate", onPopState);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.cancelAnimationFrame(focusFrame); window.removeEventListener("popstate", onPopState);
      document.removeEventListener("keydown", onKeyDown, true);
      if (history.state?.[historyMarker] === panel && !historyBackPending.current) { historyBackPending.current = true; history.back(); }
      if (content) content.inert = previousInert;
    };
  }, [panel, closeSheet, finishIfReady, sheet.closeWithAnimation, sheet.resetOpen]);

  const backdropClass = panel === "profile" ? "brai-mobile-backdrop is-drawer" : "brai-mobile-backdrop is-shortcut-sheet";
  return <div ref={sheet.gestureRef} className="brai-mobile-panel-layer" data-panel={panel} onClick={() => closeSheet()} {...sheet.sheetDragHandlers}>
    <div ref={sheet.backdropRef} className={backdropClass} style={sheet.backdropStyle} aria-hidden="true" />
    {panel === "profile" ? <aside ref={sheet.sheetRef} className="brai-mobile-panel" style={sheet.sheetStyle} role="dialog" aria-modal="true" aria-label="Профиль и разделы" tabIndex={-1}
      onClick={event => event.stopPropagation()}>
      <div className="brai-mobile-panel-grip" aria-hidden="true" />
      <header className="brai-mobile-panel-heading"><span>Brai</span><button type="button" aria-label="Закрыть панель" onClick={() => closeSheet()}><X /></button></header>
      <nav className="brai-mobile-panel-routes" aria-label="Разделы Brai">{routes.map(route => <RouteLink key={route.href} route={route} current={pathname === route.href} mobile
        onNavigate={event => navigateFromPanel(event, route.href, closeSheet, onNavigate)} />)}</nav>
      <div className="brai-mobile-panel-account"><Avatar className="brai-profile-avatar"><AvatarFallback className="bg-primary text-xs font-semibold text-primary-foreground">{email.trim().slice(0, 1).toLocaleUpperCase("ru-RU") || "?"}</AvatarFallback></Avatar><span>{email}</span></div>
      <div className="brai-mobile-panel-actions"><AlertsBell onClick={event => navigateFromPanel(event, "/alerts", closeSheet, onNavigate)} /><ThemeButton /><button className="brai-mobile-logout" type="button" onClick={() => closeSheet(() => onLogoutRef.current())}>Выйти</button></div>
    </aside> : <aside ref={sheet.sheetRef} className="brai-mobile-shortcut-sheet" style={sheet.sheetStyle} role="dialog" aria-modal="true" aria-label="Быстрые настройки" tabIndex={-1}
      onClick={event => event.stopPropagation()}>
      <nav aria-label="Быстрый переход">{routes.map(route => <RouteLink key={route.href} route={route} current={pathname === route.href} mobile
        onNavigate={event => navigateFromPanel(event, route.href, closeSheet, onNavigate)} />)}</nav>
      <AlertsBell onClick={event => navigateFromPanel(event, "/alerts", closeSheet, onNavigate)} /><ThemeButton /><button type="button" aria-label="Закрыть быстрые настройки" onClick={() => closeSheet()}><X /></button>
    </aside>}
  </div>;
}

function navigateFromPanel(event: MouseEvent<HTMLAnchorElement>, href: Route["href"], close: (action?: () => void) => void, navigate: (href: Route["href"]) => void) {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault(); close(() => navigate(href));
}

function ThemeButton() {
  const { theme, onThemeChange } = useThemeMode();
  return <AnimatedThemeToggler className="brai-theme-button" theme={theme} onThemeChange={onThemeChange}
    aria-label={"Переключить тему, сейчас " + (theme === "dark" ? "тёмная" : "светлая")} />;
}

function ProfileMenu({ email, onLogout, open, setOpen }: { email: string; onLogout: () => void; open: boolean; setOpen: (value: boolean) => void }) {
  const initials = email.trim().slice(0, 1).toLocaleUpperCase("ru-RU") || "?";
  useEffect(() => {
    const query = window.matchMedia(mobileQuery);
    const closeForMobile = () => { if (query.matches) setOpen(false); };
    query.addEventListener("change", closeForMobile); closeForMobile();
    return () => query.removeEventListener("change", closeForMobile);
  }, [setOpen]);
  const closeOnEscape = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault(); event.stopPropagation(); setOpen(false);
  };
  return <DropdownMenu open={open} onOpenChange={setOpen}>
    <DropdownMenuTrigger asChild><button className="brai-profile-trigger" type="button" aria-label={"Профиль: " + email}><Avatar className="brai-profile-avatar"><AvatarFallback className="bg-primary text-xs font-semibold text-primary-foreground">{initials}</AvatarFallback></Avatar></button></DropdownMenuTrigger>
    <DropdownMenuContent className="brai-profile-menu" align="end" side="right" onKeyDownCapture={closeOnEscape}>
      <DropdownMenuLabel className="brai-profile-email">{email}</DropdownMenuLabel><DropdownMenuSeparator />
      <DropdownMenuItem className="brai-logout-item" onSelect={onLogout}>Выйти</DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- Dock скрыт по запросу, код сохранён.
function Dock({ routes, pathname, timerElapsed }: { routes: Route[]; pathname: string; timerElapsed: string | null }) {
  const mouseX = useMotionValue(Number.POSITIVE_INFINITY);
  return <motion.nav className="brai-navigation-dock" aria-label="Разделы Brai" onMouseMove={event => mouseX.set(event.pageX)} onMouseLeave={() => mouseX.set(Number.POSITIVE_INFINITY)}>
    {routes.map(route => <DockLink key={route.href} route={route} current={pathname === route.href} timerElapsed={timerElapsed} mouseX={mouseX} />)}
  </motion.nav>;
}

function DockLink({ route, current, timerElapsed, mouseX }: { route: Route; current: boolean; timerElapsed: string | null; mouseX: MotionValue<number> }) {
  const ref = useRef<HTMLSpanElement>(null);
  const distance = useTransform(mouseX, value => { const bounds = ref.current?.getBoundingClientRect() ?? { x: 0, width: 0 }; return value - bounds.x - bounds.width / 2; });
  const width = useSpring(useTransform(distance, [-150, 0, 150], [40, 80, 40]), { mass: 0.1, stiffness: 150, damping: 12 });
  const iconSize = useSpring(useTransform(distance, [-150, 0, 150], [20, 40, 20]), { mass: 0.1, stiffness: 150, damping: 12 });
  const elapsed = dockElapsed(timerElapsed);
  const isTimer = route.icon === "timer";
  return <Link href={route.href} aria-current={current ? "page" : undefined} title={isTimer && timerElapsed ? "Отсчёт " + timerElapsed : route.label}
    aria-label={isTimer && timerElapsed ? "Таймер, идёт отсчёт " + timerElapsed : route.label} className={"brai-dock-link" + (current ? " is-current" : "") + (isTimer && timerElapsed ? " is-running" : "")}>
    <motion.span ref={ref} className="brai-dock-icon" style={{ width, height: width }}>{isTimer && elapsed ? <TimerDockIcon elapsed={elapsed} /> : <motion.span className="brai-dock-glyph" style={{ width: iconSize, height: iconSize }}><RouteIcon name={route.icon} /></motion.span>}</motion.span>
    <span className="brai-dock-label">{route.label}</span>
  </Link>;
}

function MobileDockLink({ route, current, timerElapsed }: { route: Route; current: boolean; timerElapsed: string | null }) {
  const elapsed = dockElapsed(timerElapsed);
  const isTimer = route.icon === "timer";
  return <Link href={route.href} aria-current={current ? "page" : undefined} title={isTimer && timerElapsed ? "Отсчёт " + timerElapsed : route.label}
    aria-label={isTimer && timerElapsed ? "Таймер, идёт отсчёт " + timerElapsed : route.label} className={"brai-mobile-dock-link" + (current ? " is-current" : "")}>
    {isTimer && elapsed ? <span className="brai-mobile-dock-time"><TimerDockIcon elapsed={elapsed} /></span> : <span className={"brai-mobile-dock-icon icon-" + route.icon}><RouteIcon name={route.icon} /></span>}
    <span className="brai-mobile-dock-label">{route.label}</span>
  </Link>;
}

function dockElapsed(timerElapsed: string | null): string | null {
  if (!timerElapsed) return null;
  const [hours, minutes] = timerElapsed.split(":");
  return hours !== undefined && minutes !== undefined ? Number(hours) + ":" + minutes.padStart(2, "0") : null;
}

function TimerDockIcon({ elapsed }: { elapsed: string }) {
  return <svg className="brai-timer-dock-svg" viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="41" fill="none" stroke="currentColor" strokeWidth="5" strokeOpacity=".2" /><g className="brai-timer-dock-ring"><circle cx="50" cy="50" r="41" fill="none" stroke="currentColor" strokeWidth="5" strokeDasharray="34 258" strokeLinecap="round" /></g><text x="50" y="52" dominantBaseline="middle" fontSize={elapsed.length >= 5 ? 23 : elapsed.length >= 4 ? 27 : 30}>{elapsed}</text></svg>;
}

function RouteLink({ route, current, compact = false, mobile = false, timerElapsed = null, onNavigate }: { route: Route; current: boolean; compact?: boolean; mobile?: boolean; timerElapsed?: string | null; onNavigate?: (event: MouseEvent<HTMLAnchorElement>) => void }) {
  const elapsed = route.icon === "timer" ? dockElapsed(timerElapsed) : null;
  return <Link className={"brai-navigation-link" + (compact ? " is-compact" : "") + (mobile ? " is-mobile" : "") + (current ? " is-current" : "")} href={route.href}
    onClick={onNavigate} aria-current={current ? "page" : undefined} aria-label={elapsed ? "Таймер, идёт отсчёт " + timerElapsed : route.label}>
    <span className={"brai-navigation-icon icon-" + route.icon + (elapsed ? " is-running" : "")} aria-hidden="true">{elapsed ? <TimerDockIcon elapsed={elapsed} /> : <RouteIcon name={route.icon} />}</span><span className="brai-navigation-label">{route.label}</span>
  </Link>;
}

function RouteIcon({ name }: { name: Route["icon"] }) {
  if (name === "agent") return <BraiBrandIcon />;
  if (name === "timer") return <Timer aria-hidden="true" />;
  return <SquareTerminal aria-hidden="true" />;
}
