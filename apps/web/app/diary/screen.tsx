"use client";
// ABOUTME: Показывает архив Дневника, создание записей и загрузку оригиналов.
// ABOUTME: Незавершённая загрузка сохраняет ключи повтора; обсуждений и удаления нет.
import { useCallback,useEffect,useRef,useState } from "react";
import { BookOpen,Download,FileText,Plus,Upload } from "lucide-react";
import WorkspaceFrame from "../shell/workspace-frame";
import { Button } from "@/components/ui/button";
import type { DiaryEntry,DiaryMaterial,DiarySummary } from "./types";
import "./styles.css";
type UploadItem={key:string;file:File;role:string;saved:boolean};
const roles:Record<string,string>={original:"Оригинал",transcript:"Расшифровка",correction:"Исправление"};
function dateLabel(value:string|null):string {return value?new Date(value+"T12:00:00").toLocaleDateString("ru-RU",{day:"numeric",month:"long",year:"numeric"}):"Дата не указана";}
function size(value:number|null):string{return value===null?"":value<1024?value+" Б":value<1048576?(value/1024).toFixed(1)+" КБ":(value/1048576).toFixed(1)+" МБ";}
function fileUrl(entryId:string,materialId:string,userId:string){return "/api/diary/file?entry="+entryId+"&material="+materialId+"&account="+encodeURIComponent(userId);}
/** Читает безопасный текст вложения; исходник остаётся доступным для скачивания. */
function TextMaterial({url}:{url:string}){
 const [text,setText]=useState<string|null>(null),[failed,setFailed]=useState(false);
 useEffect(()=>{const control=new AbortController();void fetch(url,{cache:"no-store",signal:control.signal}).then(async response=>{if(!response.ok)throw new Error();const value=await response.text();if(!control.signal.aborted)setText(value);}).catch(()=>{if(!control.signal.aborted)setFailed(true);});return()=>control.abort();},[url]);
 return <pre className="diary-text">{failed?"Не удалось прочитать материал. Попробуйте открыть его снова.":text??"Читаем материал…"}</pre>;
}
/** Показывает сохранённый оригинал подходящим безопасным проигрывателем. */
function Material({item,entryId,userId}:{item:DiaryMaterial;entryId:string;userId:string}){
 const url=fileUrl(entryId,item.id,userId);
 return <section className="diary-material">
  <header><div><strong>{item.filename}</strong><span>{roles[item.role]??"Материал"} · {size(item.sizeBytes)}</span></div><a href={url+"&download=1"} aria-label={"Скачать "+item.filename}><Download size={17}/></a></header>
  {["image/png","image/jpeg","image/webp","image/gif"].includes(item.mimeType)?<a href={url} target="_blank" rel="noreferrer"><img src={url} alt={item.filename} loading="lazy"/></a>
   :["audio/ogg","audio/opus","audio/mpeg","audio/mp4","audio/x-m4a","audio/webm","audio/wav"].includes(item.mimeType)?<audio controls preload="none" src={url}/>
   :["video/mp4","video/webm"].includes(item.mimeType)?<video controls preload="metadata" src={url}/>
   :["text/plain","text/markdown","application/json"].includes(item.mimeType)&&(item.sizeBytes??Infinity)<=16*1024*1024?<details><summary>Читать материал</summary><TextMaterial url={url}/></details>
   :<a className="diary-file-link" href={url+"&download=1"}><FileText size={18}/> Открыть файл</a>}
 </section>;
}
/** Держит форму внутри аккаунта и читает записи без запуска агента. */
export default function DiaryScreen({userId,onUnauthorized}:{userId:string;onUnauthorized:()=>void}){
 const [entries,setEntries]=useState<DiarySummary[]>([]),[total,setTotal]=useState(0),[selected,setSelected]=useState<string|null>(null),[entry,setEntry]=useState<DiaryEntry|null>(null);
 const [loading,setLoading]=useState(true),[reading,setReading]=useState(false),[error,setError]=useState(""),[notice,setNotice]=useState(""),[creating,setCreating]=useState(false),[busy,setBusy]=useState(false);
 const [title,setTitle]=useState(""),[date,setDate]=useState(""),[text,setText]=useState(""),[uploads,setUploads]=useState<UploadItem[]>([]),[createdId,setCreatedId]=useState<string|null>(null);
 const requestId=useRef(""),readEpoch=useRef(0),alive=useRef(true),locked=useRef(false);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;readEpoch.current++;};},[]);
 const api=useCallback(async(path:string,options:RequestInit={}):Promise<Record<string,unknown>>=>{
  const response=await fetch("/api/diary"+path,{...options,cache:"no-store",headers:{"x-brai-user":userId,...options.headers}});
  if(response.status===401){onUnauthorized();throw new Error("Войдите снова, чтобы открыть Дневник.");}
  if(!response.ok){const body=await response.json().catch(()=>({}));throw new Error(body.code==="CONTENT_CONFLICT"||body.code==="CONFLICT"?"Этот ключ уже связан с другими данными. Сохранённые материалы не изменены.":body.code==="TOO_LARGE"||response.status===413?"Материал превышает допустимый размер.":body.code==="NOT_CONFIGURED"?"Дневник ещё не подключён к хранилищу.":"Не удалось подтвердить действие. Уже сохранённые материалы остаются в Дневнике. Повторите попытку.");}
  return response.json() as Promise<Record<string,unknown>>;
 },[userId,onUnauthorized]);
 const loadList=useCallback(async(append=false)=>{
  const data=await api("?offset="+(append?entries.length:0));
  if(!alive.current)return;
  const rows=data.entries as DiarySummary[];
  setEntries(old=>append?[...old,...rows.filter(item=>!old.some(x=>x.id===item.id))]:rows);setTotal(data.total as number);
 },[api,entries.length]);
 useEffect(()=>{void api("").then(data=>{if(alive.current){setEntries(data.entries as DiarySummary[]);setTotal(data.total as number);}}).catch(e=>{if(alive.current)setError(e.message);}).finally(()=>{if(alive.current)setLoading(false);});},[api]);
 const open=useCallback(async(id:string,append=false)=>{
  const epoch=++readEpoch.current;setSelected(id);setCreating(false);setReading(true);setError("");
  if(!append)setEntry(null);
  try{const data=await api("/entry?id="+id+(append?"&offset="+(entry?.materials.length??0):""));if(!alive.current||epoch!==readEpoch.current)return;const next=data.entry as DiaryEntry;setEntry(old=>append&&old?.id===id?{...next,materials:[...old.materials,...next.materials.filter(item=>!old.materials.some(x=>x.id===item.id))]}:next);}
  catch(e){if(alive.current&&epoch===readEpoch.current)setError((e as Error).message);}
  finally{if(alive.current&&epoch===readEpoch.current)setReading(false);}
 },[api,entry?.materials.length]);
 function fresh(){
  readEpoch.current++;setCreating(true);setSelected(null);setEntry(null);setCreatedId(null);setTitle("");setDate("");setText("");setUploads([]);requestId.current=crypto.randomUUID();setError("");setNotice("");
 }
 async function save(){
  if(locked.current)return;locked.current=true;setBusy(true);setError("");setNotice("");
  let id=createdId;
  try{
   if(!requestId.current)requestId.current=crypto.randomUUID();
   if(!id){const data=await api("",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({requestId:requestId.current,title:title.trim()||"Новая запись",date:date||null,text})});id=(data.entry as DiarySummary).id;if(!alive.current)return;setCreatedId(id);}
   // AIDEV-NOTE: Принятые файлы не отправляются повторно с новыми ключами при частичном отказе.
   for(const item of uploads.filter(x=>!x.saved)){
    setNotice("Сохраняем "+item.file.name+"…");
    const data=await api("/materials?entry="+id,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({requestId:item.key,filename:item.file.name,mimeType:item.file.type||"application/octet-stream",role:item.role})});
    const material=data.material as DiaryMaterial;
    await api("/upload?entry="+id+"&material="+material.id,{method:"PUT",headers:{"Content-Type":"application/octet-stream","x-content-size":String(item.file.size)},body:item.file});
    if(!alive.current)return;
    setUploads(current=>current.map(x=>x.key===item.key?{...x,saved:true}:x));
   }
   if(!alive.current)return;
   setNotice("Запись и все материалы сохранены.");setUploads([]);setCreatedId(null);setText("");setTitle("");setDate("");await loadList();await open(id);
  }catch(e){if(alive.current){setError((e as Error).message);setNotice(id?"Запись сохранена. Загрузку оставшихся файлов можно повторить.":"");if(id)void loadList().catch(()=>{});}}
  finally{locked.current=false;if(alive.current)setBusy(false);}
 }
 const rail=<div className="diary-rail">
  <Button onClick={fresh} disabled={busy}><Plus size={16}/> Новая запись</Button>
  {loading?<p role="status">Открываем Дневник…</p>:!entries.length?<p>Сохранённые записи появятся здесь.</p>:<nav aria-label="Записи Дневника">{entries.map(item=><button key={item.id} type="button" className={selected===item.id?"selected":""} onClick={()=>void open(item.id)} disabled={busy} aria-current={selected===item.id?"page":undefined}><strong>{item.title}</strong><span>{dateLabel(item.date)}</span></button>)}</nav>}
  {entries.length<total&&<Button variant="outline" onClick={()=>{void loadList(true).catch(e=>setError(e.message));}}>Ещё записи</Button>}
 </div>;
 return <WorkspaceFrame section="diary" userId={userId} title="Дневник" railTitle="Записи" rail={rail}>
  <div className="diary-screen">
   {error&&<div className="diary-message diary-error" role="alert">{error}<Button variant="outline" disabled={busy} onClick={()=>{void (selected?open(selected):loadList()).catch(e=>setError(e.message));}}>Обновить</Button></div>}
   {notice&&<p className="diary-message" role="status">{notice}</p>}
   {creating?<form className="diary-compose" onSubmit={event=>{event.preventDefault();void save();}}>
    <h1>{createdId?"Добавить материалы":"Новая запись"}</h1><p className="diary-muted">Сохраним текст и оригинальные файлы. Дату можно оставить пустой.</p>
    <label>Заголовок<input value={title} maxLength={512} disabled={busy||!!createdId} onChange={event=>{setTitle(event.target.value);requestId.current=crypto.randomUUID();}} placeholder="О чём эта запись"/></label>
    <label>Дата записи<input type="date" value={date} disabled={busy||!!createdId} onChange={event=>{setDate(event.target.value);requestId.current=crypto.randomUUID();}}/></label>
    <label>Текст<textarea value={text} disabled={busy||!!createdId} onChange={event=>{setText(event.target.value);requestId.current=crypto.randomUUID();}} rows={12} placeholder="Можно оставить только файлы"/></label>
    <label className="diary-upload"><Upload size={18}/> Добавить материалы<input type="file" multiple disabled={busy} onChange={event=>{const files=Array.from(event.target.files??[]);if(files.some(file=>file.size===0||file.size>2147483648)){setError("Файл должен быть непустым и не больше 2 ГБ.");return;}setUploads(current=>[...current,...files.map(file=>({key:crypto.randomUUID(),file,role:"original",saved:false}))]);event.target.value="";}}/></label>
    {uploads.length>0&&<ul className="diary-upload-list">{uploads.map(item=><li key={item.key}><span>{item.file.name}<small>{size(item.file.size)}{item.saved?" · Сохранён":""}</small></span><select aria-label={"Тип материала "+item.file.name} value={item.role} disabled={busy||item.saved} onChange={event=>setUploads(current=>current.map(x=>x.key===item.key?{...x,role:event.target.value}:x))}>{Object.entries(roles).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></li>)}</ul>}
    <Button type="submit" disabled={busy||(!text.trim()&&!uploads.length&&!createdId)}>{busy?"Сохраняем…":createdId?"Сохранить материалы":"Сохранить запись"}</Button>
   </form>:reading&&!entry?<p role="status">Читаем запись…</p>:entry?<article className="diary-entry">
    <header><Button variant="outline" onClick={()=>{setCreatedId(entry.id);setTitle(entry.title);setDate(entry.date??"");setText(entry.text);setUploads([]);setCreating(true);setError("");setNotice("");}}>Добавить материалы</Button><p className="diary-date">{dateLabel(entry.date)}</p><h1>{entry.title}</h1><p className="diary-muted">Сохранено {new Date(entry.createdAt).toLocaleString("ru-RU")}</p></header>
    {entry.text&&<div className="diary-text">{entry.text}</div>}
    {entry.materials.length>0&&<div className="diary-materials"><h2>Материалы</h2>{entry.materials.map(item=><Material key={item.id} item={item} entryId={entry.id} userId={userId}/>)}</div>}
    {entry.materials.length<entry.materialsTotal&&<Button variant="outline" disabled={reading} onClick={()=>void open(entry.id,true)}>Ещё материалы</Button>}
   </article>:<div className="diary-empty"><BookOpen size={36} strokeWidth={1.3}/><h1>Место для твоих записей</h1><p>Тексты, фотографии, аудио и другие материалы.<br/>Открой запись слева или сохрани новую.</p><Button onClick={fresh}><Plus size={16}/> Новая запись</Button></div>}
  </div>
 </WorkspaceFrame>;
}
