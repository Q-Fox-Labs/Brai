"use client";
// ABOUTME: Показывает личные часы, одну командную кнопку и историю интервалов.
// ABOUTME: Браузер использует только HTTP/SSE; бизнес-переходы подтверждает владелец таймера.
import { useEffect, useRef, useState } from "react";
import { createClient } from "../lib/client";
import { duration, formatDuration, initialView } from "../lib/model";
import type { TimerEvent, Snapshot } from "../lib/types";
import "./timer.css";

const shortMonthFormatter = new Intl.DateTimeFormat("ru-RU", { month: "short" });
function formatShortDateTime(value: string) {
 const date = new Date(value);
 const day = String(date.getDate()).padStart(2, "0");
 const month = shortMonthFormatter.format(date).replace(/\.$/, "");
 const year = date.getFullYear() === new Date().getFullYear() ? "" : ` ${date.getFullYear()}`;
 const hours = String(date.getHours()).padStart(2, "0");
 const minutes = String(date.getMinutes()).padStart(2, "0");
 return `${day} ${month}${year} ${hours}:${minutes}`;
}
/** Показывает интервалы владельца и передаёт локальный отсчёт в шапку, включая скрытый экран. */
export default function Timer({ userId, onUnauthorized, accountMessage, onElapsed }: { userId: string; onUnauthorized: () => void; accountMessage: string; onElapsed: (elapsed: string | null) => void }) {
 const [view, setView] = useState(initialView);
 const [mono, setMono] = useState(0);
 const client = useRef<ReturnType<typeof createClient> | null>(null);
 useEffect(() => {
  const instance = createClient({ now: () => performance.now(), id: () => crypto.randomUUID(), storage: { getItem: key => sessionStorage.getItem(key), setItem: (key, value) => sessionStorage.setItem(key, value), removeItem: key => sessionStorage.removeItem(key) },
   fetch: async (path, options) => { const response = await fetch(path, options); if (response.status === 401) onUnauthorized(); return response; },
   stream(snapshot, event, lost) {
    const source = new EventSource(`/api/timer/events?expectedUserId=${encodeURIComponent(userId)}`);
    source.addEventListener("snapshot", message => { try { snapshot(JSON.parse((message as MessageEvent).data) as Snapshot); } catch { lost(); } });
    source.addEventListener("change", message => { try { event(JSON.parse((message as MessageEvent).data) as TimerEvent); } catch { lost(); } });
    source.onerror = lost;
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
 const elapsed = duration(view, Math.max(mono, view.anchorMono));
 const elapsedText = formatDuration(elapsed);
 const runningElapsed = view.local ? elapsedText : null;
 useEffect(() => { onElapsed(runningElapsed); }, [runningElapsed, onElapsed]);
 useEffect(() => () => onElapsed(null), [onElapsed]);
 const message = accountMessage || view.message || (view.queued ? `История: ожидают сохранения ${view.queued} действий.` : "");
 return <main className="timer-shell">
  <div className="timer-grid">
   <section aria-label="Таймер" className={`timer-card timer-control${view.local ? " is-running" : ""}`}>
    <output aria-label="Длительность таймера" className="timer-clock">{elapsedText}</output>
    <button type="button" className={`timer-command${view.local ? " is-running" : ""}`} onClick={() => client.current?.command()} aria-label={view.local ? "Остановить таймер" : "Запустить таймер"}>
     {view.local ? "Остановить" : "Начать"}
    </button>
    {message && <p role="status" aria-live="polite" className="timer-message">{message}</p>}
   </section>
   <section aria-labelledby="history-heading" className="timer-card timer-history">
    <header className="timer-history-header"><h1 id="history-heading">История</h1><strong aria-label="Общее сохранённое время">{view.totalCompletedMs === null ? "…" : formatDuration(view.totalCompletedMs)}</strong></header>
    <div className="timer-history-scroll">
     {view.items.length === 0 && <p className="timer-history-empty">{view.totalCompletedMs === null ? "Загружаем историю…" : "Пока нет записей"}</p>}
     <ol aria-label="Интервалы">
      {view.items.map(item => <li key={item.timerId} data-timer-id={item.timerId} className="timer-history-row">
       <time dateTime={item.startedAt} title={`Начало: ${formatShortDateTime(item.startedAt)}; конец: ${formatShortDateTime(item.stoppedAt)}`}>{formatShortDateTime(item.startedAt)}</time>
       <strong>{formatDuration(item.durationMs)}</strong>
      </li>)}
     </ol>
     {view.cursor && <button type="button" className="timer-history-more" disabled={view.loading || !view.connected} onClick={() => { void client.current?.loadHistory(); }}>{view.loading ? "Загрузка…" : "Загрузить ещё"}</button>}
    </div>
   </section>
  </div>
 </main>;
}
