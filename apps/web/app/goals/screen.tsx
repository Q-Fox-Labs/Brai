"use client";
// ABOUTME: Показывает фокус, цели и встроенный реестр ресурсов владельца.
// ABOUTME: Обновление обзора не перезаписывает открытый черновик.
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
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
type Field = {key:string;label:string;type?:"text"|"date"|"select"|"textarea"|"checkbox";required?:boolean;options?:[string,string][]};
type Draft = {entity:Entity;id:string;version:string|null;values:Record<string,string|boolean>;uncertain:boolean};
type HistoryRow = {version:string;actor:string;source:string;occurred_at:string;previous:Row|null;current:Row};
const states: [string,string][] = [["discussing","Обсуждаем"],["active","В работе"],["waiting","Ожидает"],["paused","Отложена"],["achieved","Достигнута"],["cancelled","Отменена"]];
const kinds: [string,string][] = [["money","Деньги"],["quantity","Измеримый запас"],["qualitative","Инструмент, доступ или знание"]];
const fields: Record<Entity,Field[]> = {
 goals:[{key:"title",label:"Название",required:true},{key:"meaning",label:"Зачем",type:"textarea",required:true},{key:"achievement",label:"Как пойму, что достигнута",type:"textarea",required:true},{key:"due_on",label:"Срок",type:"date"},{key:"status",label:"Состояние",type:"select",options:states,required:true},{key:"next_step",label:"Следующий шаг",type:"textarea"},{key:"executor",label:"Исполнитель"},{key:"archived",label:"В архиве",type:"checkbox"}],
 focus:[{key:"goal_id",label:"Цель",type:"select"},{key:"reason",label:"Почему она сейчас главная",type:"textarea"}],
 entries:[{key:"goal_id",label:"Связать с целью",type:"select"},{key:"kind",label:"Тип",type:"select",options:[["result","Результат"],["thought","Мысль"]],required:true},{key:"content",label:"Текст",type:"textarea",required:true},{key:"occurred_on",label:"Дата",type:"date",required:true},{key:"pinned",label:"Закрепить",type:"checkbox"}],
 resources:[{key:"title",label:"Название",required:true},{key:"purpose",label:"Назначение",type:"textarea"},{key:"kind",label:"Тип",type:"select",options:[...kinds,["liability","Обязательство"]],required:true},{key:"category",label:"Происхождение",type:"select",options:[["own","Свои средства"],["borrowed","Доступные заёмные средства"],["obligation","Обязательство"]]},{key:"state",label:"Состояние",type:"select",options:[["available","Доступен"],["unavailable","Недоступен"],["unknown","Неизвестно"]],required:true},{key:"amount",label:"Количество или сумма"},{key:"unit",label:"Единица"},{key:"currency",label:"Валюта"},{key:"expires_on",label:"Действует до",type:"date"}],
 needs:[{key:"goal_id",label:"Цель",type:"select",required:true},{key:"title",label:"Что нужно",required:true},{key:"kind",label:"Тип",type:"select",options:kinds,required:true},{key:"amount",label:"Нужно"},{key:"unit",label:"Единица"},{key:"currency",label:"Валюта"},{key:"state",label:"Примечание о доступности"}],
 allocations:[{key:"need_id",label:"Потребность",type:"select",required:true},{key:"resource_id",label:"Ресурс",type:"select",required:true},{key:"amount",label:"Выделить"},{key:"active",label:"Резерв действует",type:"checkbox"}],
};
const operation:Record<Entity,string> = {goals:"goals_goal_put",focus:"goals_focus_put",entries:"goals_entry_put",resources:"goals_resource_put",needs:"goals_need_put",allocations:"goals_allocation_put"};
const entityLabel:Record<Entity,string> = {goals:"цель",focus:"фокус",entries:"запись",resources:"ресурс",needs:"потребность",allocations:"выделение"};
const text = (value:unknown) => typeof value === "string" ? value : "";
const label = (row:Row|undefined, fallback = "Не указано") => row ? text(row.title) || text(row.content) || fallback : fallback;
const date = (value:unknown) => {const s = text(value);return s ? s.slice(0,10).split("-").reverse().join(".") : "Не указан";};
const defaults:Record<Entity,Record<string,string|boolean>> = {
 goals:{status:"discussing",archived:false},focus:{},entries:{kind:"thought",pinned:false},
 resources:{kind:"money",category:"own",state:"unknown",currency:"RUB"},needs:{kind:"money",currency:"RUB"},allocations:{active:true},
};
function visible(entity:Entity, field:string, values:Draft["values"], data:Overview):boolean {
 const kind = text(values.kind);
 if (entity === "resources") {
  if (field === "category") return kind === "money" || kind === "liability";
  if (field === "amount") return kind !== "qualitative";
  if (field === "unit") return kind === "quantity";
  if (field === "currency") return kind === "money" || kind === "liability";
 }
 if (entity === "needs") {
  if (field === "amount") return kind !== "qualitative";
  if (field === "unit") return kind === "quantity";
  if (field === "currency") return kind === "money";
 }
 if (entity === "allocations" && field === "amount") {
  const resource = data.resources.find(item => item.id === values.resource_id);
  return resource?.kind !== "qualitative";
 }
 return true;
}
function draftFor(entity:Entity, row?:Row, preset:Record<string,string|boolean> = {}):Draft {
 const values:Record<string,string|boolean> = {...defaults[entity],...preset};
 if (entity === "entries" && !row && !values.occurred_on) {
  const now = new Date();
  values.occurred_on = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-${String(now.getDate()).padStart(2,"0")}`;
 }
 if (row) for (const field of fields[entity]) values[field.key] = typeof row[field.key] === "boolean" ? row[field.key] as boolean : text(row[field.key]);
 return {entity,id:text(row?.id) || crypto.randomUUID(),version:row ? text(row.version) : null,values,uncertain:false};
}
function payload(draft:Draft, data:Overview):Record<string,string|boolean|null> {
 const out:Record<string,string|boolean|null> = {};
 for (const field of fields[draft.entity]) {
  if (!visible(draft.entity,field.key,draft.values,data)) continue;
  const value = draft.values[field.key];
  if (field.required && (typeof value !== "string" || !value.trim())) throw new Error("Заполните обязательные поля.");
  out[field.key] = typeof value === "boolean" ? value : text(value).trim() || null;
 }
 if (draft.entity === "resources") {
  const kind = out.kind;
  out.category = kind === "liability" ? "obligation" : kind === "money" ? out.category : null;
  if (kind !== "quantity") out.unit = null;
  if (kind !== "money" && kind !== "liability") out.currency = null;
  if (kind === "qualitative") out.amount = null;
 }
 if (draft.entity === "needs") {
  if (out.kind !== "quantity") out.unit = null;
  if (out.kind !== "money") out.currency = null;
  if (out.kind === "qualitative") out.amount = null;
 }
 if (draft.entity === "allocations" && !visible("allocations","amount",draft.values,data)) out.amount = null;
 if (draft.entity === "focus" && !out.goal_id) out.reason = null;
 return out;
}
async function post(operation:string,input:Record<string,unknown>) {
 let response:Response;
 try {
  response = await fetch("/api/goals",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({operation,input})});
 } catch {throw Object.assign(new Error("UNKNOWN_OUTCOME"),{outcome:"unknown"});}
 let body:Record<string,unknown>;
 try {body = await response.json();} catch {throw Object.assign(new Error("UNKNOWN_OUTCOME"),{outcome:"unknown"});}
 if (!body || typeof body !== "object" || Array.isArray(body)) throw Object.assign(new Error("UNKNOWN_OUTCOME"),{outcome:"unknown"});
 if (!response.ok) throw Object.assign(new Error(String(body.code || "UNAVAILABLE")),{status:response.status,outcome:body.outcome});
 return body;
}

/** Отображает текущие сведения и оставляет открытый черновик при обновлении. */
export default function GoalsScreen({mode,active,onUnauthorized}:{mode:"focus"|"goals";active:boolean;onUnauthorized:()=>void}) {
 const [data,setData] = useState<Overview|null>(null), [error,setError] = useState(""), [draft,setDraft] = useState<Draft|null>(null);
 const [saving,setSaving] = useState(false), [notice,setNotice] = useState(""), [filter,setFilter] = useState("all");
 const [history,setHistory] = useState<{entity:Entity;row:Row;items:HistoryRow[]}|null>(null);
 const inFlight = useRef(false);
 useEffect(() => {
  if (!draft && !history) return;
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const dialog = document.querySelector<HTMLElement>(".goals-dialog");
  dialog?.focus();
  const keydown = (event:KeyboardEvent) => {
   if (event.key === "Escape") {event.preventDefault();setDraft(null);setHistory(null);return;}
   if (event.key !== "Tab" || !dialog) return;
   const nodes = Array.from(dialog.querySelectorAll<HTMLElement>("button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href]")).filter(node => node.getClientRects().length > 0);
   if (!nodes.length) {event.preventDefault();return;}
   const first = nodes[0], last = nodes[nodes.length - 1];
   if (!dialog.contains(document.activeElement)) {event.preventDefault();(event.shiftKey ? last : first).focus();}
   else if (event.shiftKey && document.activeElement === first) {event.preventDefault();last.focus();}
   else if (!event.shiftKey && document.activeElement === last) {event.preventDefault();first.focus();}
  };
  document.addEventListener("keydown",keydown,true);
  return () => {document.removeEventListener("keydown",keydown,true);if (opener?.isConnected) opener.focus();};
 },[!!draft,!!history]);
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
 const edit = (entity:Entity,row?:Row,preset?:Record<string,string|boolean>) => {setDraft(draftFor(entity,row,preset));setNotice("");setHistory(null);};
 const save = async (event:FormEvent) => {
  event.preventDefault();if (!draft || !data || saving || draft.uncertain) return;
  let values:ReturnType<typeof payload>;
  try {values = payload(draft,data);} catch (error) {setNotice(error instanceof Error ? error.message : "Проверьте поля.");return;}
  setSaving(true);setNotice("");
  try {
   await post(operation[draft.entity],{id:draft.id,request_id:crypto.randomUUID(),expected_version:draft.version,data:values});
   setDraft(null);await refresh();
  } catch (error) {
   const failure = error as {status?:number;outcome?:string};
   if (failure.outcome === "unknown") {setDraft({...draft,uncertain:true});setNotice("Не удалось узнать результат. Обновите данные и проверьте запись перед новым изменением.");void refresh();}
   else if (failure.status === 409) {setNotice("Запись уже изменилась. Черновик не перезаписан: скопируйте нужное и проверьте актуальную версию.");void refresh();}
   else setNotice("Не удалось сохранить. Проверьте поля и доступность сервиса.");
  } finally {setSaving(false);}
 };
 const showHistory = async (entity:Entity,row:Row) => {
  setNotice("");
  try {const result = await post("goals_history",{entity,id:row.id});setHistory({entity,row,items:result.items as HistoryRow[]});}
  catch {setNotice("Не удалось загрузить историю.");}
 };
 const restore = async (target:string) => {
  if (!history || saving) return;setSaving(true);setNotice("");
  try {
   await post("goals_restore",{entity:history.entity,id:history.row.id,request_id:crypto.randomUUID(),expected_version:history.row.version,target_version:target});
   setHistory(null);await refresh();
  } catch (error) {
   const failure = error as {outcome?:string;status?:number};
   setNotice(failure.outcome === "unknown" ? "Результат восстановления неизвестен. Проверьте историю перед повтором." : failure.status === 409 ? "Запись изменилась. Обновите историю." : "Не удалось восстановить версию.");
   setHistory(null);void refresh();
  } finally {setSaving(false);}
 };
 if (!data) return <main className="goals-screen"><h1>{mode === "focus" ? "Фокус" : "Цели"}</h1><p role="status">{error || "Загружаем сведения…"}</p>{error && <button onClick={() => void refresh()}>Повторить</button>}</main>;
 const selected = data.goals.find(goal => !goal.deleted && goal.id === data.focus?.goal_id);
 const visibleGoals = data.goals.filter(goal => !goal.deleted && (filter === "archive" ? goal.archived : !goal.archived && (filter === "all" || goal.status === filter)));
 const entries = data.entries.filter(item => !item.deleted && item.kind === "result").sort((a,b) => text(b.occurred_on).localeCompare(text(a.occurred_on))).slice(0,6);
 const thoughts = data.entries.filter(item => !item.deleted && item.kind === "thought" && item.pinned);
 const obligations = data.resources.filter(item => !item.deleted && item.kind === "liability").sort((a,b) => text(a.expires_on || "9999").localeCompare(text(b.expires_on || "9999")));
 const needsFor = (goalId:unknown) => data.needs.filter(item => !item.deleted && item.goal_id === goalId);
 const remove = async (entity:Entity,row:Row) => {
  if (saving) return;setSaving(true);setNotice("");
  try {await post("goals_delete",{entity,id:row.id,request_id:crypto.randomUUID(),expected_version:row.version});await refresh();}
  catch (error) {const failure = error as {outcome?:string;status?:number};setNotice(failure.outcome === "unknown" ? "Результат удаления неизвестен. Проверьте состояние и историю перед повтором." : failure.status === 409 ? "Сначала снимите фокус или действующие резервы и проверьте версию." : "Не удалось удалить запись.");void refresh();}
  finally {setSaving(false);}
 };
 const restoreDeleted = async (entity:Entity,row:Row) => {
  if (saving) return;setSaving(true);setNotice("");
  try {
   const history = await post("goals_history",{entity,id:row.id});
   const target = (history.items as HistoryRow[]).find(item => !item.current.deleted)?.version;
   if (!target) throw new Error("VERSION_NOT_FOUND");
   await post("goals_restore",{entity,id:row.id,request_id:crypto.randomUUID(),expected_version:row.version,target_version:target});await refresh();}
  catch (error) {const failure = error as {outcome?:string;status?:number};setNotice(failure.outcome === "unknown" ? "Результат восстановления неизвестен. Проверьте историю перед повтором." : failure.status === 409 ? "Ресурс уже выделен или запись изменилась. Проверьте текущее состояние." : "Не удалось восстановить запись.");void refresh();}
  finally {setSaving(false);}
 };
 const removeButton = (entity:Entity,row:Row) => <button type="button" className="goals-quiet" disabled={saving} onClick={() => void remove(entity,row)}>Удалить</button>;
 const historyButton = (entity:Entity,row:Row) => <button type="button" className="goals-quiet" onClick={() => void showHistory(entity,row)}>История</button>;
 return <main className="goals-screen">
  <header className="goals-header"><div><h1>{mode === "focus" ? "Фокус" : "Цели"}</h1><p>{mode === "focus" ? "Главное сейчас и следующий шаг" : "Цели, реальные результаты и то, что для них нужно"}</p><nav className="goals-view-nav" aria-label="Страницы целей"><WorkspaceLink href="/focus" aria-current={mode === "focus" ? "page" : undefined}>Фокус</WorkspaceLink><WorkspaceLink href="/goals" aria-current={mode === "goals" ? "page" : undefined}>Все цели</WorkspaceLink></nav></div><button type="button" onClick={() => edit("goals")}>Новая цель</button></header>
  {error && <p role="status" className="goals-message">{error} Показаны последние полученные данные.</p>}
  {notice && <p role="status" className="goals-message">{notice}</p>}
  {mode === "focus" ? <>
   <section className="goals-focus"><div className="goals-section-heading"><h2>Главное сейчас</h2><div className="goals-actions"><button type="button" className="goals-quiet" onClick={() => edit("focus",data.focus ?? undefined)}>Изменить фокус</button>{data.focus && historyButton("focus",data.focus)}</div></div>
    {selected ? <><h3>{text(selected.title)}</h3><p>{text(data.focus?.reason)}</p><dl><div><dt>Следующий шаг</dt><dd>{text(selected.next_step) || "Пока не указан"}</dd></div></dl>
      <h4>Чего не хватает</h4><NeedTable needs={needsFor(selected.id)} data={data} onEdit={edit} onHistory={showHistory} onRemove={remove} /></> : <p>Фокус пока не выбран. Выберите цель, когда будете готовы.</p>}
   </section>
   <div className="goals-columns"><section><div className="goals-section-heading"><h2>Ближайшие обязательства</h2></div>{obligations.length ? obligations.map(row => <p key={text(row.id)}><strong>{text(row.title)}</strong> · {text(row.amount) || "Сумма неизвестна"} {text(row.currency)} · {date(row.expires_on)}</p>) : <p>Обязательств пока нет.</p>}</section>
    <section><div className="goals-section-heading"><h2>Последние результаты</h2><button type="button" className="goals-quiet" onClick={() => edit("entries",undefined,{kind:"result"})}>Добавить</button></div>{entries.length ? entries.map(row => <p key={text(row.id)}><time>{date(row.occurred_on)}</time> {text(row.content)} <button type="button" className="goals-quiet" onClick={() => edit("entries",row)}>Изменить</button></p>) : <p>Результатов пока нет.</p>}</section>
    <section><div className="goals-section-heading"><h2>Закреплённые мысли</h2><button type="button" className="goals-quiet" onClick={() => edit("entries",undefined,{kind:"thought",pinned:true})}>Добавить</button></div>{thoughts.length ? thoughts.map(row => <p key={text(row.id)}>{text(row.content)} <button type="button" className="goals-quiet" onClick={() => edit("entries",row)}>Изменить</button></p>) : <p>Закреплённых мыслей пока нет.</p>}</section>
   </div>
  </> : <>
   <div className="goals-toolbar"><label>Показать <select value={filter} onChange={event => setFilter(event.target.value)}><option value="all">Все неархивные</option>{states.map(([value,title]) => <option key={value} value={value}>{title}</option>)}<option value="archive">Архив</option></select></label><button type="button" onClick={() => edit("entries")}>Добавить мысль или результат</button></div>
   {visibleGoals.length ? visibleGoals.map(goal => <details className="goals-item" key={text(goal.id)}><summary><span>{text(goal.title)}</span><small>{states.find(([key]) => key === goal.status)?.[1] || text(goal.status)}</small></summary>
    <div className="goals-detail"><p>{text(goal.meaning)}</p><dl><div><dt>Признак достижения</dt><dd>{text(goal.achievement)}</dd></div><div><dt>Следующий шаг</dt><dd>{text(goal.next_step) || "Не указан"}</dd></div><div><dt>Срок</dt><dd>{date(goal.due_on)}</dd></div><div><dt>Исполнитель</dt><dd>{text(goal.executor) || "Не указан"}</dd></div></dl>
     <div className="goals-actions"><button type="button" onClick={() => edit("goals",goal)}>Изменить</button>{historyButton("goals",goal)}{removeButton("goals",goal)}<button type="button" onClick={() => edit("entries",undefined,{goal_id:text(goal.id)})}>Добавить запись</button><button type="button" onClick={() => edit("needs",undefined,{goal_id:text(goal.id)})}>Добавить потребность</button></div>
     <h3>Потребности</h3><NeedTable needs={needsFor(goal.id)} data={data} onEdit={edit} onHistory={showHistory} onRemove={remove} />
     <h3>Мысли и результаты</h3>{data.entries.filter(entry => !entry.deleted && entry.goal_id === goal.id).map(entry => <p key={text(entry.id)}><time>{date(entry.occurred_on)}</time> {text(entry.content)} <button type="button" className="goals-quiet" onClick={() => edit("entries",entry)}>Изменить</button>{historyButton("entries",entry)}{removeButton("entries",entry)}</p>)}
    </div></details>) : <p>Подходящих целей пока нет.</p>}
   <section className="goals-resources"><div className="goals-section-heading"><div><h2>Общие мысли и результаты</h2><p>Записи, не связанные с отдельной целью.</p></div><button type="button" onClick={() => edit("entries")}>Добавить</button></div>{data.entries.filter(entry => !entry.deleted && !entry.goal_id).map(entry => <p key={text(entry.id)}><time>{date(entry.occurred_on)}</time> {text(entry.content)} <button type="button" className="goals-quiet" onClick={() => edit("entries",entry)}>Изменить</button>{historyButton("entries",entry)}</p>)}</section>
   <section className="goals-resources"><div className="goals-section-heading"><div><h2>Ресурсы и обязательства</h2><p>Резерв не является оплатой или списанием.</p></div><button type="button" onClick={() => edit("resources")}>Добавить</button></div>
    {data.resources.some(row => !row.deleted) ? data.resources.filter(row => !row.deleted).map(row => {
      const balance = data.resource_balances.find(item => item.id === row.id), unit = text(row.currency) || text(row.unit);
      const kind = row.kind === "liability" ? "Обязательство" : row.category === "borrowed" ? "Доступные заёмные средства" : row.category === "own" ? "Свои средства" : row.kind === "quantity" ? "Запас" : "Инструмент или доступ";
      return <div className="goals-resource" key={text(row.id)}><div><strong>{text(row.title)}</strong><p>{kind} · {text(row.purpose) || "Назначение не указано"} · {text(row.amount) || (row.kind === "qualitative" ? "Без количества" : "Количество неизвестно")} {unit} · {row.state === "available" ? "Доступен" : row.state === "unavailable" ? "Недоступен" : "Доступность неизвестна"}</p>{row.kind === "money" || row.kind === "quantity" ? <p>В резерве: {balance?.reserved ?? "неизвестно"} {unit}. Осталось: {balance?.available ?? "неизвестно"} {unit}.</p> : null}</div><div className="goals-actions"><button type="button" onClick={() => edit("resources",row)}>Изменить</button>{historyButton("resources",row)}{removeButton("resources",row)}</div></div>;
    }) : <p>Ресурсов пока нет.</p>}
    <h3>Оценка в {data.base_currency}</h3>{data.valuation.length ? data.valuation.map(item => <p key={item.category}>{item.category === "own" ? "Свои средства" : item.category === "borrowed" ? "Доступные заёмные средства" : "Обязательства"}: {item.estimated_total ?? "нет оценки"} {data.base_currency}{item.missing ? ` · неполный итог: нет данных для ${item.missing}` : ""}</p>) : <p>Денежных сумм пока нет.</p>}
    <p>Оценка не является ценой обмена. Комиссии учитываются отдельно.</p>
    <details><summary>Источники курсов</summary>{data.rates.length ? data.rates.map(rate => <p key={rate.currency}>{rate.currency}: {rate.rate} RUB за {rate.nominal} · {rate.source} · дата {date(rate.effective_date)} · получен {new Date(rate.fetched_at).toLocaleString("ru-RU")}{rate.failed_at ? " · источник недоступен, показан последний курс" : ""}</p>) : <p>Курсов пока нет; исходные суммы сохранены.</p>}</details>
   </section>
   <section className="goals-resources"><details><summary>Удалённые записи</summary>{(["goals","entries","resources","needs","allocations"] as Entity[]).flatMap(entity => (data[entity] as Row[]).filter(row => row.deleted).map(row => <div className="goals-resource" key={entity + text(row.id)}><p>{entityLabel[entity]}: {label(row,entity === "allocations" ? "выделение" : "без названия")}</p><div className="goals-actions"><button type="button" disabled={saving} onClick={() => void restoreDeleted(entity,row)}>Вернуть</button>{historyButton(entity,row)}</div></div>))}</details></section>
  </>}
  {draft && <div className="goals-dialog-layer" role="presentation"><section className="goals-dialog" role="dialog" aria-modal="true" tabIndex={-1} aria-label={`${draft.version ? "Изменить" : "Добавить"} ${entityLabel[draft.entity]}`}>
   <div className="goals-section-heading"><h2>{draft.version ? "Изменить" : "Добавить"} {entityLabel[draft.entity]}</h2><button type="button" className="goals-quiet" onClick={() => setDraft(null)}>Закрыть</button></div>
   {notice && <p role="status" className="goals-message">{notice}</p>}
   <form onSubmit={event => void save(event)}>
    {fields[draft.entity].filter(field => visible(draft.entity,field.key,draft.values,data)).map(field => {
     const value = draft.values[field.key] ?? "";
     let options = field.options;
     if (field.key === "goal_id") options = data.goals.filter(row => !row.archived && !row.deleted).map(row => [text(row.id),text(row.title)]);
     if (field.key === "need_id") options = data.needs.filter(row => !row.deleted).map(row => [text(row.id),text(row.title)]);
     if (field.key === "resource_id") options = data.resources.filter(row => !row.deleted && row.kind !== "liability").map(row => [text(row.id),text(row.title)]);
     const update = (next:string|boolean) => setDraft({...draft,values:{...draft.values,[field.key]:next,...(field.key === "kind" && next === "liability" ? {category:"obligation"} : field.key === "kind" && next === "money" && draft.entity === "resources" ? {category:"own"} : {})}});
     return <label key={field.key} className="goals-field">{field.type === "checkbox" ? <><input type="checkbox" checked={value === true} onChange={event => update(event.target.checked)} />{field.label}</> : <><span>{field.label}{field.required ? " *" : ""}</span>{field.type === "textarea" ? <textarea value={String(value)} onChange={event => update(event.target.value)} required={field.required} /> : field.type === "select" ? <select value={String(value)} onChange={event => update(event.target.value)} required={field.required}><option value="">Не указано</option>{options?.map(([key,title]) => <option key={key} value={key}>{title}</option>)}</select> : <input type={field.type || "text"} value={String(value)} onChange={event => update(event.target.value)} required={field.required} />}</>}</label>;
    })}
    {draft.entity === "focus" && <p>Фокус не меняет состояние цели.</p>}
    {draft.entity === "resources" && <p>Если сумма неизвестна, оставьте поле пустым. Обязательство не становится ресурсом.</p>}
    {draft.entity === "allocations" && <p>Выделение резервирует ресурс, но не списывает его.</p>}
    <div className="goals-actions"><button type="submit" disabled={saving || draft.uncertain}>{saving ? "Сохраняем…" : "Сохранить"}</button><button type="button" className="goals-quiet" onClick={() => setDraft(null)}>Отмена</button></div>
   </form>
  </section></div>}
  {history && <div className="goals-dialog-layer"><section className="goals-dialog" role="dialog" aria-modal="true" tabIndex={-1} aria-label="История изменений"><div className="goals-section-heading"><h2>История изменений</h2><button type="button" className="goals-quiet" onClick={() => setHistory(null)}>Закрыть</button></div>
   {history.items.map(item => <div className="goals-history" key={item.version}><div><strong>Версия {item.version}</strong><p>{new Date(item.occurred_at).toLocaleString("ru-RU")} · {item.actor === "agent" ? "Агент" : "Человек"} · {item.source}</p><dl>{item.previous?.deleted !== item.current.deleted && <div><dt>Запись</dt><dd>{item.current.deleted ? "удалена" : "восстановлена"}</dd></div>}{fields[history.entity].filter(field => item.previous?.[field.key] !== item.current[field.key]).map(field => <div key={field.key}><dt>{field.label}</dt><dd>{historyValue(field,item.previous?.[field.key],data)} → {historyValue(field,item.current[field.key],data)}</dd></div>)}</dl></div><button type="button" disabled={saving || item.version === history.row.version} onClick={() => void restore(item.version)}>Восстановить</button></div>)}
  </section></div>}
 </main>;
}

function historyValue(field:Field, value:unknown, data:Overview):string {
 if (value === null || value === undefined || value === "") return "не указано";
 if (typeof value === "boolean") return value ? "да" : "нет";
 if (field.type === "date") return date(value);
 if (field.key === "goal_id") return label(data.goals.find(row => row.id === value),"цель недоступна");
 if (field.key === "resource_id") return label(data.resources.find(row => row.id === value),"ресурс недоступен");
 if (field.key === "need_id") return label(data.needs.find(row => row.id === value),"потребность недоступна");
 return field.options?.find(([key]) => key === value)?.[1] ?? String(value);
}

function NeedTable({needs,data,onEdit,onHistory,onRemove}:{needs:Row[];data:Overview;onEdit:(entity:Entity,row?:Row,preset?:Record<string,string|boolean>)=>void;onHistory:(entity:Entity,row:Row)=>Promise<void>;onRemove:(entity:Entity,row:Row)=>Promise<void>}) {
 if (!needs.length) return <p>Потребности пока не указаны.</p>;
 return <div className="goals-table-wrap"><table><thead><tr><th>Ресурс</th><th>Нужно</th><th>Выделено</th><th>Не хватает</th><th><span className="goals-sr">Действия</span></th></tr></thead><tbody>{needs.map(need => {
  const balance = data.need_balances.find(item => item.id === need.id), unit = text(need.currency) || text(need.unit);
  const allocations = data.allocations.filter(item => !item.deleted && item.need_id === need.id);
  const active = allocations.filter(item => item.active);
  return <tr key={text(need.id)}><td><strong>{text(need.title)}</strong>{allocations.map(item => <span className="goals-allocation" key={text(item.id)}>{label(data.resources.find(resource => resource.id === item.resource_id))} {text(item.amount)} {item.active ? "" : "(резерв снят)"} <button type="button" className="goals-quiet" onClick={() => onEdit("allocations",item)}>Изменить</button><button type="button" className="goals-quiet" onClick={() => void onHistory("allocations",item)}>История</button><button type="button" className="goals-quiet" onClick={() => void onRemove("allocations",item)}>Удалить</button></span>)}</td><td>{balance?.needed ?? (need.kind === "qualitative" ? "Нужен" : "Неизвестно")} {unit}</td><td>{need.kind === "qualitative" ? active.length ? "Доступен" : "Не выделен" : balance?.allocated ?? "Неизвестно"} {unit}</td><td>{need.kind === "qualitative" ? active.length ? "—" : "Нужен" : balance?.shortage ?? "Неизвестно"} {unit}</td><td><div className="goals-actions"><button type="button" onClick={() => onEdit("needs",need)}>Изменить</button><button type="button" onClick={() => void onHistory("needs",need)}>История</button><button type="button" onClick={() => void onRemove("needs",need)}>Удалить</button><button type="button" onClick={() => onEdit("allocations",undefined,{need_id:text(need.id)})}>Выделить</button></div></td></tr>;
 })}</tbody></table></div>;
}
