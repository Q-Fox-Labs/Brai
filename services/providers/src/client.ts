// ABOUTME: Даёт доверенному caller owner-scoped NATS API без копирования DTO.
// ABOUTME: Подписывается до invoke; потерянный поток восстанавливает только через get.
import {randomUUID} from 'node:crypto';
import type {NatsConnection,Subscription} from 'nats';
import {Failure} from './core.js';
import {boundedJson} from './json.js';
import type {Operations,DecideRequest} from './operations.js';
import type {ImageRequest} from './image.js';
import type {ChatRequest,StreamEvent} from './chat.js';
import {v1Validator} from './v1-schema.js';
export type OperationView=Awaited<ReturnType<Operations['get']>>;
export type ChatInput=Omit<ChatRequest,'ownerId'|'connectionId'|'streamInbox'>;
const operationValid=v1Validator('operation'),eventValid=v1Validator('streamEvent'),errorValid=v1Validator('error');
const keyValid=v1Validator('operationKey');
/** Создаёт клиент для доверенного scope; полномочия owner обеспечивает NATS ACL, не эти параметры. */
export function createProvidersClient(nc:NatsConnection,scope:{ownerId:string;connectionId:string;inboxPrefix?:string}) {
  scope={...scope};
  const prefix=scope.inboxPrefix??'_INBOX.';
  if(!/^[a-zA-Z0-9_-]{1,64}$/.test(scope.connectionId)||!/^_INBOX[.](?:[a-zA-Z0-9_-]{1,64}[.]){0,2}$/.test(prefix)||!keyValid({ownerId:scope.ownerId,operationId:randomUUID()}))throw new Failure('INVALID_REQUEST','not_sent');
  let active=0;
  async function request(subject:string,input:unknown):Promise<OperationView>{
    let message;
    try{message=await nc.request('brai.providers.v1.'+subject,JSON.stringify(input),{timeout:3000});}
    catch{throw new Failure('TRANSPORT_UNAVAILABLE','unknown');}
    if(message.data.byteLength>73728)throw new Failure('UPSTREAM_PROTOCOL','unknown');
    let value:unknown;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(message.data));}catch{throw new Failure('UPSTREAM_PROTOCOL','unknown');}
    if(message.headers?.get('Nats-Service-Error')){
      if(errorValid(value)){const safe=value as {code:string;outcome:'not_sent'|'failed'|'unknown'};throw new Failure(safe.code,safe.outcome);}
      throw new Failure('UPSTREAM_PROTOCOL','unknown');
    }
    if(!boundedJson(value)||!operationValid(value)||(value as OperationView).ownerId!==scope.ownerId||(value as OperationView).operationId!==(input as {operationId:string}).operationId)throw new Failure('UPSTREAM_PROTOCOL','unknown');
    return value as OperationView;
  }
  const get=(operationId:string)=>{if(!keyValid({ownerId:scope.ownerId,operationId}))throw new Failure('INVALID_REQUEST','not_sent');return request('operations.get',{ownerId:scope.ownerId,operationId});};
  return {
    /** Читает только durable итог своего owner; никогда не повторяет compute. */
    get,
    /** Запрашивает отмену; после dispatch прекращение списания не обещано. */
    cancel:(operationId:string)=>{if(!keyValid({ownerId:scope.ownerId,operationId}))throw new Failure('INVALID_REQUEST','not_sent');return request('operations.cancel',{ownerId:scope.ownerId,operationId});},
    /** Принимает один decide; возвращает operation view, завершение читается get. */
    invoke:(input:Omit<DecideRequest,'ownerId'>)=>request('invoke.decide',{...input,ownerId:scope.ownerId}),
    /** Принимает один image; сохранение и recovery принадлежат существующему ядру. */
    invokeImage:(input:Omit<ImageRequest,'ownerId'>)=>request('invoke.image',{...input,ownerId:scope.ownerId}),
    /** Один invoke, до четырёх одновременных ожиданий. Gap/error/timeout отключает live callback, итог читается get; потеря самого NATS требует get с новой connection. */
    async chat(input:ChatInput,onEvent?:(event:StreamEvent)=>void,options:{signal?:AbortSignal}={}):Promise<OperationView>{
      if(active>=4)throw new Failure('OVERLOADED','not_sent');
      const streamInbox=prefix+scope.connectionId+'.'+randomUUID().replaceAll('-','');
      let sequence=0,live=true;
      let sub:Subscription;
      try{sub=nc.subscribe(streamInbox,{callback:(error,message)=>{
        if(!live)return;
        try{
          if(error||message.data.byteLength>32768)throw Error();
          const event=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(message.data));
          if(!eventValid(event))throw Error();
          const validEvent=event as StreamEvent;
          if(validEvent.operationId!==input.operationId||validEvent.sequence!==sequence+1)throw Error();
          sequence=validEvent.sequence;
          if(validEvent.type==='error'){live=false;return;}
          onEvent?.(validEvent);if(validEvent.type==='completed')live=false;
        }catch{live=false;}
      }});}catch{throw new Failure('TRANSPORT_UNAVAILABLE','not_sent');}
      active++;
      try{
        if(options.signal?.aborted)throw new Failure('CANCELLED','not_sent');
        try{await nc.flush();}catch{throw new Failure('TRANSPORT_UNAVAILABLE','not_sent');}
        let op:OperationView;
        try{op=await request('invoke.chat',{...input,ownerId:scope.ownerId,connectionId:scope.connectionId,streamInbox});}
        catch(error){
          if(!(error instanceof Failure)||error.code!=='TRANSPORT_UNAVAILABLE')throw error;
          try{op=await get(input.operationId);}catch{throw error;}
        }
        const until=Date.now()+95000;
        while(op.phase==='accepted'||op.phase==='dispatching'){
          if(options.signal?.aborted||Date.now()>=until)throw new Failure('RESULT_PENDING','unknown');
          await new Promise(resolve=>setTimeout(resolve,100));
          op=await get(input.operationId);
        }
        return op;
      }finally{live=false;sub.unsubscribe();active--;}
    }
  };
}
