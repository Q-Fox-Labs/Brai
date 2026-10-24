"use client";
// ABOUTME: Даёт Игроку создание поручения и доступный Экшен с настоящим результатом.
// ABOUTME: Авторизацию и ревизию проверяет сервер; UUID не выводятся в интерфейс.
import {useState} from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import type {BoardData,Move} from './model';

type Props={dataset:BoardData;onDataChange:(data:BoardData)=>void};
async function save(method:string,value:unknown){
 const response=await fetch('/api/game-core/workflow',{method,headers:{'content-type':'application/json'},body:JSON.stringify(value)});
 if(!response.ok)throw new Error(response.status===409?'Состояние изменилось. Обновите карту и откройте Ход снова.':'Не удалось сохранить. Обновите карту и проверьте результат перед повтором.');
 return await response.json() as BoardData;
}
/** Создаёт черновик; сам план появится после работы напарника и независимой проверки. */
export function NewTask({onDataChange}:Props){
 const [open,setOpen]=useState(false),[title,setTitle]=useState(''),[request,setRequest]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false),[key,setKey]=useState('');
 return <Dialog.Root open={open} onOpenChange={v=>{setOpen(v);if(v&&!key)setKey(crypto.randomUUID());}}><Dialog.Trigger className="game-core-new-task">Новое поручение</Dialog.Trigger><Dialog.Portal><Dialog.Overlay className="game-core-detail-overlay"/><Dialog.Content className="game-core-detail game-core-workflow" aria-describedby="new-task-help"><Dialog.Title>Новое поручение</Dialog.Title><Dialog.Description id="new-task-help">Опишите желаемый результат. Напарник определит вид элемента и подготовит план для вашего подтверждения.</Dialog.Description><form onSubmit={async event=>{event.preventDefault();setBusy(true);setError('');try{onDataChange(await save('POST',{title,request,request_id:key}));setOpen(false);setTitle('');setRequest('');setKey('');}catch(e){setError((e as Error).message);}finally{setBusy(false);}}}><label>Название<input required maxLength={1000} value={title} onChange={e=>setTitle(e.target.value)}/></label><label>Поручение<textarea required maxLength={16000} rows={8} value={request} onChange={e=>setRequest(e.target.value)}/></label>{error&&<p role="alert">{error}</p>}<button disabled={busy} type="submit">{busy?'Сохраняем…':'Передать напарнику'}</button><Dialog.Close>Закрыть</Dialog.Close></form></Dialog.Content></Dialog.Portal></Dialog.Root>;
}
/** Показывает только фактически доступный Ход и сохраняет практические выходы отдельно от решения. */
export function WorkflowAction({move,dataset,onDataChange}:Props&{move:Move}){
 const [comment,setComment]=useState(''),[values,setValues]=useState<Record<string,string>>({}),[busy,setBusy]=useState(false),[error,setError]=useState(''),[key]=useState(()=>crypto.randomUUID());
 const target=dataset.elements.find(e=>e.id===move.targetId);
 const planning=(move.fields as {planning?:{decision?:string;output_contracts:{key:string;name:string}[]}})?.planning;
 const available=dataset.readyMoveIds?.includes(move.id)||move.status==='claimed';
 if(!target||!['planned','claimed'].includes(move.status))return null;
 const start=move.kind==='operation'&&['plan','start','expand','update'].includes(move.purpose??'');
 if(!start&&(move.kind!=='action'||!planning))return null;
 async function submit(decision?:string){setBusy(true);setError('');try{onDataChange(await save('PUT',{operation:start?'start':'action',move_id:move.id,revision_id:target!.revision,request_id:key,...(start?{}:{decision,comment,values})}));}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
 if(start)return <section className="game-core-workflow"><h3>Постановка</h3>{move.status==='claimed'?<p>Постановка открыта. Попросите напарника продолжить её в агентном канале. После подготовки плана обновите карту и подтвердите постановку.</p>:<button disabled={!available||busy} onClick={()=>void submit()}>Начать постановку</button>}{!available&&<p>Предыдущий Ход ещё не завершён.</p>}{error&&<p role="alert">{error}</p>}</section>;
 const stage=planning!.decision==='confirm'?'planning':planning!.decision==='final'?'final':null;
 const outputs=planning!.output_contracts.filter((_,i)=>!stage||i!==planning!.output_contracts.length-1);
 return <section className="game-core-workflow"><h3>{stage==='planning'?'Подтверждение постановки':'Ваше действие'}</h3>{!available&&<p>Действие ждёт предыдущий Ход и необходимые результаты.</p>}{outputs.map(output=><label key={output.key}>{output.name}<textarea rows={4} maxLength={16000} required value={values[output.key]??''} onChange={e=>setValues(old=>({...old,[output.key]:e.target.value}))}/></label>)}{stage&&<label>{stage==='planning'?'Решение и обоснование':'Результат рассмотрения и обоснование'}<textarea rows={4} required maxLength={16000} value={comment} onChange={e=>setComment(e.target.value)}/></label>}<div className="game-core-workflow-buttons"><button disabled={!available||busy||Boolean(stage&&!comment.trim())||outputs.some(o=>!values[o.key]?.trim())} onClick={()=>void submit(stage==='planning'?'approved':stage==='final'?'success':'done')}>{busy?'Сохраняем…':stage==='planning'?'Подтвердить постановку':stage==='final'?'Принять итог':'Сохранить результат'}</button>{stage&&<button disabled={!available||busy||!comment.trim()} onClick={()=>void submit('changes')}>Есть замечания</button>}</div>{error&&<p role="alert">{error}</p>}</section>;
}
