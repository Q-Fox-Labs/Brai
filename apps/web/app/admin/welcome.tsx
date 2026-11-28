// ABOUTME: Раздел Welcome для настройки режима и рассмотрения заявок.
// ABOUTME: Экран переписок использует общий AdminChats и его проверку отказов.
'use client';
import {useEffect,useState} from 'react';
import AdminChats from '../agent/admin-chats';
import {AdminChatError,type AdminChat,type ChatPage} from '../agent/admin-chat-client';

type Settings={enabled:boolean;model:string;reasoning:string;image_enabled:boolean;request_limit:number;image_limit:number};
type Model={id:string;name:string;reasoning:string[]};
type Visitor={user_id:string;name:string;username?:string;requests:number;images:number;requestLimit:number;imageLimit:number;
 requestNext?:string;imageNext?:string;inviter_name?:string;inviter_username?:string};
type Application={id:string;name:string;username?:string;occupation:string;purpose:string;status:string;operation?:{state:string}};
type ChatRow={user_id:string;dialogue_id:string;name:string;username?:string;updated_at:string};
type TurnRow={update_id:string;input_text:string;created_at:string;result?:{text:string}};

async function call<T>(operation:string,input:Record<string,string|number|boolean> = {},write=false,signal?:AbortSignal):Promise<T>{
 const query='/api/welcome?'+new URLSearchParams({operation,...Object.fromEntries(Object.entries(input).map(([key,value])=>[key,String(value)]))});
 const response=await fetch(write?'/api/welcome':query,{
  method:write?'POST':'GET',cache:'no-store',signal,
  ...(write?{headers:{'content-type':'application/json'},body:JSON.stringify({operation,...input})}:{})
 });
 if(!response.ok)throw new AdminChatError(response.status);
 return response.json();
}
const source={
 async list(_:AdminChat[],signal:AbortSignal){
  const result=await call<{items:ChatRow[]}>('chats',{},false,signal);
  return {chats:result.items.map(row=>({id:row.dialogue_id,title:row.name,updatedAt:row.updated_at,
   owner:{id:row.user_id,name:row.name},participant:{name:row.name,username:row.username,telegramId:null}})), unavailable:[]};
 },
 async latest(chat:AdminChat,_after:string|undefined,signal:AbortSignal):Promise<ChatPage>{
  const result=await call<{items:TurnRow[]}>('messages',{userId:chat.owner.id,dialogueId:chat.id},false,signal);
  return {messages:result.items.flatMap(row=>{
   const id=BigInt(row.update_id)*BigInt(2);
   return [{id:String(id),role:'user' as const,text:row.input_text,createdAt:row.created_at},...(row.result?
    [{id:String(id+BigInt(1)),role:'assistant' as const,text:row.result.text,createdAt:row.created_at}]:[])];
  }),nextCursor:null};
 }
};
const tabs={chats:'Диалоги',visitors:'Пользователи и лимиты',settings:'Настройки',applications:'Запросы на доступ'};
const statusNames:Record<string,string>={pending:'На рассмотрении',approving:'Подготовка профиля',approved:'Доступ выдан',rejected:'Отклонена'};
const clock=new Intl.DateTimeFormat('ru',{dateStyle:'short',timeStyle:'short'});

/** Показывает занятые места и время ближайшего освобождения при исчерпанной квоте. */
function quota(used:number,limit:number,next?:string){
 return <>{used} / {limit}{next&&<><br/><time dateTime={next}>Доступно с {clock.format(new Date(next))}</time></>}</>;
}

