// ABOUTME: Держит один engine-проход в процессе независимо от кратких status Activities.
// ABOUTME: PG guard, native WS и checkpoint остаются у engine до завершения или управляемой остановки.
export interface AdvanceResult {terminal:boolean;wait_ms:number;code:string}
interface Engine {advance(id:string):Promise<AdvanceResult>;requestStopOwned():Promise<{ids:string[];unknown:boolean}>}
export function verificationProcess(engine:Engine){
 let stopping=false,flight:{id:string;done:Promise<AdvanceResult>}|null=null,last:{id:string;result:AdvanceResult}|null=null,stopPromise:Promise<void>|undefined;
 const pending=(code:string):AdvanceResult=>({terminal:false,wait_ms:1000,code});
 return {
  get stopping(){return stopping;},
  async advance(id:string):Promise<AdvanceResult>{
   if(stopping)return pending("WORKER_STOPPING");
   if(last?.id===id){const result=last.result;last=null;return result;}
   if(flight)return pending(flight.id===id?"ENGINE_PENDING":"BUSY");
   last=null;
   const task={id,done:Promise.resolve().then(()=>engine.advance(id)).catch(()=>pending("ENGINE_UNAVAILABLE"))};flight=task;
   void task.done.then(result=>{if(flight===task){last={id,result};flight=null;}});
   return pending("ENGINE_PENDING");
  },
  stop():Promise<void>{
   if(stopPromise)return stopPromise;
   stopping=true;const done=flight?.done;
   stopPromise=(async()=>{
    const stops=await engine.requestStopOwned().catch(()=>({ids:[],unknown:true}));
    await done;
    const cleanup:PromiseSettledResult<AdvanceResult>[]=[];
    for(const id of stops.ids){try{cleanup.push({status:"fulfilled",value:await engine.advance(id)});}catch(reason){cleanup.push({status:"rejected",reason});}}
    if(stops.unknown||cleanup.some(r=>r.status==="rejected"||["WORKER_STOP_UNKNOWN","BUSY"].includes(r.value.code)))throw Error("VERIFICATION_STOP_UNKNOWN");
   })();
   return stopPromise;
  }
 };
}
/** Закрывает каждый транспорт даже при отказе worker или cleanup; успех не подделывается. */
export async function shutdownVerification(running:Promise<unknown>,execution:Promise<unknown>,close:(()=>Promise<unknown>)[]){
 const outcomes=await Promise.allSettled([running,execution]);
 const closed=await Promise.allSettled(close.map(fn=>Promise.resolve().then(fn)));
 if([...outcomes,...closed].some(r=>r.status==="rejected"))throw Error("VERIFICATION_STOP_UNKNOWN");
}
