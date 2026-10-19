// ABOUTME: Отправляет только разрешённые факты lifecycle в History и Alerts.
// ABOUTME: Ограниченный observer не вызывает модель и не участвует в её исходе.
import { createHash } from "node:crypto";
import type { NatsConnection } from "nats";
import type { Operation, Json } from "./operations.js";
import { getModel } from "./catalog.js";

export const OBSERVATION_LIMITS=Object.freeze({batch:8,historyActive:8,timeoutMs:1000,pollMs:5000,outboxRows:128,episodeRows:256,ttlMs:86400000,episodeTtlMs:7*86400000});
export type Dependency="unknown"|"ready"|"unavailable";
export type SafeFact={id:string;type_id:number;occurred_at:string;actor_id:null;scope_type:"user";scope_id:string;object_type:"provider_operation";object_id:string;data:{phase:string;provider:string;model:string;durationMs:number;errorClass:string|null;usage:Record<string,number>|null;cost:null}};
export type Alert={id:string;service_id:"service_providers";type_id:1;scope_type:"user";scope_id:string;title:string;text:string;data:SafeFact["data"];occurred_at:string};
export type ObservationBatch={facts:SafeFact[];dropped:number;expired:number;outboxSize:number;episodes:number};
export interface ObservationStore {
  collectObservations(now:number):Promise<ObservationBatch>;
  pendingAlerts(now:number):Promise<Alert[]>;
  ackAlert(id:string):Promise<void>;
}
function uuid(text:string){const h=createHash("sha256").update(text).digest("hex");return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;}
/** Один стабильный ID для неизменяемой фазы; входы, tools, outputs и upstream body не читаются. */
export function safeFact(op:Pick<Operation,'ownerId'|'operationId'|'createdAt'|'finishedAt'|'phase'|'route'|'errorCode'|'result'>):SafeFact {
  const card=getModel(op.route.provider,op.route.model);
  const raw=(op.result&&typeof op.result==='object'&&!Array.isArray(op.result)?op.result.usage:null) as Record<string,Json>|null;
  const usage:Record<string,number>={};
  for(const [key,aliases] of Object.entries({inputTokens:['inputTokens','input_tokens','prompt_tokens'],outputTokens:['outputTokens','output_tokens','completion_tokens'],totalTokens:['totalTokens','total_tokens']})){
    for(const alias of aliases){const value=raw?.[alias];if(typeof value==='number'&&Number.isSafeInteger(value)&&value>=0){usage[key]=value;break;}}
  }
  const error=op.errorCode;
  const errorClass=error===null?null:error==='CANCELLED'?'cancelled':error.startsWith('OUTPUT_')?'output':error==='UPSTREAM_PROTOCOL'?'protocol':error==='DEADLINE_EXCEEDED'?'deadline':error==='UPSTREAM_UNAVAILABLE'?'unavailable':'unknown';
  return {id:uuid(JSON.stringify([op.ownerId,op.operationId,op.createdAt,op.phase])),type_id:op.phase==='cancelled'?1202:1201,occurred_at:new Date(op.finishedAt??op.createdAt).toISOString(),actor_id:null,scope_type:'user',scope_id:op.ownerId,object_type:'provider_operation',object_id:op.operationId,data:{phase:op.phase,provider:card?.provider??'unknown',model:card?.model??'unknown',durationMs:Math.max(0,Math.min(7*86400000,(op.finishedAt??op.createdAt)-op.createdAt)),errorClass,usage:Object.keys(usage).length?usage:null,cost:null}};
}
/** Оповещает только об отказе ранее принятой работы. Успех закрывает тот же episode без сообщения. */
export function alertFor(fact:SafeFact):Alert|null {
  if(!['failed','outcome_unknown','output_pending'].includes(fact.data.phase))return null;
  return {id:fact.id,service_id:'service_providers',type_id:1,scope_type:'user',scope_id:fact.scope_id,title:'Не удалось завершить операцию модели',text:'Операция завершилась с ошибкой или её результат пока не сохранён. Проверьте состояние операции. Повторное вычисление не запускалось.',data:fact.data,occurred_at:fact.occurred_at};
}
/** Best-effort request Core NATS: нет очереди и retry, ошибка ответа не раскрывается. */
export function historySender(nc:Pick<NatsConnection,'request'|'isClosed'>){
  let active=0;
  const metrics={sent:0,dropped:0,failed:0};let dependency:Dependency='unknown';
  return {
    send(fact:SafeFact){
      if(active>=OBSERVATION_LIMITS.historyActive||nc.isClosed()){metrics.dropped++;dependency='unavailable';return;}
      active++;
      void nc.request('brai.history.v1.append.service_providers',JSON.stringify(fact),{timeout:OBSERVATION_LIMITS.timeoutMs}).then(reply=>{if(reply.headers?.get('Nats-Service-Error'))throw Error('HISTORY_REJECTED');metrics.sent++;dependency='ready';},()=>{metrics.failed++;dependency='unavailable';}).catch(()=>{metrics.failed++;dependency='unavailable';}).finally(()=>{active--;});
    },
    status(){return {state:dependency,active,...metrics};}
  };
}
/** PG batches и JS PubAck независимы от model/admission; один pump без накопления promises. */
export function createObservation(store:ObservationStore,history:ReturnType<typeof historySender>,publish:(event:Alert)=>Promise<unknown>,connected:()=>boolean=()=>true){
  let busy=false,stopped=false,storage:Dependency='unknown',alerts:Dependency='unknown';
  const metrics={outboxDropped:0,outboxExpired:0,published:0,publishFailed:0,storageFailed:0,outboxSize:0,episodes:0};
  return {
    async tick(now=Date.now()){
      if(busy||stopped)return;busy=true;
      try{
        const batch=await store.collectObservations(now);storage='ready';metrics.outboxDropped+=batch.dropped;metrics.outboxExpired+=batch.expired;metrics.outboxSize=batch.outboxSize;metrics.episodes=batch.episodes;
        batch.facts.forEach(f=>history.send(f));
        for(const event of await store.pendingAlerts(now)){
          try{await publish(event);alerts='ready';metrics.published++;}catch{alerts='unavailable';metrics.publishFailed++;break;}
          // AIDEV-NOTE: Lost PubAck/DELETE response оставляет те же bytes/ID для следующей доставки.
          await store.ackAlert(event.id);metrics.outboxSize=Math.max(0,metrics.outboxSize-1);
        }
      }catch{storage='unavailable';metrics.storageFailed++;}finally{busy=false;}
    },
    stop(){stopped=true;},
    status(){return {dependencies:{nats:connected()?'ready':'unavailable',storage,litellm:'unknown',modelProbe:'disabled',history:history.status().state,alerts},metrics:{...metrics,history:history.status()}};}
  };
}
