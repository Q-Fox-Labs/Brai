"use client";
// ABOUTME: Показывает личные часы, одну командную кнопку и историю интервалов.
// ABOUTME: Браузер использует только HTTP/SSE; бизнес-переходы подтверждает владелец таймера.
import * as Separator from "@radix-ui/react-separator";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { createClient } from "../lib/client";
import { duration, ownerDuration, formatDuration, initialView } from "../lib/model";
import type { TimerEvent, Snapshot } from "../lib/types";
/** Отображает адаптивный таймер; даты используют локальный часовой пояс браузера. */
export default function Timer({ userId, email, onLogout, onUnauthorized, accountMessage }: { userId: string; email: string; onLogout: () => void; onUnauthorized: () => void; accountMessage: string }) {
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
 const date = (value: string) => new Date(value).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
 return <main className="mx-auto min-h-screen max-w-[1600px] px-5 py-8 sm:px-10 lg:px-16 lg:py-12">
  <header className="mb-10 flex items-center justify-between gap-4"><h1 className="text-2xl font-semibold tracking-tight">Brai <span className="font-normal text-slate-500">/ таймер</span></h1>
   <div className="flex flex-wrap items-center justify-end gap-4"><span className="max-w-48 truncate text-sm text-slate-500">{email}</span><Link href="/agent" className="text-sm font-medium text-blue-700 underline-offset-4 hover:underline">Агент</Link><button className="rounded-lg border border-slate-300 px-4 py-2 text-sm" onClick={onLogout}>Выйти</button><p role="status" className="text-right text-sm text-slate-500"><span aria-hidden="true" className={`mr-2 inline-block h-2 w-2 rounded-full ${view.connected ? "bg-emerald-500" : "bg-amber-500"}`} />{view.connected ? "Соединение установлено" : "История: связь восстанавливается…"}</p></div></header>
  {accountMessage && <p role="status" className="mb-6 text-sm text-red-700">{accountMessage}</p>}
  <div className="grid grid-cols-1 gap-12 lg:grid-cols-2 lg:gap-16">
   <section aria-label="Таймер" className="flex flex-col items-center justify-center gap-8 py-8 lg:sticky lg:top-12 lg:h-[65vh]">
    <p className="text-sm uppercase tracking-[0.2em] text-slate-500">{view.local ? "Идёт отсчёт" : "Готов к старту"}</p>
    <output aria-label="Длительность таймера" className="timer-digits font-light tabular-nums tracking-tight">{formatDuration(elapsed)}</output>
    <button className={`command-button ${view.local ? "bg-slate-900" : "bg-blue-600"}`} onClick={() => client.current?.command()}>
     {view.local ? "СТОП" : "СТАРТ"}</button>
    <p role="status" aria-live="polite" className="min-h-12 max-w-sm text-center text-sm leading-6 text-slate-500">{view.message || (view.queued ? `История: ожидают сохранения ${view.queued} действий.` : view.local ? "Отсчёт работает независимо от соединения." : "Начните новый интервал, когда будете готовы.")}</p>
   </section>
   <section aria-labelledby="history-heading" className="min-w-0">
    <div className="mb-5 flex items-baseline justify-between gap-4"><h2 id="history-heading" className="text-xl font-semibold">История</h2><span className="text-xs text-slate-500">Время этого устройства</span></div>
    <Separator.Root className="h-px bg-slate-200" decorative />
    {!view.active && view.items.length === 0 && <p className="py-12 text-center text-slate-500">Ваши интервалы появятся здесь.</p>}
    <ol aria-label="Интервалы" className="divide-y divide-slate-200">
     {view.active && <li data-timer-id={view.active.timerId} className="py-5">
      <div className="mb-3 flex items-center justify-between gap-3"><span className="rounded-full bg-blue-50 px-3 py-1 text-xs font-medium text-blue-700">Активный интервал</span><span className="font-medium tabular-nums">{formatDuration(ownerDuration(view, Math.max(mono, view.anchorMono)))}</span></div>
      <dl className="interval-details"><dt>Начало</dt><dd>{date(view.active.startedAt)}</dd><dt>Конец</dt><dd>Идёт отсчёт</dd></dl></li>}
     {view.items.filter(item => item.timerId !== view.active?.timerId).map(item => <li key={item.timerId} data-timer-id={item.timerId} className="py-5">
      <div className="mb-3 flex justify-between gap-3"><span className="text-sm text-slate-500">Завершён</span><span className="font-medium tabular-nums">{formatDuration(item.durationMs)}</span></div>
      <dl className="interval-details"><dt>Начало</dt><dd>{date(item.startedAt)}</dd><dt>Конец</dt><dd>{date(item.stoppedAt)}</dd></dl></li>)}
    </ol>
    {view.cursor && <button className="history-button" disabled={view.loading || !view.connected} onClick={() => { void client.current?.loadHistory(); }}>{view.loading ? "Загрузка…" : "Загрузить ещё"}</button>}
   </section>
  </div>
 </main>;
}
