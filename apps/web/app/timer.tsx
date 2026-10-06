"use client";
// ABOUTME: Показывает личные часы, одну командную кнопку и историю интервалов.
// ABOUTME: Браузер использует только HTTP/SSE; бизнес-переходы подтверждает владелец таймера.
import { useEffect, useRef, useState } from "react";
import { BookOpen, Crown, Timer as TimerIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { createClient } from "../lib/client";
import { duration, formatDuration, initialView } from "../lib/model";
import type { TimerEvent, Snapshot } from "../lib/types";
import TimerFocus, { FocusBackground, useTimerEffectsAvailable, type TimerBackgroundMode } from "./timer-focus";
import TimerHistory from "./timer-history";
import TimerGoals from "./timer-goals";
import TimerMobileSheet from "./timer-mobile-sheet";
import "./timer.css";
import { useStartupReady } from "./shell/app-startup-boundary";

/** Показывает интервалы владельца и передаёт локальный отсчёт в шапку, включая скрытый экран. */
export default function Timer({ userId, onUnauthorized, accountMessage, onElapsed }: { userId: string; onUnauthorized: () => void; accountMessage: string; onElapsed: (elapsed: string | null) => void }) {
 const [view, setView] = useState(initialView);
 const [initialSettled, setInitialSettled] = useState(false);
 useStartupReady(initialSettled);
 const [mono, setMono] = useState(0);
 const [contextPanel, setContextPanel] = useState<"none" | "history" | "goal">("none");
 const [background, setBackground] = useState<TimerBackgroundMode>("galaxy");
 const [isNarrow, setIsNarrow] = useState(false);
 const timerViewportRef = useRef<HTMLElement | null>(null);
 const effectsAvailable = useTimerEffectsAvailable(timerViewportRef);
 const contextTrigger = useRef<HTMLButtonElement | null>(null);
 const previousContextPanel = useRef(contextPanel);
 const client = useRef<ReturnType<typeof createClient> | null>(null);
 useEffect(() => {
  const instance = createClient({ now: () => performance.now(), id: () => crypto.randomUUID(), storage: { getItem: key => sessionStorage.getItem(key), setItem: (key, value) => sessionStorage.setItem(key, value), removeItem: key => sessionStorage.removeItem(key) },
   fetch: async (path, options) => { const response = await fetch(path, options); if (response.status === 401) onUnauthorized(); return response; },
   stream(snapshot, event, lost) {
    const source = new EventSource(`/api/timer/events?expectedUserId=${encodeURIComponent(userId)}`);
    source.addEventListener("snapshot", message => { try { snapshot(JSON.parse((message as MessageEvent).data) as Snapshot); setInitialSettled(true); } catch { setInitialSettled(true); lost(); } });
    source.addEventListener("change", message => { try { event(JSON.parse((message as MessageEvent).data) as TimerEvent); } catch { lost(); } });
    source.onerror = () => { setInitialSettled(true); lost(); };
    return () => source.close();
   } }, userId);
  client.current = instance;
  const unsubscribe = instance.subscribe(setView); instance.start();
  const tick = setInterval(() => setMono(performance.now()), 200);
  const resume = () => { if (document.visibilityState === "visible") instance.resync(); };
  document.addEventListener("visibilitychange", resume);
  const restored = (event: PageTransitionEvent) => { if (event.persisted) instance.resync(); };
  window.addEventListener("pageshow", restored);
  return () => { unsubscribe(); instance.stop(); clearInterval(tick); document.removeEventListener("visibilitychange", resume); window.removeEventListener("pageshow", restored); };
 }, [userId, onUnauthorized]);
 useEffect(() => {
  const media = window.matchMedia("(max-width: 860px)");
  const update = () => setIsNarrow(media.matches);
  update(); media.addEventListener("change", update);
  return () => media.removeEventListener("change", update);
 }, []);
 useEffect(() => {
  if (previousContextPanel.current !== "none" && contextPanel === "none") requestAnimationFrame(() => contextTrigger.current?.focus());
  previousContextPanel.current = contextPanel;
 }, [contextPanel, isNarrow]);
 const toggleContext = (panel: "history" | "goal", trigger: HTMLButtonElement) => {
  contextTrigger.current = trigger;
  setContextPanel(current => current === panel ? "none" : panel);
  if (contextPanel !== panel) void client.current?.loadStatistics();
 };
 const statistics = view.statistics && view.statistics.version >= view.version ? view.statistics : null;
 const elapsed = duration(view, Math.max(mono, view.anchorMono));
 const elapsedText = formatDuration(elapsed);
 const runningElapsed = view.local ? elapsedText : null;
 useEffect(() => { onElapsed(runningElapsed); }, [runningElapsed, onElapsed]);
 useEffect(() => () => onElapsed(null), [onElapsed]);
 const message = accountMessage || view.message || (view.queued ? `История: ожидают сохранения ${view.queued} действий.` : "");
 return <main className="timer-shell" ref={timerViewportRef}>
  <FocusBackground active={!!view.local} mode={background} animated={effectsAvailable} />
  <div className="timer-workspace">
   <header className="timer-page-header">
    <div className="timer-page-title"><TimerIcon aria-hidden="true" /><span className="timer-title-separator" aria-hidden="true" /><h1>Фокус</h1></div>
    <nav className="timer-workspace-toolbar" aria-label="Панели таймера">
     <Button aria-label="Цели фокусировки" title="Цели фокусировки" aria-expanded={contextPanel === "goal"} aria-pressed={contextPanel === "goal"} className="timer-context-trigger" onClick={event => toggleContext("goal", event.currentTarget)} type="button" variant="outline" size="icon"><Crown aria-hidden="true" /></Button>
     <Button aria-label="История фокуса" title="История фокуса" aria-expanded={contextPanel === "history"} aria-pressed={contextPanel === "history"} className="timer-context-trigger" onClick={event => toggleContext("history", event.currentTarget)} type="button" variant="outline" size="icon"><BookOpen aria-hidden="true" /></Button>
    </nav>
   </header>
   <div className={`timer-context-body${contextPanel === "none" ? "" : " has-panel"}`}>
    <TimerFocus elapsedMs={elapsed} elapsedText={elapsedText} active={!!view.local} sessionKey={view.local?.timerId ?? null} centered={contextPanel === "none"} startedAt={view.local?.startedAt ?? null} message={message} background={background} effectsAvailable={effectsAvailable} onBackground={setBackground} onToggle={() => client.current?.command()} />
    {contextPanel !== "none" ? isNarrow ? <TimerMobileSheet label={contextPanel === "history" ? "История фокуса" : "Цели фокусировки"} onClose={() => setContextPanel("none")}>
     {contextPanel === "history" ? <TimerHistory items={view.items} active={view.active} statistics={statistics} totalCompletedMs={view.totalCompletedMs} cursor={view.cursor} loading={view.loading} connected={view.connected} onLoadMore={() => { void client.current?.loadHistory(); }} onEdit={(timerId, startedAt, stoppedAt) => client.current?.editInterval(timerId, startedAt, stoppedAt) ?? null} onDelete={timerId => client.current?.deleteInterval(timerId) ?? null} /> : <TimerGoals statistics={statistics} loading={view.statisticsLoading} onRefresh={() => { void client.current?.loadStatistics(); }} />}
    </TimerMobileSheet> : <aside aria-label={contextPanel === "history" ? "История фокуса" : "Цели фокусировки"} className="relative z-10 grid h-full min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)] pl-7 max-[860px]:hidden" data-galaxy-interaction-block data-timer-interaction-block>
     <h2 className="mb-3 mt-0 text-xl font-semibold leading-tight">{contextPanel === "history" ? "История фокуса" : "Цели фокусировки"}</h2>
     <ScrollArea className="timer-context-scroll min-h-0">
      {contextPanel === "history" ? <TimerHistory items={view.items} active={view.active} statistics={statistics} totalCompletedMs={view.totalCompletedMs} cursor={view.cursor} loading={view.loading} connected={view.connected} onLoadMore={() => { void client.current?.loadHistory(); }} onEdit={(timerId, startedAt, stoppedAt) => client.current?.editInterval(timerId, startedAt, stoppedAt) ?? null} onDelete={timerId => client.current?.deleteInterval(timerId) ?? null} /> : <TimerGoals statistics={statistics} loading={view.statisticsLoading} onRefresh={() => { void client.current?.loadStatistics(); }} />}
     </ScrollArea>
    </aside> : null}
   </div>
  </div>
 </main>;
}
