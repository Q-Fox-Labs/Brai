"use client";
// ABOUTME: Показывает фокус, цели и ресурсы владельца без изменения данных.
// ABOUTME: Читает обновления в активной вкладке и позволяет просматривать историю.
import { useCallback, useEffect, useRef, useState } from "react";
import { useStartupReady } from "../shell/app-startup-boundary";
import WorkspaceLink from "../shell/workspace-link";
import "./goals.css";

type Entity = "goals" | "focus" | "entries" | "resources" | "needs" | "allocations";
type Row = Record<string, string | boolean | null>;
type Balance = {id:string;needed:string|null;allocated:string|null;shortage:string|null;allocations:number};
type ResourceBalance = {id:string;reserved:string|null;available:string|null};
type Rate = {currency:string;rate:string;nominal:string;source:string;effective_date:string;fetched_at:string;failed_at:string|null};
type Valuation = {category:string;estimated_total:string|null;items:number;missing:number};
type Overview = {goals:Row[];focus:Row|null;entries:Row[];resources:Row[];needs:Row[];allocations:Row[];rates:Rate[];need_balances:Balance[];resource_balances:ResourceBalance[];valuation:Valuation[];base_currency:string};
type HistoryRow = {version:string;actor:string;source:string;occurred_at:string;previous:Row|null;current:Row};
const states: [string,string][] = [["discussing","Обсуждаем"],["active","В работе"],["waiting","Ожидает"],["paused","Отложена"],["achieved","Достигнута"],["cancelled","Отменена"]];
const entityLabel:Record<Entity,string> = {goals:"цель",focus:"фокус",entries:"запись",resources:"ресурс",needs:"потребность",allocations:"выделение"};
const fieldLabels:Record<string,string> = {title:"Название",meaning:"Зачем",achievement:"Признак достижения",due_on:"Срок",status:"Состояние",next_step:"Следующий шаг",executor:"Исполнитель",archived:"В архиве",goal_id:"Цель",reason:"Почему сейчас",kind:"Тип",content:"Текст",occurred_on:"Дата",pinned:"Закреплена",purpose:"Назначение",category:"Происхождение",state:"Доступность",amount:"Количество или сумма",unit:"Единица",currency:"Валюта",expires_on:"Действует до",need_id:"Потребность",resource_id:"Ресурс",active:"Резерв действует"};
const text = (value:unknown) => typeof value === "string" ? value : "";
const label = (row:Row|undefined, fallback = "Не указано") => row ? text(row.title) || text(row.content) || fallback : fallback;
const date = (value:unknown) => {const s = text(value);return s ? s.slice(0,10).split("-").reverse().join(".") : "Не указан";};
function historyValue(key:string, value:unknown, data:Overview):string {
 if (value === null || value === undefined || value === "") return "не указано";
 if (typeof value === "boolean") return value ? "да" : "нет";
 if (["due_on","occurred_on","expires_on"].includes(key)) return date(value);
 if (key === "goal_id") return label(data.goals.find(row => row.id === value),"цель недоступна");
 if (key === "resource_id") return label(data.resources.find(row => row.id === value),"ресурс недоступен");
 if (key === "need_id") return label(data.needs.find(row => row.id === value),"потребность недоступна");
 if (key === "status") return states.find(([state]) => state === value)?.[1] ?? String(value);
 return String(value);
}

