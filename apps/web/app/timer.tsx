"use client";
// ABOUTME: Показывает личные часы, одну командную кнопку и историю интервалов.
// ABOUTME: Браузер использует только HTTP/SSE; бизнес-переходы подтверждает владелец таймера.
import { useEffect, useRef, useState } from "react";
import { createClient } from "../lib/client";
import { duration, formatDuration, initialView } from "../lib/model";
import type { TimerEvent, Snapshot } from "../lib/types";
import TimerFocus, { FocusBackground, useTimerEffectsAvailable, type TimerBackgroundMode } from "./timer-focus";
import TimerHistory from "./timer-history";
import TimerGoals from "./timer-goals";
import WorkspaceFrame from "./shell/workspace-frame";
import "./timer.css";
import { useStartupReady } from "./shell/app-startup-boundary";

/** Показывает интервалы владельца и передаёт локальный отсчёт в шапку, включая скрытый экран. */
export default function Timer({ userId, onUnauthorized, accountMessage, onElapsed }: { userId: string; onUnauthorized: () => void; accountMessage: string; onElapsed: (elapsed: string | null) => void }) {
 const [view, setView] = useState(initialView);
 const [initialSettled, setInitialSettled] = useState(false);
 useStartupReady(initialSettled);
 const [mono, setMono] = useState(0);
 const [background, setBackground] = useState<TimerBackgroundMode>("galaxy");
 const timerViewportRef = useRef<HTMLElement | null>(null);
 const effectsAvailable = useTimerEffectsAvailable(timerViewportRef);
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
 const statistics = view.statistics && view.statistics.version >= view.version ? view.statistics : null;
 const elapsed = duration(view, Math.max(mono, view.anchorMono));
 const elapsedText = formatDuration(elapsed);
 const runningElapsed = view.local ? elapsedText : null;
 useEffect(() => { onElapsed(runningElapsed); }, [runningElapsed, onElapsed]);
 useEffect(() => () => onElapsed(null), [onElapsed]);
 const message = accountMessage || view.message || (view.queued ? `История: ожидают сохранения ${view.queued} действий.` : "");
 return <WorkspaceFrame section="timer" userId={userId} title="Таймер" tabs={[
  { id: "goal", label: "Цели", content: <TimerGoals statistics={statistics} loading={view.statisticsLoading} onRefresh={() => { void client.current?.loadStatistics(); }} /> },
  { id: "history", label: "История", content: <TimerHistory items={view.items} active={view.active} statistics={statistics} totalCompletedMs={view.totalCompletedMs} cursor={view.cursor} loading={view.loading} connected={view.connected} onLoadMore={() => { void client.current?.loadHistory(); }} onEdit={(timerId, startedAt, stoppedAt) => client.current?.editInterval(timerId, startedAt, stoppedAt) ?? null} onDelete={timerId => client.current?.deleteInterval(timerId) ?? null} /> },
 ]} onRightOpen={() => { void client.current?.loadStatistics(); }}>
  <main className="timer-shell" ref={timerViewportRef}>
   <FocusBackground active={!!view.local} mode={background} animated={effectsAvailable} />
   <TimerFocus elapsedMs={elapsed} elapsedText={elapsedText} active={!!view.local} sessionKey={view.local?.timerId ?? null} centered startedAt={view.local?.startedAt ?? null} message={message} background={background} effectsAvailable={effectsAvailable} onBackground={setBackground} onToggle={() => client.current?.command()} />
  </main>
 </WorkspaceFrame>;
}
