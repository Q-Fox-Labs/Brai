// ABOUTME: Ограничивает совместную нагрузку MCP и NATS конечной очередью.
// ABOUTME: Тайм-аут ответа не освобождает слот до фактического завершения работы.
import {Fault} from "./contracts.js";
export interface WorkContext {deadlineAt:number;signal:AbortSignal}
/** Создаёт FIFO admission gate; drain ожидает реальные операции, а не ответы. */
export function createGate(activeLimit=8,queueLimit=16,deadlineMs=10000){
 let active=0,accepting=true;
 const metrics={busy:0,deadlineExceeded:0};
 const queue:Array<()=>void>=[],idle:Array<()=>void>=[];
 const pump=()=>{while(active<activeLimit&&queue.length)queue.shift()!();if(!active&&!queue.length)idle.splice(0).forEach(f=>f());};
 return {
  metrics,
  run<T>(work:(context:WorkContext)=>Promise<T>,mutation=false):Promise<T>{
   if(!accepting||active>=activeLimit&&queue.length>=queueLimit){metrics.busy++;return Promise.reject(new Fault("BUSY"));}
   const deadlineAt=Date.now()+deadlineMs,controller=new AbortController();
   return new Promise((resolve,reject)=>{
    let started=false,settled=false;
    const start=()=>{
     if(settled)return;
     started=true;active++;
     void Promise.resolve().then(()=>work({deadlineAt,signal:controller.signal})).then(
      value=>{if(!settled){settled=true;resolve(value);}},
      error=>{if(!settled){settled=true;reject(error);}},
     ).finally(()=>{clearTimeout(timer);active--;pump();});
    };
    const timer=setTimeout(()=>{
     if(settled)return;settled=true;metrics.deadlineExceeded++;controller.abort();
     if(!started){const i=queue.indexOf(start);if(i>=0)queue.splice(i,1);pump();}
     reject(new Fault("DEADLINE_EXCEEDED",started&&mutation?"unknown":"not_accepted"));
    },deadlineMs);
    if(active<activeLimit)start();else queue.push(start);
   });
  },
  stop(){accepting=false;},
  drain(){return !active&&!queue.length?Promise.resolve():new Promise<void>(resolve=>idle.push(resolve));},
 };
}