/** Обновляет обзор чтением и не меняет данные владельца. */
export default function GoalsScreen({mode,active,onUnauthorized}:{mode:"focus"|"goals";active:boolean;onUnauthorized:()=>void}) {
 const [data,setData] = useState<Overview|null>(null), [error,setError] = useState(""), [notice,setNotice] = useState(""), [filter,setFilter] = useState("all");
 const [history,setHistory] = useState<{entity:Entity;items:HistoryRow[]}|null>(null);
 const inFlight = useRef(false);
 useEffect(() => {
  if (!history) return;
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const dialog = document.querySelector<HTMLElement>(".goals-dialog");
  dialog?.focus();
  const keydown = (event:KeyboardEvent) => {
   if (event.key === "Escape") {event.preventDefault();setHistory(null);return;}
   if (event.key !== "Tab" || !dialog) return;
   const nodes = Array.from(dialog.querySelectorAll<HTMLElement>("button:not(:disabled),a[href]")).filter(node => node.getClientRects().length > 0);
   if (!nodes.length) {event.preventDefault();return;}
   const first = nodes[0], last = nodes[nodes.length - 1];
   if (!dialog.contains(document.activeElement)) {event.preventDefault();(event.shiftKey ? last : first).focus();}
   else if (event.shiftKey && document.activeElement === first) {event.preventDefault();last.focus();}
   else if (!event.shiftKey && document.activeElement === last) {event.preventDefault();first.focus();}
  };
  document.addEventListener("keydown",keydown,true);
  return () => {document.removeEventListener("keydown",keydown,true);if (opener?.isConnected) opener.focus();};
 },[!!history]);
 useStartupReady(!active || !!data || !!error);
 const refresh = useCallback(async () => {
  if (inFlight.current) return;
  inFlight.current = true;
  try {
   const response = await fetch("/api/goals",{cache:"no-store"});
   if (response.status === 401) {onUnauthorized();return;}
   if (!response.ok) throw new Error("UNAVAILABLE");
   setData(await response.json() as Overview);setError("");
  } catch {setError("Не удалось обновить сведения. Проверьте соединение.");}
  finally {inFlight.current = false;}
 },[onUnauthorized]);
 useEffect(() => {
  if (!active) return;
  void refresh();
  const timer = setInterval(() => {if (document.visibilityState === "visible") void refresh();},5000);
  const visibleNow = () => {if (document.visibilityState === "visible") void refresh();};
  document.addEventListener("visibilitychange",visibleNow);window.addEventListener("focus",visibleNow);
  return () => {clearInterval(timer);document.removeEventListener("visibilitychange",visibleNow);window.removeEventListener("focus",visibleNow);};
 },[active,refresh]);
 const showHistory = async (entity:Entity,row:Row) => {
  setNotice("");
  try {
   const response = await fetch("/api/goals",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({operation:"goals_history",input:{entity,id:row.id}})});
   if (response.status === 401) {onUnauthorized();return;}
   if (!response.ok) throw new Error("UNAVAILABLE");
   const result = await response.json() as {items:HistoryRow[]};
   setHistory({entity,items:result.items});
  } catch {setNotice("Не удалось загрузить историю.");}
 };
 if (!data) return <main className="goals-screen"><h1>{mode === "focus" ? "Фокус" : "Цели"}</h1><p role="status">{error || "Загружаем сведения…"}</p>{error && <button onClick={() => void refresh()}>Повторить</button>}</main>;
 const selected = data.goals.find(goal => !goal.deleted && goal.id === data.focus?.goal_id);
 const visibleGoals = data.goals.filter(goal => !goal.deleted && (filter === "archive" ? goal.archived : !goal.archived && (filter === "all" || goal.status === filter)));
 const entries = data.entries.filter(item => !item.deleted && item.kind === "result").sort((a,b) => text(b.occurred_on).localeCompare(text(a.occurred_on))).slice(0,6);
 const thoughts = data.entries.filter(item => !item.deleted && item.kind === "thought" && item.pinned);
 const obligations = data.resources.filter(item => !item.deleted && item.kind === "liability").sort((a,b) => text(a.expires_on || "9999").localeCompare(text(b.expires_on || "9999")));
 const needsFor = (goalId:unknown) => data.needs.filter(item => !item.deleted && item.goal_id === goalId);
 const historyButton = (entity:Entity,row:Row) => <button type="button" className="goals-quiet" onClick={() => void showHistory(entity,row)}>История</button>;
 return <main className="goals-screen">
  <header className="goals-header"><div><h1>{mode === "focus" ? "Фокус" : "Цели"}</h1><p>{mode === "focus" ? "Главное сейчас и следующий шаг" : "Цели, результаты и ресурсы"}</p><nav className="goals-view-nav" aria-label="Страницы целей"><WorkspaceLink href="/focus" aria-current={mode === "focus" ? "page" : undefined}>Фокус</WorkspaceLink><WorkspaceLink href="/goals" aria-current={mode === "goals" ? "page" : undefined}>Все цели</WorkspaceLink></nav></div></header>
  {error && <p role="status" className="goals-message">{error} Показаны последние полученные данные.</p>}
  {notice && <p role="status" className="goals-message">{notice}</p>}
  {mode === "focus" ? <>
   <section className="goals-focus"><div className="goals-section-heading"><h2>Главное сейчас</h2>{data.focus && historyButton("focus",data.focus)}</div>
    {selected ? <><h3>{text(selected.title)}</h3>{text(data.focus?.reason) && <p className="goals-focus-reason">{text(data.focus?.reason)}</p>}<dl className="goals-focus-step"><div><dt>Следующий шаг</dt><dd>{text(selected.next_step) || "Пока не указан"}</dd></div><div><dt>Срок</dt><dd>{date(selected.due_on)}</dd></div></dl><h4>Чего не хватает</h4><NeedTable needs={needsFor(selected.id)} data={data} onHistory={showHistory} /></> : <p>Фокус пока не выбран.</p>}
   </section>
   <div className="goals-columns"><section><h2>Ближайшие обязательства</h2>{obligations.length ? obligations.map(row => <p key={text(row.id)}><strong>{text(row.title)}</strong> · {text(row.amount) || "Сумма неизвестна"} {text(row.currency)} · {date(row.expires_on)}</p>) : <p>Обязательств пока нет.</p>}</section>
    <section><h2>Последние результаты</h2>{entries.length ? entries.map(row => <p key={text(row.id)}><time>{date(row.occurred_on)}</time> {text(row.content)}</p>) : <p>Результатов пока нет.</p>}</section>
    <section><h2>Закреплённые мысли</h2>{thoughts.length ? thoughts.map(row => <p key={text(row.id)}>{text(row.content)}</p>) : <p>Закреплённых мыслей пока нет.</p>}</section></div>
  </> : <>
   <div className="goals-toolbar"><label>Показать <select value={filter} onChange={event => setFilter(event.target.value)}><option value="all">Все неархивные</option>{states.map(([value,title]) => <option key={value} value={value}>{title}</option>)}<option value="archive">Архив</option></select></label></div>
   {visibleGoals.length ? visibleGoals.map(goal => <details className="goals-item" key={text(goal.id)}><summary><span className="goals-item-title">{text(goal.title)}{goal.due_on && <small>Срок: {date(goal.due_on)}</small>}</span><small className="goals-item-status">{states.find(([key]) => key === goal.status)?.[1] || text(goal.status)}</small></summary>
    <div className="goals-detail"><p>{text(goal.meaning)}</p><dl><div><dt>Признак достижения</dt><dd>{text(goal.achievement)}</dd></div><div><dt>Следующий шаг</dt><dd>{text(goal.next_step) || "Не указан"}</dd></div><div><dt>Срок</dt><dd>{date(goal.due_on)}</dd></div><div><dt>Исполнитель</dt><dd>{text(goal.executor) || "Не указан"}</dd></div></dl>
     {historyButton("goals",goal)}<h3>Потребности</h3><NeedTable needs={needsFor(goal.id)} data={data} onHistory={showHistory} />
     <h3>Мысли и результаты</h3>{data.entries.filter(entry => !entry.deleted && entry.goal_id === goal.id).map(entry => <p key={text(entry.id)}><time>{date(entry.occurred_on)}</time> {text(entry.content)} {historyButton("entries",entry)}</p>)}
    </div></details>) : <p>Подходящих целей пока нет.</p>}
   <section className="goals-resources"><div className="goals-section-heading"><div><h2>Общие мысли и результаты</h2><p>Записи, не связанные с отдельной целью.</p></div></div>{data.entries.filter(entry => !entry.deleted && !entry.goal_id).map(entry => <p key={text(entry.id)}><time>{date(entry.occurred_on)}</time> {text(entry.content)} {historyButton("entries",entry)}</p>)}</section>
   <section className="goals-resources"><div className="goals-section-heading"><div><h2>Ресурсы и обязательства</h2><p>Резерв не является оплатой или списанием.</p></div></div>
    {data.resources.some(row => !row.deleted) ? data.resources.filter(row => !row.deleted).map(row => {
      const balance = data.resource_balances.find(item => item.id === row.id), unit = text(row.currency) || text(row.unit);
      const kind = row.kind === "liability" ? "Обязательство" : row.category === "borrowed" ? "Доступные заёмные средства" : row.category === "own" ? "Свои средства" : row.kind === "quantity" ? "Запас" : "Инструмент или доступ";
      return <div className="goals-resource" key={text(row.id)}><div className="goals-resource-main"><strong>{text(row.title)}</strong><p>{kind} · {row.state === "available" ? "Доступен" : row.state === "unavailable" ? "Недоступен" : "Доступность неизвестна"}</p>{text(row.purpose) && <p>{text(row.purpose)}</p>}</div><div className="goals-resource-values"><strong>{text(row.amount) || (row.kind === "qualitative" ? "Без количества" : "Количество неизвестно")} {unit}</strong>{row.kind === "money" || row.kind === "quantity" ? <p>В резерве: {balance?.reserved ?? "неизвестно"} {unit}<br />Доступно: {balance?.available ?? "неизвестно"} {unit}</p> : null}</div>{historyButton("resources",row)}</div>;
    }) : <p>Ресурсов пока нет.</p>}
    <h3>Оценка в {data.base_currency}</h3>{data.valuation.length ? data.valuation.map(item => <p key={item.category}>{item.category === "own" ? "Свои средства" : item.category === "borrowed" ? "Доступные заёмные средства" : "Обязательства"}: {item.estimated_total ?? "нет оценки"} {data.base_currency}{item.missing ? ` · неполный итог: нет данных для ${item.missing}` : ""}</p>) : <p>Денежных сумм пока нет.</p>}
    <p>Оценка не является ценой обмена. Комиссии учитываются отдельно.</p><details><summary>Источники курсов</summary>{data.rates.length ? data.rates.map(rate => <p key={rate.currency}>{rate.currency}: {rate.rate} RUB за {rate.nominal} · {rate.source} · дата {date(rate.effective_date)} · получен {new Date(rate.fetched_at).toLocaleString("ru-RU")}{rate.failed_at ? " · источник недоступен, показан последний курс" : ""}</p>) : <p>Курсов пока нет; исходные суммы сохранены.</p>}</details>
   </section>
   <section className="goals-resources"><details><summary>Удалённые записи</summary>{(["goals","entries","resources","needs","allocations"] as Entity[]).flatMap(entity => (data[entity] as Row[]).filter(row => row.deleted).map(row => <div className="goals-resource" key={entity + text(row.id)}><p>{entityLabel[entity]}: {label(row,entity === "allocations" ? "выделение" : "без названия")}</p>{historyButton(entity,row)}</div>))}</details></section>
  </>}
  {history && <div className="goals-dialog-layer"><section className="goals-dialog" role="dialog" aria-modal="true" tabIndex={-1} aria-label="История изменений"><div className="goals-section-heading"><h2>История изменений</h2><button type="button" className="goals-quiet" onClick={() => setHistory(null)}>Закрыть</button></div>
   {history.items.map(item => <div className="goals-history" key={item.version}><div><strong>Версия {item.version}</strong><p>{new Date(item.occurred_at).toLocaleString("ru-RU")} · {item.actor === "agent" ? "Агент" : "Человек"} · {item.source}</p><dl>{item.previous?.deleted !== item.current.deleted && <div><dt>Запись</dt><dd>{item.current.deleted ? "удалена" : "восстановлена"}</dd></div>}{Object.entries(fieldLabels).filter(([key]) => item.previous?.[key] !== item.current[key]).map(([key,title]) => <div key={key}><dt>{title}</dt><dd>{historyValue(key,item.previous?.[key],data)} → {historyValue(key,item.current[key],data)}</dd></div>)}</dl></div></div>)}
  </section></div>}
 </main>;
}

