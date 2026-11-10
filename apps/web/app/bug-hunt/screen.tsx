"use client";
// ABOUTME: Показывает собственные наблюдения и ручной разбор проверяющего.
// ABOUTME: Диагностика остаётся текстом; неизвестная мутация повторяется с прежним request_id.
import {useEffect,useRef,useState} from "react";
import {Button} from "@/components/ui/button";
import "./styles.css";
type State="new"|"triaged"|"archived";
type Summary={id:string;title:string;component_id:string;source:string;review_state:State;revision:number;registered_at:string};
type Review={id:string;explanation:string;new_state:State;registered_at:string};
type Detail={case:Summary;report:{id:string;observation:Record<string,unknown>};reviews:{items:Review[];next_cursor:string|null}};
const labels:Record<State,string>={new:"Новое",triaged:"Разобрано",archived:"В архиве"};
const messages:Record<string,string>={FORBIDDEN:"Нет доступа к этому действию.",NOT_FOUND:"Обращение недоступно.",REVISION_CONFLICT:"Карточка уже изменена. Обновите её перед новым решением.",BUSY:"Сервис занят. Попробуйте позже.",RESULT_TOO_LARGE:"Страница слишком велика.",UNAUTHENTICATED:"Войдите заново.",ACCOUNT_CHANGED:"Аккаунт изменился."};
/** Смена аккаунта размонтирует экран и прекращает его запросы. */
export default function BugHuntScreen({userId,onUnauthorized}:{userId:string;onUnauthorized:()=>void}){
 const [rows,setRows]=useState<Summary[]>([]),[cursor,setCursor]=useState<string|null>(null),[detail,setDetail]=useState<Detail|null>(null);
 const [reviewer,setReviewer]=useState(false),[operator,setOperator]=useState(false),[state,setState]=useState(""),[component,setComponent]=useState(""),[source,setSource]=useState(""),[from,setFrom]=useState(""),[to,setTo]=useState("");
 const [loading,setLoading]=useState(true),[error,setError]=useState(""),[busy,setBusy]=useState(false),[explanation,setExplanation]=useState("");
 const [pending,setPending]=useState<Record<string,unknown>|null>(null);
 const controller=useRef<AbortController|null>(null),generation=useRef(0),cardGeneration=useRef(0);
 const api=async(operation:string,input:unknown={})=>{
  const response=await fetch("/api/bug-hunt?operation="+operation,{method:"POST",headers:{"content-type":"application/json","x-brai-user":userId},body:JSON.stringify(input),cache:"no-store",signal:controller.current?.signal});
  const value=await response.json();
  if(!response.ok){if(response.status===401)onUnauthorized();throw Object.assign(new Error(messages[value.code]??"Не удалось получить ответ сервиса."),{code:value.code,outcome:value.outcome});}
  return value;
 };
 const appliedFilters=useRef<Record<string,string>>({});
 const invalidExplanation=!explanation.trim()||[...explanation].length>4000;
 const load=async(more=false)=>{
  const version=++generation.current;setLoading(true);setError("");
  try{
   const filters={...(state?{review_state:state}:{}),...(component?{component_id:component}:{}),...(source?{source}:{}),...(from?{registered_from:new Date(from).toISOString()}:{}),...(to?{registered_to:new Date(to).toISOString()}:{})};
   const selected=more?appliedFilters.current:filters;
   const value=await api(operator?"operator-list":"list",{filters:selected,limit:20,...(more&&cursor?{cursor}:{})});
   if(version===generation.current){if(!more)appliedFilters.current=filters;setRows(old=>more?[...old,...value.items]:value.items);setCursor(value.next_cursor);}
  }catch(e){if(version===generation.current)setError((e as Error).message);}finally{if(version===generation.current)setLoading(false);}
 };
 const open=async(id:string,more=false)=>{
  const version=++cardGeneration.current;setBusy(true);setError("");
  try{const value=await api("get",{case_id:id,limit:10,...(more&&detail?.reviews.next_cursor?{cursor:detail.reviews.next_cursor}:{})});
   if(version===cardGeneration.current)setDetail(old=>more&&old?{...value,reviews:{...value.reviews,items:[...old.reviews.items,...value.reviews.items]}}:value);
  }catch(e){if(version===cardGeneration.current)setError((e as Error).message);}finally{if(version===cardGeneration.current)setBusy(false);}
 };
 useEffect(()=>{
  controller.current=new AbortController();
  void api("capabilities").then(value=>setReviewer(value.reviewer)).catch(e=>{if(!controller.current?.signal.aborted)setError(e.message);});
  return()=>{controller.current?.abort();generation.current++;cardGeneration.current++;};
 },[userId]);
 useEffect(()=>{setRows([]);setCursor(null);setDetail(null);setPending(null);void load();},[operator,userId]);
 const review=async(target:State,retry=false)=>{
  if(!detail)return;
  const input=retry?pending:{request_id:crypto.randomUUID(),case_id:detail.case.id,expected_revision:detail.case.revision,review_state:target,explanation};
  if(!input)return;
  setBusy(true);setError("");setPending(input);
  try{await api("review",input);setPending(null);setExplanation("");await open(detail.case.id);await load();}
  catch(e){const failure=e as Error&{outcome?:string};if(failure.outcome==="not_accepted")setPending(null);setError(failure.message+(failure.outcome==="unknown"?" Результат неизвестен. Повторите прежнее решение для сверки.":""));}
  finally{setBusy(false);}
 };
 const fields=[["operation","Действие"],["expected","Ожидалось"],["observed","Произошло"],["steps","Условия"],["component_version","Версия компонента"],["commit_sha","Коммит"],["deployment_revision","Версия установки"],["error_code","Код ошибки"],["diagnostic_text","Диагностика"]];
 return <main className="bug-hunt">
  <header className="bug-hunt-heading"><div><h1>Наблюдения о сбоях</h1><p>Сообщения агентов. Каждое наблюдение пока не проверено.</p></div>{reviewer&&<label><input type="checkbox" checked={operator} disabled={busy||!!pending} onChange={e=>setOperator(e.target.checked)}/> Все пользователи</label>}</header>
  <form className="bug-hunt-filters" onSubmit={e=>{e.preventDefault();void load();}}>
   <label>Состояние<select value={state} onChange={e=>setState(e.target.value)}><option value="">Все</option>{Object.entries(labels).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
   <label>Компонент<input maxLength={128} value={component} onChange={e=>setComponent(e.target.value)} placeholder="Все компоненты"/></label>
   <label>Источник<select value={source} onChange={e=>setSource(e.target.value)}><option value="">Все</option>{["codex","hermes","web"].map(s=><option key={s} value={s}>{s}</option>)}</select></label>
   <label>С даты<input type="datetime-local" value={from} onChange={e=>setFrom(e.target.value)}/></label><label>По дату<input type="datetime-local" value={to} onChange={e=>setTo(e.target.value)}/></label>
   <Button variant="outline" disabled={loading}>Применить</Button>
  </form>
  {error&&<p role="alert" className="bug-hunt-error">{error}</p>}
  <div className="bug-hunt-columns"><section aria-label="Список обращений" aria-busy={loading}>
   {loading&&<p role="status">Загрузка…</p>}{!loading&&!rows.length&&!error&&<p className="bug-hunt-empty">Обращений пока нет.</p>}
   <ul className="bug-hunt-list">{rows.map(row=><li key={row.id}><button disabled={busy||!!pending} type="button" aria-current={detail?.case.id===row.id?"true":undefined} onClick={()=>{setExplanation("");void open(row.id);}}><strong>{row.title}</strong><span>{row.component_id} · {row.source} · {labels[row.review_state]}</span><time dateTime={row.registered_at}>{new Date(row.registered_at).toLocaleString("ru-RU")}</time></button></li>)}</ul>
   {cursor&&<Button variant="outline" disabled={loading} onClick={()=>void load(true)}>Ещё обращения</Button>}
  </section>
  <section aria-label="Карточка обращения" aria-busy={busy}>{!detail?<p className="bug-hunt-empty">Выберите обращение в списке.</p>:<>
   <div className="bug-hunt-card-heading"><h2>{detail.case.title}</h2><Button variant="ghost" disabled={busy} onClick={()=>void open(detail.case.id)}>Обновить</Button></div>
   <p>{labels[detail.case.review_state]} · Не проверено · Версия {detail.case.revision}</p>
   <dl>{fields.map(([key,label])=>detail.report.observation[key]?<div key={key}><dt>{label}</dt><dd>{String(detail.report.observation[key])}</dd></div>:null)}</dl>
   {Array.isArray(detail.report.observation.evidence_artifact_ids)&&detail.report.observation.evidence_artifact_ids.length>0&&<div><h3>Доказательства</h3><p>Доступность файлов может измениться.</p><ul>{detail.report.observation.evidence_artifact_ids.map((id:string)=><li key={id}><EvidenceLink caseId={detail.case.id} artifactId={id} userId={userId}/></li>)}</ul></div>}
   <h3>Ручной разбор</h3>{!detail.reviews.items.length&&<p>Решений пока нет.</p>}<ol className="bug-hunt-audit">{detail.reviews.items.map(item=><li key={item.id}><strong>{labels[item.new_state]}</strong> · <time dateTime={item.registered_at}>{new Date(item.registered_at).toLocaleString("ru-RU")}</time><p>{item.explanation}</p></li>)}</ol>
   {detail.reviews.next_cursor&&<Button variant="outline" disabled={busy} onClick={()=>void open(detail.case.id,true)}>Ещё решения</Button>}
   {reviewer&&<div className="bug-hunt-review"><label>Объяснение решения<textarea value={explanation} disabled={busy||!!pending} onChange={e=>setExplanation(e.target.value)}/><span>{[...explanation].length} / 4000 знаков</span></label>
    {pending?<Button disabled={busy} onClick={()=>void review("new",true)}>Повторить прежнее решение</Button>:<div className="bug-hunt-actions">
     {detail.case.review_state==="new"&&<Button disabled={busy||invalidExplanation} onClick={()=>void review("triaged")}>Разобрано</Button>}
     {detail.case.review_state!=="archived"&&<Button variant="outline" disabled={busy||invalidExplanation} onClick={()=>void review("archived")}>В архив</Button>}
     {detail.case.review_state==="archived"&&<Button disabled={busy||invalidExplanation} onClick={()=>void review("new")}>Вернуть в работу</Button>}
    </div>}
   </div>}
  </>}</section></div>
 </main>;
}

/** Проверяет только metadata; байты доказательства загружаются по явному клику владельца. */
function EvidenceLink({caseId,artifactId,userId}:{caseId:string;artifactId:string;userId:string}){
 const [state,setState]=useState<"loading"|"ready"|"unavailable">("loading");
 const url="/api/bug-hunt/evidence?case_id="+encodeURIComponent(caseId)+"&artifact_id="+encodeURIComponent(artifactId)+"&account="+encodeURIComponent(userId);
 useEffect(()=>{
  const controller=new AbortController();setState("loading");
  void fetch(url,{method:"HEAD",cache:"no-store",signal:controller.signal}).then(r=>setState(r.ok?"ready":"unavailable")).catch(()=>{if(!controller.signal.aborted)setState("unavailable");});
  return()=>controller.abort();
 },[url]);
 return state==="ready"?<a href={url} target="_blank" rel="noopener noreferrer">Скачать доказательство</a>:<span>{state==="loading"?"Проверяем доступность…":"Доказательство недоступно этому аккаунту"}</span>;
}