/** Переключает подразделы Welcome и применяет подтверждённые администратором изменения. */
export default function WelcomeSection({userId}:{userId:string}){
 const [tab,setTab]=useState<keyof typeof tabs>('chats');
 const [settings,setSettings]=useState<Settings>();
 const [models,setModels]=useState<Model[]>([]);
 const [visitors,setVisitors]=useState<Visitor[]>([]);
 const [applications,setApplications]=useState<Application[]>([]);
 const [error,setError]=useState('');
 const [status,setStatus]=useState('');
 const [revision,reload]=useState(0);
 const [busy,setBusy]=useState(false);
 useEffect(()=>{
  const c=new AbortController();
  setError('');
  setStatus('');
  if(tab==='settings')void call<{value:Settings;models:Model[]}>(tab,{},false,c.signal)
   .then(result=>{setSettings(result.value);setModels(result.models);}).catch(()=>{if(!c.signal.aborted)setError('Настройки Welcome недоступны.');});
  if(tab==='visitors')void call<{items:Visitor[]}>(tab,{},false,c.signal)
   .then(result=>setVisitors(result.items)).catch(()=>{if(!c.signal.aborted)setError('Список пользователей недоступен.');});
  if(tab==='applications')void call<{items:Application[]}>(tab,{},false,c.signal)
   .then(result=>setApplications(result.items)).catch(()=>{if(!c.signal.aborted)setError('Заявки недоступны.');});
  return ()=>c.abort();
 },[tab,revision]);
 const save=async ()=>{
  if(!settings)return;
  setBusy(true);setError('');
  try{await call('save-settings',settings,true);setStatus('Настройки сохранены.');}
  catch{setError('Не удалось сохранить настройки.');}
  finally{setBusy(false);}
 };
 const decide=async(applicationId:string,decision:'approve'|'reject')=>{
  setBusy(true);setError('');
  try{await call('decision',{applicationId,decision},true);reload(value=>value+1);}
  catch{setError('Результат решения не подтверждён. Обновите список и проверьте состояние.');}
  finally{setBusy(false);}
 };
 return <section className="admin-section" aria-label="Welcome">
  <nav className="admin-tabs" aria-label="Разделы Welcome">{Object.entries(tabs).map(([key,label])=>
   <button key={key} type="button" aria-pressed={tab===key} onClick={()=>setTab(key as keyof typeof tabs)}>{label}</button>)}</nav>
  {error&&<p role="alert">{error}</p>}{status&&<p role="status">{status}</p>}
  {tab==='chats'&&<AdminChats userId={userId} active source={source} onUnauthorized={()=>setError('Войдите в админку повторно.')} embedded/>}
  {tab==='settings'&&settings&&<form className="admin-data" onSubmit={event=>{event.preventDefault();void save();}}>
   <label><input type="checkbox" checked={settings.enabled} onChange={event=>setSettings({...settings,enabled:event.target.checked})}/> Welcome включён</label>
   <label>Модель <select value={settings.model} onChange={event=>{
    const target=models.find(model=>model.id===event.target.value);
    if(target)setSettings({...settings,model:target.id,reasoning:target.reasoning[0]??''});
   }}>{models.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
   <label>Уровень рассуждения <select value={settings.reasoning} onChange={event=>setSettings({...settings,reasoning:event.target.value})}>
    {models.find(model=>model.id===settings.model)?.reasoning.map(item=><option key={item}>{item}</option>)}
   </select></label>
   <label><input type="checkbox" checked={settings.image_enabled} onChange={event=>setSettings({...settings,image_enabled:event.target.checked})}/> Генерация изображений</label>
   <label>Запросов за 24 часа <input type="number" min={0} required value={settings.request_limit} onChange={event=>setSettings({...settings,request_limit:Number(event.target.value)})}/></label>
   <label>Изображений за 24 часа <input type="number" min={0} required value={settings.image_limit} onChange={event=>setSettings({...settings,image_limit:Number(event.target.value)})}/></label>
   <button type="submit" disabled={busy}>Сохранить</button>
  </form>}
  {tab==='visitors'&&<table><thead><tr><th>Пользователь</th><th>Запросы</th><th>Изображения</th><th>Пригласил</th></tr></thead><tbody>
   {visitors.map(item=><tr key={item.user_id}><td>{item.name}{item.username&&' @'+item.username}</td>
    <td>{quota(item.requests,item.requestLimit,item.requestNext)}</td><td>{quota(item.images,item.imageLimit,item.imageNext)}</td>
    <td>{item.inviter_name??'—'}{item.inviter_username&&' @'+item.inviter_username}</td></tr>)}
  </tbody></table>}
  {tab==='applications'&&<section aria-label="Заявки"><button type="button" onClick={()=>reload(value=>value+1)}>Обновить</button>
   {applications.map(item=><article key={item.id} className="admin-user-card"><h3>{item.name}{item.username&&' @'+item.username}</h3>
    <p>{statusNames[item.status]??item.status}{item.operation?.state==='failed'&&' · Не удалось подготовить профиль'}</p>
    <dl><dt>Чем занимается</dt><dd>{item.occupation}</dd><dt>Для чего нужен агент</dt><dd>{item.purpose}</dd></dl>
    {item.status==='pending'&&<div><button type="button" disabled={busy} onClick={()=>void decide(item.id,'approve')}>Одобрить</button><button type="button" disabled={busy} onClick={()=>void decide(item.id,'reject')}>Отклонить</button></div>}
    {item.status==='approving'&&!item.operation&&<button type="button" disabled={busy} onClick={()=>void decide(item.id,'approve')}>Повторить выдачу</button>}
   </article>)}
  </section>}
 </section>;
}