function NeedTable({needs,data,onHistory}:{needs:Row[];data:Overview;onHistory:(entity:Entity,row:Row)=>Promise<void>}) {
 if (!needs.length) return <p>Потребности пока не указаны.</p>;
 return <div className="goals-table-wrap"><table><thead><tr><th>Ресурс</th><th>Нужно</th><th>Выделено</th><th>Не хватает</th><th><span className="goals-sr">История</span></th></tr></thead><tbody>{needs.map(need => {
  const balance = data.need_balances.find(item => item.id === need.id), unit = text(need.currency) || text(need.unit);
  const allocations = data.allocations.filter(item => !item.deleted && item.need_id === need.id);
  const active = allocations.filter(item => item.active);
  return <tr key={text(need.id)}><td><strong>{text(need.title)}</strong>{allocations.map(item => <span className="goals-allocation" key={text(item.id)}>{label(data.resources.find(resource => resource.id === item.resource_id))} {text(item.amount)} {item.active ? "" : "(резерв снят)"} <button type="button" className="goals-quiet" onClick={() => void onHistory("allocations",item)}>История</button></span>)}</td><td>{balance?.needed ?? (need.kind === "qualitative" ? "Нужен" : "Неизвестно")} {unit}</td><td>{need.kind === "qualitative" ? active.length ? "Доступен" : "Не выделен" : balance?.allocated ?? "Неизвестно"} {unit}</td><td>{need.kind === "qualitative" ? active.length ? "—" : "Нужен" : balance?.shortage ?? "Неизвестно"} {unit}</td><td><button type="button" className="goals-quiet" onClick={() => void onHistory("needs",need)}>История</button></td></tr>;
 })}</tbody></table></div>;
}
