"use client";
// ABOUTME: Показывает личные и общие уведомления с явными отметками прочтения.
// ABOUTME: Лента сохраняется в аккаунте; JSON выводится как текст, данные не исполняются.
import { useEffect } from "react";
import { Check, CheckCheck, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { alertKey } from "@/lib/alerts-client";
import { useAlerts } from "./provider";
import "./styles.css";
import { useStartupReady } from "../shell/app-startup-boundary";
/** Подключает ленту после первого посещения; просмотр сам не отмечает уведомления. */
export default function AlertsScreen({ active }: { active: boolean }) {
 const { client, summary, items, nextCursor, loading, loadingMore, reading, error, live } = useAlerts();
 useStartupReady(!active || !!error || !!summary && items !== null);
 useEffect(() => { if (active) client.openFeed(); }, [active, client]);
 return <main className="alerts-screen" aria-label="Уведомления">
  <header className="alerts-heading">
   <div><h1>Уведомления</h1><p>{summary ? `${summary.unread_count} непрочитанных` : "Уточняем число непрочитанных…"}</p></div>
   <div className="alerts-actions">
    <Button variant="ghost" size="icon" aria-label="Обновить уведомления" onClick={client.refresh}><RefreshCw /></Button>
    <Button variant="outline" disabled={!!reading || !summary?.unread_count} onClick={() => { void client.read(); }}><CheckCheck />Прочитать всё</Button>
   </div>
  </header>
  <p className="alerts-status" role="status" aria-live="polite">{error || (!live ? "Соединяемся. Сохранённые уведомления остаются доступны." : "")}</p>
  {loading && items === null && <p role="status" className="alerts-empty">Загружаем уведомления…</p>}
  {items?.length === 0 && <p className="alerts-empty">Уведомлений пока нет</p>}
  <ol className="alerts-list">{items?.map(item => <li key={alertKey(item)}>
   <article className={"alert-record" + (item.read_at ? " is-read" : "")} style={{ borderInlineStartColor: item.category.color }}>
    <div className="alert-meta"><span className="alert-category">{item.category.name}</span><span>{item.service_id}</span>
     {item.scope_type === "system" && <span>Для всех</span>}
     <time dateTime={item.occurred_at}>{new Date(item.occurred_at).toLocaleString("ru-RU", { dateStyle: "medium", timeStyle: "short" })}</time>
    </div>
    <div className="alert-title"><h2>{item.title}</h2>{!item.read_at && <span className="alert-unread" aria-label="Непрочитанное" />}</div>
    {item.text && <p className="alert-text">{item.text}</p>}
    {Object.keys(item.data).length > 0 && <details className="alert-data"><summary>Подробности</summary><pre>{JSON.stringify(item.data, null, 2)}</pre></details>}
    <div className="alert-read-action">{item.read_at ? <span><Check aria-hidden="true" />Прочитано</span> : <Button size="sm" variant="ghost" disabled={!!reading} onClick={() => { void client.read(item); }}><Check />{reading === alertKey(item) ? "Отмечаем…" : "Прочитано"}</Button>}</div>
   </article>
  </li>)}</ol>
  {nextCursor && <div className="alerts-more"><Button variant="outline" disabled={loadingMore || !!reading} onClick={client.loadMore}>{loadingMore ? "Загружаем…" : "Загрузить старые"}</Button></div>}
 </main>;
}
