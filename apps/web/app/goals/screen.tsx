"use client";
// ABOUTME: Показывает журнал целей и фокус владельца без изменения данных.
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
 const [query,setQuery] = useState(""), [resourceQuery,setResourceQuery] = useState("");
 const [selectedId,setSelectedId] = useState<string|null>(null), [mobileDetail,setMobileDetail] = useState(false);
 const inFlight = useRef(false);
 const detailPanel = useRef<HTMLElement>(null);
 useEffect(() => {
  if (mobileDetail && window.matchMedia("(max-width: 650px)").matches) detailPanel.current?.focus();
 },[mobileDetail]);
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
 const visibleGoals = data.goals.filter(goal => !goal.deleted && (filter === "archive" ? goal.archived : !goal.archived && (filter === "all" || goal.status === filter)) && `${text(goal.title)} ${text(goal.next_step)} ${text(goal.meaning)}`.toLocaleLowerCase("ru").includes(query.trim().toLocaleLowerCase("ru")));
 const detail = visibleGoals.find(goal => goal.id === selectedId) || visibleGoals.find(goal => goal.id === selected?.id) || visibleGoals[0];
 const entries = data.entries.filter(item => !item.deleted && item.kind === "result").sort((a,b) => text(b.occurred_on).localeCompare(text(a.occurred_on))).slice(0,6);
 const thoughts = data.entries.filter(item => !item.deleted && item.kind === "thought" && item.pinned);
 const now = new Date();
 const today = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-${String(now.getDate()).padStart(2,"0")}`;
 const deadlines = [...data.goals.filter(item => !item.deleted && !item.archived && item.status !== "achieved" && item.status !== "cancelled" && text(item.due_on)).map(item => ({id:text(item.id),title:text(item.title),when:text(item.due_on),kind:"Срок цели"})),...data.resources.filter(item => !item.deleted && text(item.expires_on)).map(item => ({id:text(item.id),title:text(item.title),when:text(item.expires_on),kind:item.kind === "liability" ? "Обязательство: действует до" : "Ресурс: действует до"}))].sort((a,b) => a.when.localeCompare(b.when));
 const upcoming = deadlines.filter(item => item.when >= today).slice(0,5), past = deadlines.filter(item => item.when < today).reverse().slice(0,5);
 const dateList = (rows:typeof deadlines) => rows.map(item => <div className="goals-date" key={item.kind+item.id}><time>{date(item.when)}</time><div><strong>{item.title}</strong><small>{item.kind}</small></div></div>);
 const needsFor = (goalId:unknown) => data.needs.filter(item => !item.deleted && item.goal_id === goalId);
 const historyButton = (entity:Entity,row:Row) => <button type="button" className="goals-quiet" onClick={() => void showHistory(entity,row)}>История</button>;
 const entryList = (rows:Row[]) => rows.length ? <div className="goals-journal">{rows.map(row => <details key={text(row.id)} className="goals-entry"><summary><time>{date(row.occurred_on)}</time><span>{text(row.content)}</span></summary><p>{text(row.content)}</p>{historyButton("entries",row)}</details>)}</div> : <p className="goals-muted">Записей пока нет.</p>;
 const statusLabel = (goal:Row) => states.find(([key]) => key === goal.status)?.[1] || text(goal.status) || "Не указано";
 const resources = data.resources.filter(row => !row.deleted && `${text(row.title)} ${text(row.purpose)}`.toLocaleLowerCase("ru").includes(resourceQuery.trim().toLocaleLowerCase("ru")));
 const resourceGroup = (rows:Row[]) => rows.length ? rows.map(row => {
  const balance = data.resource_balances.find(item => item.id === row.id), unit = text(row.currency) || text(row.unit);
  const kind = row.kind === "liability" ? "Обязательство" : row.category === "borrowed" ? "Доступные заёмные средства" : row.category === "own" ? "Свои средства" : row.kind === "quantity" ? "Запас" : "Инструмент или доступ";
  return <details className="goals-resource" key={text(row.id)}><summary><span><strong>{text(row.title)}</strong><small>{kind}</small></span><span>{text(row.amount) || (row.kind === "qualitative" ? "Без количества" : "Количество неизвестно")} {unit}</span></summary><div className="goals-resource-detail"><p>{row.state === "available" ? "Доступен" : row.state === "unavailable" ? "Недоступен" : "Доступность неизвестна"}{row.expires_on ? ` · Действует до ${date(row.expires_on)}` : ""}</p>{text(row.purpose) && <p>{text(row.purpose)}</p>}{row.kind === "money" || row.kind === "quantity" ? <p>В резерве: {balance?.reserved ?? "неизвестно"} {unit}<br />Доступно: {balance?.available ?? "неизвестно"} {unit}</p> : null}{historyButton("resources",row)}</div></details>;
 }) : <p className="goals-muted">Нет подходящих ресурсов.</p>;
 const secondary = <div className="goals-secondary"><details className="goals-secondary-root"><summary>Ресурсы и записи</summary><div className="goals-secondary-body"><details><summary>Ресурсы и обязательства <span>{data.resources.filter(row => !row.deleted).length}</span></summary><div className="goals-secondary-body"><p>Резерв не является оплатой или списанием.</p><label className="goals-search">Поиск ресурсов<input value={resourceQuery} onChange={event => setResourceQuery(event.target.value)} placeholder="Название или назначение" /></label><h3>Финансы и обязательства</h3>{resourceGroup(resources.filter(row => row.kind === "money" || row.kind === "liability"))}<h3>Вещи, запасы и доступы</h3>{resourceGroup(resources.filter(row => row.kind !== "money" && row.kind !== "liability"))}<details className="goals-more"><summary>Оценка и источники курсов</summary>{data.valuation.length ? data.valuation.map(item => <p key={item.category}>{item.category === "own" ? "Свои средства" : item.category === "borrowed" ? "Доступные заёмные средства" : "Обязательства"}: {item.estimated_total ?? "нет оценки"} {data.base_currency}{item.missing ? ` · неполный итог: нет данных для ${item.missing}` : ""}</p>) : <p>Денежных сумм пока нет.</p>}<p>Оценка не является ценой обмена. Комиссии учитываются отдельно.</p>{data.rates.length ? data.rates.map(rate => <p key={rate.currency}>{rate.currency}: {rate.rate} RUB за {rate.nominal} · {rate.source} · дата {date(rate.effective_date)} · получен {new Date(rate.fetched_at).toLocaleString("ru-RU")}{rate.failed_at ? " · источник недоступен, показан последний курс" : ""}</p>) : <p>Курсов пока нет; исходные суммы сохранены.</p>}</details></div></details><details><summary>Общие записи <span>{data.entries.filter(entry => !entry.deleted && !entry.goal_id).length}</span></summary><div className="goals-secondary-body">{entryList(data.entries.filter(entry => !entry.deleted && !entry.goal_id))}</div></details><details><summary>Удалённые записи</summary><div className="goals-secondary-body">{(["goals","entries","resources","needs","allocations"] as Entity[]).flatMap(entity => (data[entity] as Row[]).filter(row => row.deleted).map(row => <div className="goals-deleted" key={entity + text(row.id)}><p>{entityLabel[entity]}: {label(row,entity === "allocations" ? "выделение" : "без названия")}</p>{historyButton(entity,row)}</div>))}</div></details></div></details></div>;
 return <main className="goals-screen">
  <header className="goals-header"><div><h1>{mode === "focus" ? "Фокус" : "Все цели"}</h1><p>{mode === "focus" ? "Главное сейчас" : "Ваш журнал целей"}</p></div><nav className="goals-view-nav" aria-label="Страницы целей"><WorkspaceLink href="/focus" aria-current={mode === "focus" ? "page" : undefined}>Фокус</WorkspaceLink><WorkspaceLink href="/goals" aria-current={mode === "goals" ? "page" : undefined}>Все цели</WorkspaceLink></nav></header>
  {error && <p role="status" className="goals-message">{error} Показаны последние полученные данные.</p>}
  {notice && <p role="status" className="goals-message">{notice}</p>}
  {mode === "focus" ? <>
   <div className="goals-focus-layout"><section className="goals-mission"><div className="goals-mission-top"><span>Текущая цель</span>{data.focus && historyButton("focus",data.focus)}</div>{selected ? <><h2>{text(selected.title)}</h2><p className="goals-mission-reason">{text(data.focus?.reason) || text(selected.meaning) || "Причина пока не указана."}</p><div className="goals-next"><div><span>Следующий шаг</span><p>{text(selected.next_step) || "Пока не указан"}</p></div><div><span>Исполнитель</span><p>{text(selected.executor) || "Не указан"}</p></div></div><div className="goals-mission-foot"><span>{statusLabel(selected)}</span><span>{selected.due_on ? `Срок цели: ${date(selected.due_on)}` : "Срок цели не указан"}</span></div><details className="goals-more"><summary>Ресурсы для цели</summary><NeedTable needs={needsFor(selected.id)} data={data} onHistory={showHistory} /></details></> : <><h2>Фокус пока не выбран</h2><p>Выбрать главную цель можно в разговоре с компаньоном.</p></>}</section><aside className="goals-deadlines"><h2>Ближайшие даты</h2>{upcoming.length ? dateList(upcoming) : <p className="goals-muted">Предстоящие даты не указаны.</p>}{past.length > 0 && <details className="goals-more"><summary>Прошедшие даты</summary><p className="goals-muted">Истечение срока не подтверждает выполнение или оплату.</p>{dateList(past)}</details>}</aside></div>
   <section className="goals-results"><div className="goals-section-heading"><div><h2>Последние результаты</h2><p>Что уже произошло</p></div></div>{entryList(entries)}<details className="goals-more"><summary>Закреплённые мысли <span>{thoughts.length}</span></summary>{entryList(thoughts)}</details></section>{secondary}
  </> : <>
   <div className="goals-toolbar"><label className="goals-search">Поиск целей<input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Название, смысл или шаг" /></label><label>Состояние<select value={filter} onChange={event => setFilter(event.target.value)}><option value="all">Все неархивные</option>{states.map(([value,title]) => <option key={value} value={value}>{title}</option>)}<option value="archive">Архив</option></select></label></div>
   {secondary}
   <div className={`goals-browser${mobileDetail ? " goals-browser-detail" : ""}`}><section className="goals-list" aria-label="Список целей"><div className="goals-list-heading"><h2>Цели</h2><span>{visibleGoals.length}</span></div>{visibleGoals.length ? visibleGoals.map(goal => <button type="button" className={`goals-row${detail?.id === goal.id ? " is-selected" : ""}`} key={text(goal.id)} onClick={() => {setSelectedId(text(goal.id));setMobileDetail(true);requestAnimationFrame(() => detailPanel.current?.focus());}} aria-pressed={detail?.id === goal.id}><span className="goals-row-main"><strong>{text(goal.title)}</strong><span>{text(goal.next_step) || "Следующий шаг не указан"}</span><small>{selected?.id === goal.id ? "В фокусе · " : ""}{statusLabel(goal)}</small></span><span className="goals-row-date">{goal.due_on ? date(goal.due_on) : ""}</span></button>) : <p className="goals-empty">Подходящих целей пока нет.</p>}</section><section className="goals-detail-panel" aria-label="Подробности цели" ref={detailPanel} tabIndex={-1}><button type="button" className="goals-back" onClick={() => {setMobileDetail(false);requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(".goals-row[aria-pressed=true]")?.focus());}}>← Все цели</button>{detail ? <><div className="goals-detail-meta"><span>{selected?.id === detail.id ? "В фокусе" : statusLabel(detail)}</span>{historyButton("goals",detail)}</div><h2>{text(detail.title)}</h2>{selected?.id === detail.id && <p className="goals-muted">{statusLabel(detail)}</p>}<div className="goals-detail-section"><h3>Зачем</h3><p>{text(detail.meaning) || "Пока не указано."}</p></div><div className="goals-detail-section goals-detail-next"><h3>Следующий шаг</h3><p>{text(detail.next_step) || "Пока не указан."}</p><dl><div><dt>Исполнитель</dt><dd>{text(detail.executor) || "Не указан"}</dd></div><div><dt>Срок цели</dt><dd>{date(detail.due_on)}</dd></div></dl></div><div className="goals-detail-section"><h3>Результат достижения</h3><p>{text(detail.achievement) || "Пока не указан."}</p></div><div className="goals-detail-section"><h3>Ресурсы для цели</h3><NeedTable needs={needsFor(detail.id)} data={data} onHistory={showHistory} /></div><div className="goals-detail-section"><h3>Связанные записи</h3>{entryList(data.entries.filter(entry => !entry.deleted && entry.goal_id === detail.id))}</div></> : <p className="goals-muted">Выберите цель, чтобы увидеть подробности.</p>}</section></div>
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
