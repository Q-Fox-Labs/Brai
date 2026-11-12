"use client";
// ABOUTME: Показывает собственные наблюдения и ручной разбор проверяющего.
// ABOUTME: Диагностика остаётся текстом; неизвестная мутация повторяется с прежним request_id.
import {useEffect,useRef,useState} from "react";
import {Button} from "@/components/ui/button";
import "./styles.css";
import Verification from "./verification";
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
  <header className="bug-hunt-heading"><div><h1>Наблюдения о сбоях</h1><p>Наблюдения, предварительные сведения и отдельные результаты проверки.</p></div>{reviewer&&<label><input type="checkbox" checked={operator} disabled={busy||!!pending} onChange={e=>setOperator(e.target.checked)}/> Все пользователи</label>}</header>
  <Systematization userId={userId} reviewer={reviewer} caseId={detail?.case.id??null} filters={{...(state?{review_state:state}:{}),...(component?{component_id:component}:{}),...(source?{source}:{}),...(from?{registered_from:new Date(from).toISOString()}:{}),...(to?{registered_to:new Date(to).toISOString()}:{})}} onOpen={id=>void open(id)} onUnauthorized={onUnauthorized}/>
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
   <p>{labels[detail.case.review_state]} · Исходная регистрация: не проверено · Версия {detail.case.revision}</p>
   <dl>{fields.map(([key,label])=>detail.report.observation[key]?<div key={key}><dt>{label}</dt><dd>{String(detail.report.observation[key])}</dd></div>:null)}</dl>
   {Array.isArray(detail.report.observation.evidence_artifact_ids)&&detail.report.observation.evidence_artifact_ids.length>0&&<div><h3>Доказательства</h3><p>Доступность файлов может измениться.</p><ul>{detail.report.observation.evidence_artifact_ids.map((id:string)=><li key={id}><EvidenceLink caseId={detail.case.id} artifactId={id} userId={userId}/></li>)}</ul></div>}
   <Verification key={userId+":"+detail.case.id} userId={userId} caseId={detail.case.id} reviewer={reviewer} onUnauthorized={onUnauthorized}/>
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

