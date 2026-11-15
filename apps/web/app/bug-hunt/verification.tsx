"use client";
// ABOUTME: Показывает состояние, область применимости и доказательства проверки v3.
// ABOUTME: Выполнение, воспроизведение и вердикт различаются; запрос запускается только явным действием.
import {useEffect,useState,useRef} from "react";
import {Button} from "@/components/ui/button";
const states:Record<string,string>={queued:"В очереди",running:"Проверяется",waiting_dependency:"Ожидает зависимость",blocked_policy:"Ограничено политикой",outcome_unknown:"Исход запуска неизвестен",completed:"Проверка завершена",failed:"Проверка не завершена из-за ошибки",cancelled:"Отменена"};
const verdicts:Record<string,string>={confirmed:"Дефект подтверждён",refuted:"Конкретное предположение опровергнуто",insufficient_evidence:"Недостаточно данных"};
const reproductions:Record<string,string>={reproduced:"Воспроизведено",not_reproduced:"Не воспроизведено",not_attempted:"Не запускалось",blocked:"Запуск ограничен",invalid_test:"Проверка непригодна"};
type Detail={investigation_id:string;state:string;code:string|null;executor:string;config_revision:string;model:{id:string;effort:string|null}|null;revision:number;snapshot:{source:{commit:string}|null;cases:{case_id:string}[]};applicability:string;cancel_requested:boolean;manual_revision:number;results:{id:string;revision:number;payload:{verdict:string;claim:string;expected:string;facts:string[];missing:string[];limitations:string[];reproduction_outcome:string;evidence_availability:string};registered_at:string}[];reviews:{id:string;revision:number;verdict:string;explanation:string;registered_at:string}[];evidence:{id:string;kind:string;sha256:string}[];effects:{id:string;kind:string;state:string;code:string|null}[]};
/** Читает только свою доступную карточку; новая учётная запись получает отдельный экземпляр панели. */
export default function Verification({userId,caseId,reviewer,onUnauthorized}:{userId:string;caseId:string;reviewer:boolean;onUnauthorized:()=>void}){
 const [items,setItems]=useState<{id:string;state:string;revision:number}[]>([]),[detail,setDetail]=useState<Detail|null>(null),[error,setError]=useState(""),[busy,setBusy]=useState(false);
 const [evidence,setEvidence]=useState<{id:string;text:string;offset:number;next_offset:number|null;sha256:string}|null>(null),[reason,setReason]=useState(""),[reviewVerdict,setReviewVerdict]=useState("insufficient_evidence");
 const [pending,setPending]=useState<{operation:string;input:Record<string,unknown>}|null>(null);
 const [due,setDue]=useState<string|null>(null);
 const controller=useRef<AbortController|null>(null),generation=useRef(0);
 const request=async(operation:string,input:unknown)=>{
  const r=await fetch("/api/bug-hunt?operation=verification."+operation,{method:"POST",headers:{"content-type":"application/json","x-brai-user":userId},body:JSON.stringify(input),cache:"no-store",signal:controller.current?.signal});
  const v=await r.json();if(!r.ok){if(r.status===401)onUnauthorized();throw Object.assign(new Error(v.code==="NOT_FOUND"?"Проверка недоступна.":v.code==="MANUAL_DISABLED"?"Ручной запуск выключен.":v.code==="PAUSED"?"Проверки приостановлены.":"Не удалось получить ответ проверки."),{outcome:v.outcome});}return v;
 };
 const open=async(id:string)=>{const g=++generation.current;setBusy(true);try{const value=await request("get",{investigation_id:id});if(g===generation.current){setDetail(value);setEvidence(null);setError("");}}catch(e){if(!controller.current?.signal.aborted)setError((e as Error).message);}finally{if(g===generation.current)setBusy(false);}};
 const load=async()=>{const value=await request("list",{case_id:caseId,limit:20});setItems(value.items);setDue(value.next_due_at??null);if(value.items.length)await open(value.items[0].id);else setDetail(null);};
 useEffect(()=>{controller.current=new AbortController();void load().catch(e=>{if(!controller.current?.signal.aborted)setError(e.message);});return()=>{controller.current?.abort();generation.current++;};},[userId,caseId]);
 const mutate=async(operation:string,input:Record<string,unknown>)=>{
  setPending({operation,input});setBusy(true);setError("");
  try{await request(operation,input);setPending(null);await load();}
  catch(e){const v=e as Error&{outcome?:string};if(v.outcome==="not_accepted")setPending(null);setError(v.message+(v.outcome==="unknown"?" Исход неизвестен. Повторите прежний запрос для сверки.":""));}
  finally{setBusy(false);}
 };
 const read=async(id:string,offset=0)=>{if(!detail)return;try{const value=await request("evidence.get",{investigation_id:detail.investigation_id,evidence_id:id,offset,limit:4096});setEvidence(value);}catch(e){setError((e as Error).message);}};
 const result=detail?.results[0]?.payload,manual=detail?.reviews[0];
 return <section className="bug-hunt-review" aria-label="Проверка реальности ошибки" aria-busy={busy}>
  <h3>Проверка реальности ошибки</h3>
  <p>Вывод относится к указанным наблюдениям, версии и условиям. Отсутствие воспроизведения само по себе не опровергает ошибку.</p>
  {due&&<p>Следующий плановый разбор: <time dateTime={due}>{new Date(due).toLocaleString("ru-RU")}</time>.</p>}
  {error&&<p role="alert" className="bug-hunt-error">{error}</p>}
  <div className="bug-hunt-actions"><Button disabled={busy||!!pending} onClick={()=>void mutate("run.request",{request_id:crypto.randomUUID(),target:{kind:"case",id:caseId},...(reason.trim()?{reason}:{})})}>Проверить сейчас</Button><Button variant="outline" disabled={busy} onClick={()=>void load().catch(e=>setError(e.message))}>Обновить проверку</Button></div>
  {!items.length&&<p>Проверка ещё не запускалась.</p>}
  {items.length>1&&<label>История проверок<select value={detail?.investigation_id??""} disabled={busy||!!pending} onChange={e=>void open(e.target.value)}>{items.map(i=><option key={i.id} value={i.id}>Проверка {i.revision} · {states[i.state]??i.state}</option>)}</select></label>}
  {detail&&<>
   <p><strong>{states[detail.state]??detail.state}</strong>{detail.code&&" · "+detail.code}{detail.cancel_requested&&" · Запрошена отмена"}</p>
   {detail.state==="queued"&&<p>Запрос сохранён. Модель ещё не начала проверку.</p>}
   <p>Исполнитель: {detail.executor==="codex_app_server"?"Codex":"Providers"}{detail.model?" · "+detail.model.id+(detail.model.effort?" / "+detail.model.effort:""):" · Модель ещё не выбрана"}. Настройки: {detail.config_revision}.</p>
   <p>Проверяемая версия: {detail.snapshot.source?.commit??"не установлена"}. Наблюдений в снимке: {detail.snapshot.cases.length}.</p>
   {detail.applicability==="stale"&&<p>Состав группы изменился. Этот вывод сохраняет прежнюю область и не распространяется на новых участников.</p>}
   {manual&&<div><h4>Решение проверяющего: {verdicts[manual.verdict]}</h4><p>{manual.explanation}</p></div>}
   {result&&<div><h4>{manual?"Автоматический вывод: ":""}{verdicts[result.verdict]}</h4><p>{result.claim}</p><p>Ожидалось по контракту: {result.expected}</p><p>Воспроизведение: {reproductions[result.reproduction_outcome]??result.reproduction_outcome}.</p><ul>{result.facts.map((v,i)=><li key={i}>{v}</li>)}</ul>{result.missing.length>0&&<><h4>Чего не хватает</h4><ul>{result.missing.map((v,i)=><li key={i}>{v}</li>)}</ul></>}{result.limitations.length>0&&<><h4>Ограничения</h4><ul>{result.limitations.map((v,i)=><li key={i}>{v}</li>)}</ul></>}<p>Доступность доказательств: {result.evidence_availability==="available"?"доступны":"неполная"}.</p></div>}
   <details><summary>Доказательства и выполненные шаги</summary><ul>{detail.evidence.map(e=><li key={e.id}><button type="button" onClick={()=>void read(e.id)}>{e.kind} · {e.sha256.slice(0,12)}</button></li>)}</ul>{evidence&&<div><pre style={{whiteSpace:"pre-wrap",overflowWrap:"anywhere"}}>{evidence.text}</pre>{evidence.next_offset!==null&&<Button variant="outline" onClick={()=>void read(evidence.id,evidence.next_offset!)}>Следующий фрагмент</Button>}</div>}<ul>{detail.effects.map(e=><li key={e.id}>{e.kind} · {e.state}{e.code&&" · "+e.code}</li>)}</ul></details>
   {!["completed","failed","cancelled"].includes(detail.state)&&<Button variant="outline" disabled={busy||!!pending||!reason.trim()} onClick={()=>void mutate("cancel",{request_id:crypto.randomUUID(),investigation_id:detail.investigation_id,reason})}>Запросить отмену</Button>}
   {reviewer&&<div><label>Ручной вывод<select value={reviewVerdict} onChange={e=>setReviewVerdict(e.target.value)}>{Object.entries(verdicts).map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label><Button variant="outline" disabled={busy||!!pending||!reason.trim()} onClick={()=>void mutate("review",{request_id:crypto.randomUUID(),investigation_id:detail.investigation_id,expected_revision:detail.manual_revision,verdict:reviewVerdict,explanation:reason})}>Сохранить ручной вывод</Button></div>}
  </>}
  <label>Основание перепроверки, отмены или ручного решения<textarea value={reason} maxLength={4000} disabled={busy||!!pending} onChange={e=>setReason(e.target.value)}/></label>
  {pending&&<Button disabled={busy} onClick={()=>void mutate(pending.operation,pending.input)}>Повторить прежний запрос</Button>}
 </section>;
}