/** Поиск и систематизация используют текущую учётную запись и сохраняют тело неизвестной мутации. */
function Systematization({userId,reviewer,caseId,filters,onOpen,onUnauthorized}:{userId:string;reviewer:boolean;caseId:string|null;filters:Record<string,string>;onOpen:(id:string)=>void;onUnauthorized:()=>void}){
 type Group={id:string;revision:number;member_count:number;report_count:number;source_count:number};
 type Member={case_id:string;title:string;method:string};
 type GroupEvent={id:string;actor_id:string;operation:string;explanation:string;old_revision:number;new_revision:number;case_ids:string[];registered_at:string};
 type Coverage={state:string;indexed_reports:number;total_reports:number;projection_version:string};
 type Enrichment={local:{state:string;group_id:string|null;excluded_from_auto:boolean;projection_version:string};classification:{payload:Record<string,unknown>;generation:string}|null;override:{labels:Record<string,string>;revision:number;explanation:string}|null;model_state:string;proposals:{id:string;candidate_case_id:string;method:string;score:number;state:string}[];processing?:{branches:{branch:string;state:string;code:string|null;attempt_count:number;coverage:string|null}[];classifications:{id:string;model_id:string;model_revision:string;profile_id:string;question_version:string;projection_version:string;registered_at:string;payload:{requested_model:string;actual_model:string;labels:Record<string,unknown>;coverage:string;excluded_fields:string[];answers:Record<string,unknown>}}[]}};
 const [query,setQuery]=useState(""),[results,setResults]=useState<{case_id:string;title:string;method:string;score:number;snippet:string}[]>([]),[coverage,setCoverage]=useState<Coverage|null>(null);
 const [mode,setMode]=useState<"reports"|"groups">("reports"),[groups,setGroups]=useState<Group[]>([]),[group,setGroup]=useState<Group|null>(null),[members,setMembers]=useState<Member[]>([]),[selected,setSelected]=useState<string[]>([]);
 const [enrichment,setEnrichment]=useState<Enrichment|null>(null),[similar,setSimilar]=useState<{case_id:string;method:string;score:number}[]>([]),[similarCoverage,setSimilarCoverage]=useState<Coverage|null>(null);
 const [explanation,setExplanation]=useState(""),[target,setTarget]=useState(""),[kind,setKind]=useState("unknown"),[impact,setImpact]=useState("unknown"),[error,setError]=useState(""),[busy,setBusy]=useState(false);
 const [caseTarget,setCaseTarget]=useState("");
 const [pending,setPending]=useState<{operation:string;input:Record<string,unknown>}|null>(null);
 const [searchCursor,setSearchCursor]=useState<string|null>(null),[groupsCursor,setGroupsCursor]=useState<string|null>(null),[membersCursor,setMembersCursor]=useState<string|null>(null),[similarCursor,setSimilarCursor]=useState<string|null>(null);
 const [history,setHistory]=useState<GroupEvent[]>([]),[historyCursor,setHistoryCursor]=useState<string|null>(null);
 const searchInput=useRef<{query:string;filters:Record<string,string>}|null>(null),similarCase=useRef<string|null>(null);
 const appendUnique=<T,>(old:T[],next:T[],key:(item:T)=>string)=>{const ids=new Set(old.map(key));return [...old,...next.filter(item=>{const id=key(item);if(ids.has(id))return false;ids.add(id);return true;})];};
 const request=async(operation:string,input:unknown)=>{
  const response=await fetch("/api/bug-hunt?operation="+operation,{method:"POST",headers:{"content-type":"application/json","x-brai-user":userId},body:JSON.stringify(input),cache:"no-store"});
  const value=await response.json();
  if(!response.ok){if(response.status===401)onUnauthorized();throw Object.assign(new Error(messages[value.code]??"Операция пока недоступна."),{outcome:value.outcome,code:value.code});}
  return value;
 };
 const groupVersion=useRef(0),caseVersion=useRef(0),currentCase=useRef(caseId);currentCase.current=caseId;
 const showError=(e:unknown)=>{const failure=e as Error&{code?:string};if(failure.code==="CURSOR_STALE"){setSearchCursor(null);setGroupsCursor(null);setMembersCursor(null);setHistoryCursor(null);setSimilarCursor(null);setError("Данные изменились. Начните поиск или откройте группу заново.");}else setError(failure.message);};
 const loadGroups=async(more=false)=>{const version=++groupVersion.current,scope=caseId;setBusy(true);setError("");try{const value=await request("groups-list",{limit:50,...(scope?{case_id:scope}:{}),...(more&&groupsCursor?{cursor:groupsCursor}:{})});if(version===groupVersion.current&&scope===currentCase.current){setGroups(old=>more?appendUnique(old,value.items,(item:Group)=>item.id):value.items);setGroupsCursor(value.next_cursor);}}catch(e){if(version===groupVersion.current)showError(e);}finally{if(version===groupVersion.current)setBusy(false);}};
 const openGroup=async(id:string,more=false)=>{const scope=caseId;setBusy(true);setError("");try{const value=await request("groups-get",{group_id:id,limit:50,...(more&&membersCursor?{cursor:membersCursor}:{})});if(scope!==currentCase.current)return;setGroup(value.group);setMembers(old=>more?appendUnique(old,value.items,(item:Member)=>item.case_id):value.items);setMembersCursor(value.next_cursor);if(!more){setSelected([]);setHistory(value.history?.items??[]);setHistoryCursor(value.history?.next_cursor??null);}}catch(e){showError(e);}finally{setBusy(false);}};
 const loadHistory=async()=>{if(!group||!historyCursor)return;const scope=caseId;setBusy(true);setError("");try{const value=await request("groups-get",{group_id:group.id,limit:1,history_limit:20,history_cursor:historyCursor});if(scope===currentCase.current){setHistory(old=>appendUnique(old,value.history.items,(item:GroupEvent)=>item.id));setHistoryCursor(value.history.next_cursor);}}catch(e){if(scope===currentCase.current)showError(e);}finally{setBusy(false);}};
 const loadCase=async(id:string)=>{const version=++caseVersion.current;setEnrichment(null);setSimilar([]);setSimilarCursor(null);similarCase.current=null;setSimilarCoverage(null);try{const value=await request("enrichment",{case_id:id});if(version===caseVersion.current)setEnrichment(value);}catch(e){if(version===caseVersion.current)showError(e);}};
 useEffect(()=>{groupVersion.current++;setGroups([]);setGroupsCursor(null);setGroup(null);setMembers([]);setMembersCursor(null);setSelected([]);setTarget("");setCaseTarget("");setHistory([]);setHistoryCursor(null);void loadGroups();if(caseId)void loadCase(caseId);else {caseVersion.current++;setEnrichment(null);}return()=>{groupVersion.current++;caseVersion.current++;};},[caseId,userId]);
 const search=async(more=false)=>{setBusy(true);setError("");if(!more){setResults([]);setCoverage(null);setSearchCursor(null);searchInput.current=null;}try{const selected=more?searchInput.current:{query,filters};if(!selected)return;const value=await request("search",{...selected,limit:50,...(more&&searchCursor?{cursor:searchCursor}:{})});if(!more)searchInput.current=selected;setResults(old=>more?appendUnique(old,value.items,(item:{case_id:string})=>item.case_id):value.items);setSearchCursor(value.next_cursor);setCoverage(value.coverage);}catch(e){showError(e);}finally{setBusy(false);}};
 const findSimilar=async(more=false)=>{const selected=more?similarCase.current:caseId;if(!selected)return;const version=caseVersion.current;setBusy(true);setError("");try{const value=await request("similar",{case_id:selected,limit:50,...(more&&similarCursor?{cursor:similarCursor}:{})});if(version===caseVersion.current){if(!more)similarCase.current=selected;setSimilar(old=>more?appendUnique(old,value.items,(item:{case_id:string})=>item.case_id):value.items);setSimilarCursor(value.next_cursor);setSimilarCoverage(value.coverage);}}catch(e){if(version===caseVersion.current)showError(e);}finally{setBusy(false);}};
 const mutate=async(operation:string,input:Record<string,unknown>)=>{
  setPending({operation,input});setBusy(true);setError("");
  try{await request(operation,input);setPending(null);setExplanation("");if(caseId&&currentCase.current===caseId)await loadCase(caseId);if(currentCase.current===caseId){await loadGroups();if(group)await openGroup(group.id);}}
  catch(e){const failure=e as Error&{outcome?:string};if(failure.outcome==="not_accepted")setPending(null);setError(failure.message+(failure.outcome!=="not_accepted"?" Исход неизвестен. Повторите прежний запрос для сверки.":""));}
  finally{setBusy(false);}
 };
 const revisions=async(ids:(string|null)[])=>{
  const unique=[...new Set(ids.filter((id):id is string=>!!id))].sort();
  return Promise.all(unique.map(async id=>{const value=await request("groups-get",{group_id:id,limit:1});return {group_id:id,revision:value.group.revision};}));
 };
 const move=async()=>{
  if(!group||!selected.length)return;setBusy(true);setError("");
  try{const expected_revisions=await revisions([group.id,target||null]);await mutate("membership-update",{request_id:crypto.randomUUID(),case_ids:selected,target_group_id:target||null,expected_revisions,explanation,exclude_from_auto:true});}catch(e){showError(e);}finally{setBusy(false);}
 };
 const moveCase=async(removeExclusion=false)=>{
  if(!caseId||!enrichment)return;setBusy(true);setError("");
  try{const destination=removeExclusion?enrichment.local.group_id:caseTarget||null;const expected_revisions=await revisions([enrichment.local.group_id,destination]);await mutate("membership-update",{request_id:crypto.randomUUID(),case_ids:[caseId],target_group_id:destination,expected_revisions,explanation,exclude_from_auto:!removeExclusion});}catch(e){showError(e);}finally{setBusy(false);}
 };
 const resolve=async(proposal:Enrichment["proposals"][number],decision:"accepted"|"rejected")=>{
  if(!caseId||!enrichment)return;setBusy(true);setError("");
  try{const expected_revisions=decision==="accepted"?await (async()=>{const candidate=await request("enrichment",{case_id:proposal.candidate_case_id});return revisions([enrichment.local.group_id,candidate.local.group_id]);})():[];await mutate("proposal-resolve",{request_id:crypto.randomUUID(),proposal_id:proposal.id,decision,expected_revisions,explanation});}catch(e){showError(e);}finally{setBusy(false);}
 };
 const allowed=!!explanation.trim()&&[...explanation].length<=4000&&!busy&&!pending;
 const types:Record<string,string>={suspected_defect:"Возможная ошибка",usage:"Использование",configuration:"Настройка",limitation:"Ограничение",transient:"Временный сбой",insufficient_evidence:"Недостаточно данных",unknown:"Неизвестно"};
 const impacts:Record<string,string>={critical:"Критическое",high:"Высокое",medium:"Среднее",low:"Низкое",unknown:"Неизвестно"};
 const states:Record<string,string>={pending:"В очереди",running:"Обрабатывается",ready:"Готово",succeeded:"Готово",waiting_dependency:"Ожидает зависимость",blocked_policy:"Внешняя обработка запрещена",input_too_large:"Слишком большой объём данных",outcome_unknown:"Результат неизвестен",failed:"Ошибка обработки",budget_exhausted:"Лимит исчерпан",complete:"Полное",partial:"Неполное",accepted:"Принято",rejected:"Отклонено",stale:"Устарело"};
 const branches:Record<string,string>={local:"Локальная обработка",embedding:"Поиск похожих",classification:"Предварительный анализ"};
 const stateLabel=(value:string|null)=>value?(states[value]??value):"Неизвестно";
 const coverageText=(value:Coverage)=>"Покрытие: "+stateLabel(value.state)+" — "+value.indexed_reports+" из "+value.total_reports+" обращений.";
 const analysis=enrichment?.processing?.classifications[0];
 const legacy=enrichment?.classification?.payload;
 const machineLabels=analysis?.payload.labels??(legacy?.labels as Record<string,unknown>|undefined)??{};
 const effectiveLabels={...machineLabels,...enrichment?.override?.labels};
 const usesMachine=["suspected_type","suspected_impact"].some(key=>machineLabels[key]!==undefined&&enrichment?.override?.labels[key]===undefined);
 const typeLabel=typeof effectiveLabels.suspected_type==="string"?(types[effectiveLabels.suspected_type]??effectiveLabels.suspected_type):"Не указано";
 const impactLabel=typeof effectiveLabels.suspected_impact==="string"?(impacts[effectiveLabels.suspected_impact]??effectiveLabels.suspected_impact):"Не указано";
 return <section className="bug-hunt-system" aria-label="Поиск и группы">
  <h2>Поиск и группы</h2><p>Поиск охватывает ваши обращения. Повторы не подтверждают наличие ошибки и не означают независимых свидетелей.</p>
  {error&&<p role="alert" className="bug-hunt-error">{error}</p>}
  <div className="bug-hunt-actions"><Button variant={mode==="reports"?"default":"outline"} onClick={()=>setMode("reports")}>Поиск обращений</Button><Button variant={mode==="groups"?"default":"outline"} onClick={()=>{setMode("groups");void loadGroups();}}>Группы</Button></div>
  {mode==="reports"?<><form className="bug-hunt-filters" onSubmit={e=>{e.preventDefault();void search();}}><label>Текст или код ошибки<input value={query} onChange={e=>setQuery(e.target.value)} maxLength={500}/></label><Button disabled={busy||!query.trim()}>Найти</Button></form>
   {coverage&&<p>Запрос: {searchInput.current?.query}. {coverageText(coverage)} Продолжение использует те же фильтры.</p>}<ul className="bug-hunt-list">{results.map(item=><li key={item.case_id}><button type="button" disabled={!!pending} onClick={()=>onOpen(item.case_id)}><strong>{item.title}</strong><span>{item.snippet}</span><span>Метод: {item.method} · Оценка: {item.score}</span></button></li>)}</ul>{searchCursor&&<Button variant="outline" disabled={busy} onClick={()=>void search(true)}>Ещё результаты поиска</Button>}</>:<>
   <h3>{caseId?"Группы владельца выбранного обращения":"Мои группы"}</h3><p>Показано групп: {groups.length}. В одной группе могут быть обращения с разными состояниями разбора.</p>{!groups.length&&!busy&&<p>Групп пока нет.</p>}<ul className="bug-hunt-list">{groups.map(item=><li key={item.id}><button type="button" disabled={busy||!!pending} onClick={()=>void openGroup(item.id)}><strong>Группа {item.id}</strong><span>Обращений: {item.report_count} · Источников: {item.source_count} · Версия: {item.revision}</span></button></li>)}</ul>{groupsCursor&&<Button variant="outline" disabled={busy} onClick={()=>void loadGroups(true)}>Ещё группы</Button>}
   {group&&<div><h3>Состав группы</h3><p>Обращений: {group.member_count}. Состояние разбора определяется отдельно для каждого обращения.</p><ul>{members.map(item=><li key={item.case_id}>{reviewer&&<input aria-label={"Выбрать "+item.title} type="checkbox" checked={selected.includes(item.case_id)} disabled={!!pending} onChange={e=>setSelected(old=>e.target.checked?[...old,item.case_id]:old.filter(id=>id!==item.case_id))}/>} <button type="button" onClick={()=>onOpen(item.case_id)}>{item.title}</button> · {item.method==="exact"?"Точное совпадение":"Вручную"}</li>)}</ul>{membersCursor&&<Button variant="outline" disabled={busy} onClick={()=>void openGroup(group.id,true)}>Ещё обращения группы</Button>}<h3>История группы</h3>{history.length===0?<p>Записей пока нет.</p>:<ol className="bug-hunt-audit">{history.map(item=><li key={item.id}><strong>{item.operation}</strong> · версия {item.old_revision} → {item.new_revision} · {item.registered_at}<p>{item.explanation}</p></li>)}</ol>}{historyCursor&&<Button variant="outline" disabled={busy} onClick={()=>void loadHistory()}>Ещё историю</Button>}
   {reviewer&&<><label>Перенести выбранные<select value={target} disabled={!!pending} onChange={e=>setTarget(e.target.value)}><option value="">В новую группу (отделить)</option>{groups.filter(item=>item.id!==group.id).map(item=><option key={item.id} value={item.id}>Группа {item.id}</option>)}</select></label><Button disabled={!allowed||!selected.length||selected.length>50} onClick={()=>void move()}>Перенести или отделить</Button>{selected.length>50&&<p>За один раз можно перенести до 50 обращений.</p>}</>}</div>}</>}
  {caseId&&<div><h3>Систематизация обращения</h3><Button variant="outline" disabled={busy||!!pending} onClick={()=>void loadCase(caseId)}>Обновить систематизацию</Button>{!enrichment?<p>Данные об обработке пока недоступны.</p>:<>
   <p>Локальная обработка: {stateLabel(enrichment.local.state)} · {enrichment.local.excluded_from_auto?"исключено из автоматической группировки":"допущено к автоматической группировке"}</p>
   {reviewer&&<div><label>Группа выбранного обращения<select value={caseTarget} disabled={!!pending} onChange={e=>setCaseTarget(e.target.value)}><option value="">Создать новую группу</option>{groups.filter(item=>item.id!==enrichment.local.group_id).map(item=><option key={item.id} value={item.id}>Группа {item.id}</option>)}</select></label>{groupsCursor&&<Button variant="outline" disabled={busy||!!pending} onClick={()=>void loadGroups(true)}>Ещё группы владельца</Button>}<Button disabled={!allowed} onClick={()=>void moveCase()}>Сохранить группу обращения</Button>{enrichment.local.excluded_from_auto&&<><Button variant="outline" disabled={!allowed} onClick={()=>void moveCase(true)}>Снять исключение из автоматической группировки</Button>{!enrichment.local.group_id&&<p>При снятии исключения для обращения без группы будет создана новая группа.</p>}</>}</div>}
   <p>Модельная обработка: {stateLabel(enrichment.model_state)}. Метки предварительные и не подтверждают ошибку.</p>
   {enrichment.processing&&enrichment.processing.branches.length>0&&<ul>{enrichment.processing.branches.map(item=><li key={item.branch}>{branches[item.branch]??item.branch}: {stateLabel(item.state)}{item.coverage&&" · покрытие: "+stateLabel(item.coverage)}</li>)}</ul>}
   {Object.keys(effectiveLabels).length>0?<div><h3>Предварительные метки</h3><p>Тип: {typeLabel} · Влияние: {impactLabel}</p><p>Источник: {enrichment.override?(usesMachine?"Проверяющий и Jev":"Проверяющий"):"Jev"}{enrichment.override&&" · "+enrichment.override.explanation}</p></div>:<p>Предварительных меток пока нет.</p>}
   {(analysis||enrichment.classification||enrichment.processing?.branches.length)&&<details><summary>Подробности предварительного анализа</summary>{enrichment.processing?.classifications.map(item=><div key={item.id}><p>Запрошена: {item.payload.requested_model} · применена: {item.payload.actual_model} · версия: {item.model_revision} · профиль: {item.profile_id} · вопросы: {item.question_version} · проекция: {item.projection_version} · время: {item.registered_at}</p><p>Покрытие: {stateLabel(item.payload.coverage)} · исключённые поля: {item.payload.excluded_fields.join(", ")||"нет"}</p><p>Ответы и ограничения: {JSON.stringify(item.payload.answers)}</p></div>)}{!analysis&&enrichment.classification&&<p>Результат модели: {JSON.stringify(enrichment.classification.payload)} · версия {enrichment.classification.generation}</p>}{enrichment.processing?.branches.map(item=><p key={item.branch}>{branches[item.branch]??item.branch}: попыток {item.attempt_count}{item.code&&" · "+item.code}</p>)}</details>}
   <Button variant="outline" disabled={busy} onClick={()=>void findSimilar()}>Найти похожие</Button><p>Оценка сходства не является вероятностью ошибки.</p>
   {similarCoverage&&<p>{coverageText(similarCoverage)}</p>}<ul>{similar.map(item=><li key={item.case_id}><button type="button" onClick={()=>onOpen(item.case_id)}>{item.case_id}</button> · {item.method} · {item.score}</li>)}</ul>{similarCursor&&<Button variant="outline" disabled={busy} onClick={()=>void findSimilar(true)}>Ещё похожие</Button>}
   {enrichment.proposals.length>0&&<><h3>Предполагаемые связи</h3><ul>{enrichment.proposals.map(item=><li key={item.id}>{item.candidate_case_id} · {item.method} · {item.score} · {stateLabel(item.state)} {reviewer&&item.state==="pending"&&<><Button disabled={!allowed} onClick={()=>void resolve(item,"accepted")}>Принять</Button><Button variant="outline" disabled={!allowed} onClick={()=>void resolve(item,"rejected")}>Отклонить</Button></>}</li>)}</ul></>}
   {reviewer&&<><h3>Ручная предварительная метка</h3><div className="bug-hunt-filters"><label>Предполагаемый тип<select value={kind} onChange={e=>setKind(e.target.value)}>{Object.entries(types).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label><label>Предполагаемое влияние<select value={impact} onChange={e=>setImpact(e.target.value)}>{Object.entries(impacts).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label></div><Button disabled={!allowed} onClick={()=>void mutate("classification-override",{request_id:crypto.randomUUID(),case_id:caseId,expected_revision:enrichment.override?.revision??0,labels:{suspected_type:kind,suspected_impact:impact},explanation})}>Сохранить метку</Button></>}
  </>}</div>}
  {reviewer&&<div className="bug-hunt-review"><label>Объяснение группировки или метки<textarea value={explanation} disabled={!!pending} onChange={e=>setExplanation(e.target.value)}/><span>{[...explanation].length} / 4000 знаков</span></label>{pending&&<Button disabled={busy} onClick={()=>void mutate(pending.operation,pending.input)}>Повторить прежний запрос</Button>}</div>}
 </section>;
}
